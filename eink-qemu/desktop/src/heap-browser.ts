/* Browser-side ESP-IDF 5.x heap reader. Mirrors the conservative, ELF-free
   list scan and TLSF physical walk in desktop/core/src/heap.rs. */
import type { Heap, HeapHistoryPoint, HeapSnapshot } from './types';

const MAX_HEAPS = 32;
const MAX_REGION = 32 * 1024 * 1024;
const FREE = 1, POISONED = 2, CORRUPT = 4;
const HEAD_CANARY = 0xabba1234, TAIL_CANARY = 0xbaad5678;
const CAPS: [number, string][] = [[0,'EXEC'],[1,'32BIT'],[2,'8BIT'],[3,'DMA'],[10,'SPIRAM'],[11,'INTERNAL'],[12,'DEFAULT'],[13,'IRAM_8BIT'],[14,'RETENTION'],[15,'RTCRAM']];
const read32 = (v: DataView, at: number): number => v.getUint32(at, true);
interface Entry { caps: number; start: number; end: number; handle: number; next: number }
interface Block { addr: number; size: number; free: boolean }

function entryAt(bytes: Uint8Array): { entry: Entry; skip: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const skip of [0, 4]) {
    if (skip + 36 > bytes.length) continue;
    const w = (i: number) => read32(view, skip + 4 * i);
    const start = w(3), end = w(4), handle = w(7), next = w(8);
    if (start > 0 && start === handle && start < end && end - start <= MAX_REGION)
      return { entry: { caps: (w(0) | w(1) | w(2)) >>> 0, start, end, handle, next }, skip };
  }
  return null;
}

function findList(bytes: Uint8Array, base: number): number | null {
  const nodes = new Map<number, { next: number; skip: number }>();
  for (let at = 0; at + 40 <= bytes.length; at += 4) {
    const found = entryAt(bytes.subarray(at, at + 40));
    if (!found) continue;
    const { entry, skip } = found;
    if (entry.caps !== 0 && (entry.caps >>> 31) === 0 && entry.start % 4 === 0 && entry.next % 4 === 0)
      nodes.set(base + at, { next: entry.next, skip });
  }
  const pointed = new Set([...nodes.values()].map((v) => v.next));
  const heads = [...nodes.keys()].filter((n) => !pointed.has(n)).sort((a,b) => a-b);
  let best: { length: number; first: number } | null = null;
  for (const first of heads) {
    const layout = nodes.get(first)!.skip;
    let node = first, length = 0;
    const seen = new Set<number>();
    while (nodes.has(node) && !seen.has(node)) {
      seen.add(node);
      const item = nodes.get(node)!;
      length++;
      if (length > MAX_HEAPS || item.skip !== layout) { length = 0; break; }
      node = item.next;
    }
    if (node !== 0) length = 0;
    if (length && (!best || length > best.length || (length === best.length && first < best.first))) best = { length, first };
  }
  return best?.first ?? null;
}

function walkPool(mem: Uint8Array, base: number, end: number, pool: number): Block[] | null {
  let b = pool - 4, previousFree = false;
  const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
  const blocks: Block[] = [];
  for (let guard = 0; guard < 1_000_000; guard++) {
    if (b < base || b + 8 > end) return null;
    const sizeWord = read32(view, b + 4 - base);
    const size = sizeWord & ~3, free = (sizeWord & 1) !== 0, prevFree = (sizeWord & 2) !== 0;
    if (prevFree !== previousFree) return null;
    if (size === 0) return !free && end - (b + 8) < 64 ? blocks : null;
    if (size < 12) return null;
    blocks.push({ addr: b, size, free });
    previousFree = free;
    b += size + 4;
  }
  return null;
}

function findPool(mem: Uint8Array, base: number, end: number, heapData: number): { pool: number; blocks: Block[] } | null {
  if (heapData % 4 || heapData + 36 > end) return null;
  const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
  const at = heapData - base;
  if (at < 0 || at + 36 > mem.length) return null;
  const params = read32(view, at + 16);
  const fl = params & 31, shift = (params >>> 5) & 7, max = (params >>> 8) & 63;
  const sl = (params >>> 14) & 63, log2 = (params >>> 20) & 7, small = (params >>> 23) & 255;
  if (log2 < 3 || log2 > 5 || shift !== log2 + 2 || sl !== (1 << log2) || small !== (1 << shift) || fl === 0 || max > 32 || fl + shift !== max + 1) return null;
  const controlSize = 36 + 4 * fl * (1 + sl);
  const bitmap = heapData + 36, freeLists = bitmap + 4 * fl, pool = heapData + controlSize;
  if (read32(view, at + 20) !== controlSize || read32(view, at + 28) !== bitmap || read32(view, at + 32) !== freeLists || pool + 20 > end) return null;
  const blocks = walkPool(mem, base, end, pool);
  return blocks?.length ? { pool, blocks } : null;
}

function label(start: number, caps: number): string {
  if ((caps >>> 10) & 1) return 'PSRAM';
  if (((caps >>> 15) & 1) || (start >= 0x50000000 && start < 0x50002000) || (start >= 0x600fe000 && start < 0x60100000)) return 'RTC';
  if ((caps & 1) && !((caps >>> 2) & 1)) return 'IRAM';
  return 'DRAM';
}

