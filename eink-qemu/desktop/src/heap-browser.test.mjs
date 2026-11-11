import assert from 'node:assert/strict';
import { BrowserHeapReader } from './heap-browser.ts';

const DRAM = 0x3fc88000, START = 0x3fc90000, END = 0x3fc91000, MEM_END = 0x3fd00000, NODE = DRAM + 0x100;
const memory = new Uint8Array(MEM_END - DRAM);
const put = (addr, words) => {
  const view = new DataView(memory.buffer);
  words.forEach((word, index) => view.setUint32(addr - DRAM + index * 4, word >>> 0, true));
};
const control = 36 + 4 * 8 * 9;
const heapData = START + 20;
const sizes = [64, 128, 32, 16];
const used = sizes.reduce((sum, size) => sum + size + 4, 0);
const rest = (END - (START + 20 + control - 4) - 8 - used - 4) & ~3;
const blockSizes = [...sizes, rest];
const freeFlags = [false, true, false, false, true];
const freeBytes = blockSizes.reduce((sum, size, i) => sum + (freeFlags[i] ? size : 0), 0);

// A registered_heaps SLIST node, followed by one 4 KiB DRAM heap.
put(NODE, [0x1802, 0x100000, 0, START, END, 0xb33fffff, 0, START, 0]);
put(START, [0, freeBytes, freeBytes - 64, END - START - 20, heapData]);
const fl = 8, log2 = 3, sl = 1 << log2, shift = log2 + 2;
const params = fl | (shift << 5) | ((fl + shift - 1) << 8) | (sl << 14) | (log2 << 20) | ((1 << shift) << 23);
put(heapData + 16, [params, control, 0, heapData + 36, heapData + 36 + 4 * fl]);
for (let addr = heapData + 36 + 4 * fl; addr < heapData + control; addr += 4) put(addr, [heapData]);
let block = heapData + control - 4, previousFree = 0;
for (let i = 0; i < blockSizes.length; i++) {
  put(block + 4, [blockSizes[i] | (freeFlags[i] ? 1 : 0) | (previousFree << 1)]);
  previousFree = freeFlags[i] ? 1 : 0;
  block += blockSizes[i] + 4;
}
put(block + 4, [previousFree << 1]); // TLSF sentinel

const read = async (addr, size) => {
  assert.ok(addr >= DRAM && addr + size <= MEM_END, `out-of-range guest read 0x${addr.toString(16)}+${size}`);
  return memory.slice(addr - DRAM, addr - DRAM + size);
};
let began = 0, ended = 0;
const reader = new BrowserHeapReader(read, () => 'x4classic', async () => { began++; }, async () => { ended++; });
const snapshot = await reader.snapshot();
assert.equal(snapshot.heaps.length, 1);
assert.equal(snapshot.missing, 0);
const heap = snapshot.heaps[0];
assert.equal(heap.name, 'DRAM');
assert.equal(heap.count, 5);
assert.equal(heap.used, 64 + 32 + 16);
assert.equal(heap.free, 128 + rest);
assert.equal(heap.nfree, 2);
assert.equal(heap.largest, rest);
assert.equal(heap.blocks.length, 20);
assert.equal(reader.history().length, 1);
assert.equal(began, 1);
assert.equal(ended, 1);
assert.equal(reader.at(snapshot.time).snapshot, snapshot);
console.log('heap-browser: ELF-free list scan and TLSF walk passed');
let failedEnd = 0;
const failingReader = new BrowserHeapReader(async () => { throw new Error('synthetic read failure'); }, () => 'x4classic', async () => {}, async () => { failedEnd++; });
await assert.rejects(failingReader.snapshot(), /synthetic read failure/);
assert.equal(failedEnd, 1, 'guest must always be resumed after a failed snapshot');
console.log('heap-browser: guest resume on read failure passed');