export class BrowserHeapReader {
  private list: number | null = null;
  private pools = new Map<string, number>();
  private points: HeapSnapshot[] = [];
  private busy = false;
  private readonly read: (addr: number, size: number) => Promise<Uint8Array>;
  private readonly machine: () => string | null;
  private readonly begin: () => Promise<void>;
  private readonly end: () => Promise<void>;
  constructor(read: (addr: number, size: number) => Promise<Uint8Array>, machine: () => string | null, begin: () => Promise<void> = async () => {}, end: () => Promise<void> = async () => {}) {
    this.read = read;
    this.machine = machine;
    this.begin = begin;
    this.end = end;
  }

  async snapshot(): Promise<HeapSnapshot> {
    if (this.busy) throw Object.assign(new Error('A Heap snapshot is already being read.'), { code: 'EBUSY' });
    this.busy = true;
    const started = performance.now();
    let began = false;
    try {
      await this.begin();
      began = true;
      const machine = this.machine() ?? 'x4classic';
      const range = machine === 'x3' || machine === 'x4' ? [0x3fc80000, 0x3fce0000] : [0x3fc88000, 0x3fd00000];
      let list: Entry[] = [];
      if (this.list !== null) {
        try { list = await this.readList(this.list); } catch { this.list = null; }
      }
      if (this.list === null) {
        const dram = await this.read(range[0], range[1] - range[0]);
        this.list = findList(dram, range[0]);
        if (this.list !== null) list = await this.readList(this.list);
      }
      const heaps: Heap[] = [];
      let missing = 0;
      for (const entry of list) {
        const heap = await this.readHeap(entry);
        if (heap) heaps.push(heap); else missing++;
      }
      const time = Date.now() / 1000;
      const snapshot: HeapSnapshot = { time, heaps, missing, traced: false, traceNote: 'Allocation tracing and symbolized stacks are not available in the browser backend.', took: performance.now() - started, elf: null, elfNote: 'Heap discovery is performed by scanning ESP-IDF internal DRAM; no ELF is required.' };
      this.points.push(snapshot);
      if (this.points.length > 900) this.points.shift();
      return snapshot;
    } finally {
      try { if (began) await this.end(); } finally { this.busy = false; }
    }
  }

  history(): HeapHistoryPoint[] {
    return this.points.map((s) => ({ t: s.time, h: Object.fromEntries(s.heaps.map((h) => [h.start.toString(16), [h.free, h.largest, h.infoMinFree] as [number,number,number]])) }));
  }
  at(time: number) {
    let index = -1;
    for (let i = 0; i < this.points.length; i++) if (this.points[i].time <= time) index = i;
    if (index < 0) return null;
    return { snapshot: this.points[index], prev: index > 0 ? this.points[index - 1] : null };
  }
  reset() { this.list = null; this.pools.clear(); this.points = []; }

  private async readList(first: number): Promise<Entry[]> {
    const result: Entry[] = [];
    let node = first;
    const seen = new Set<number>();
    while (node !== 0) {
      if (result.length >= MAX_HEAPS || seen.has(node)) throw new Error('The ESP-IDF heap list is invalid or cyclic.');
      seen.add(node);
      const raw = await this.read(node, 40);
      const parsed = entryAt(raw);
      if (!parsed) throw new Error(`Heap entry at 0x${node.toString(16)} is not a valid ESP-IDF 5.x entry.`);
      result.push(parsed.entry);
      node = parsed.entry.next;
    }
    return result;
  }

  private async readHeap(h: Entry): Promise<Heap | null> {
    const size = h.end - h.start;
    if (size <= 0 || size > MAX_REGION) return null;
    const mem = await this.read(h.start, size);
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const infoAt = h.handle - h.start;
    if (infoAt < 0 || infoAt + 20 > mem.length) return null;
    const infoFree = read32(view, infoAt + 4), infoMinFree = read32(view, infoAt + 8), heapData = read32(view, infoAt + 16);
    const key = `${h.start}:${heapData}`;
    const oldPool = this.pools.get(key);
    const found = oldPool === undefined ? findPool(mem, h.start, h.end, heapData) : (() => {
      const blocks = walkPool(mem, h.start, h.end, oldPool);
      return blocks?.length ? { pool: oldPool, blocks } : null;
    })();
    if (!found) return null;
    this.pools.set(key, found.pool);
    let free = 0, used = 0, largest = 0, nfree = 0, corrupt = 0;
    const blocks: number[] = [];
    for (const block of found.blocks) {
      let flags = block.free ? FREE : 0, requested = 0;
      if (block.free) { free += block.size; largest = Math.max(largest, block.size); nfree++; }
      else {
        used += block.size;
        const off = block.addr + 8 - h.start;
        if (off + 8 <= mem.length && read32(view, off) === HEAD_CANARY) {
          const req = read32(view, off + 4);
          if (req <= block.size - 12 && off + 8 + req + 4 <= mem.length) {
            requested = req; flags |= POISONED;
            if (read32(view, off + 8 + req) !== TAIL_CANARY) { flags |= CORRUPT; corrupt++; }
          }
        }
      }
      blocks.push(block.addr + 4 - h.start, block.size + 4, flags, requested);
    }
    const last = found.blocks[found.blocks.length - 1];
    return { name: label(h.start, h.caps), caps: CAPS.filter(([bit]) => (h.caps >>> bit) & 1).map(([,name]) => name), start: h.start, end: h.end, pool: found.pool - 4 - h.start, tail: last.addr + last.size + 8 - h.start, free, used, largest, count: found.blocks.length, nfree, infoFree, infoMinFree, corrupt, blocks };
  }
}
