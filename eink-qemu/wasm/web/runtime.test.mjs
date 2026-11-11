import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

async function boot(machine, panel, turbo = false, wifi = false) {
    const listeners = {}, scripts = [];
    const window = {addEventListener: (name, fn) => { listeners[name] = fn; }};
    const parent = {location: {search: ''}, postMessage() {}};
    const context = vm.createContext({window, parent, TextDecoder, URLSearchParams, clearTimeout() {}, clearInterval() {},
        location: {origin: 'http://localhost'},
        document: {querySelector: () => ({}), addEventListener() {},
            createElement: () => ({}), body: {append: script => scripts.push(script.src)}}});
    vm.runInContext(readFileSync(new URL('./runtime.js', import.meta.url), 'utf8'), context);
    await listeners.message({source: parent, origin: 'http://localhost',
        data: {type: 'boot', machine, panel, turbo, wifi}});
    return {args: Array.from(window.Module.arguments), scripts};
}

test('panel selection reaches QEMU without changing CPU or input machine', async () => {
    for (const machine of ['x3', 'x4', 'x4pro', 'x4classic', 'picco']) {
        for (const panel of [undefined, 'uc8179', 'uc8279-68', ...(machine === 'x4classic' ? ['ssd1677'] : [])]) {
            const {args, scripts} = await boot(machine, panel);
            const expected = machine === 'x4pro' || machine === 'x4classic' ? `${machine},panel=${panel || 'uc8279-68'}` : machine;
            assert.equal(args[args.indexOf('-machine') + 1], expected);
            assert.ok(args.includes(`shift=${machine === 'picco' ? 2 : 0},sleep=on`));
            assert.equal(scripts[0], `qemu-system-${['x3', 'x4'].includes(machine) ? 'riscv32' : 'xtensa'}.js`);
        }
    }
});

test('turbo overrides measured panel power and refresh waits', async () => {
    const {args} = await boot('x4pro', 'uc8279-68', true);
    assert.ok(args.includes('dwc_sdmmc.timing=off'));
    for (const name of ['pon-ms', 'pof-ms', 'busy-ms']) assert.ok(args.includes(`uc8179.${name}=1`));
});

test('new pixels on the canvas tell the page; repaints and blank frames do not', async () => {
    const sent = [], timers = [], canvas = {};
    class CanvasRenderingContext2D { putImageData() {} }
    const context = vm.createContext({window: {addEventListener() {}}, TextDecoder, TextEncoder, URLSearchParams,
        parent: {location: {search: ''}, postMessage: message => sent.push(message.type === 'screen' ? `screen:${message.blank ? 'blank' : 'drawn'}` : message.type)},
        location: {origin: 'http://localhost'}, CanvasRenderingContext2D, Uint32Array,
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: id => { if (id) timers[id - 1] = () => {}; },
        document: {querySelector: () => canvas, addEventListener() {}, createElement: () => ({}), body: {append() {}}}});
    vm.runInContext(readFileSync(new URL('./runtime.js', import.meta.url), 'utf8'), context);
    const ctx = Object.assign(new CanvasRenderingContext2D(), {canvas});
    const frame = (fill, ink = fill) => { const data = new Uint8ClampedArray(64).fill(fill); data.fill(ink, 0, 4); return {data}; };
    const flush = () => timers.splice(0).forEach(fn => fn());
    const screens = () => sent.filter(type => type === 'screen:drawn').length;
    ctx.putImageData(frame(255), 0, 0); flush();
    assert.equal(screens(), 0, 'the blank panel before the firmware draws');
    ctx.putImageData(frame(255, 0), 0, 0); flush();
    ctx.putImageData(frame(255, 0), 0, 0); flush();
    assert.equal(screens(), 1);
    // Another canvas is not the panel.
    CanvasRenderingContext2D.prototype.putImageData.call({canvas: {}}, frame(255, 7), 0, 0); flush();
    ctx.putImageData(frame(0), 0, 0); flush();
    ctx.putImageData(frame(255, 9), 0, 0); flush();
    assert.equal(screens(), 2);
    // A blank frame is said at once and cancels a drawn notice still pending.
    sent.length = 0;
    ctx.putImageData(frame(255, 1), 0, 0);
    ctx.putImageData(frame(0), 0, 0); flush();
    assert.deepEqual(sent.filter(t => t.startsWith('screen')), ['screen:blank']);
    // A new boot forgets the last frame: its first draw counts even when it
    // repeats the last boot's image.
    ctx.putImageData(frame(255, 5), 0, 0); flush();
    const drawn = screens();
    ctx.putImageData(frame(255, 5), 0, 0); flush();
    assert.equal(screens(), drawn);
    context.output('ESP-ROM:esp32s3-20210327');
    ctx.putImageData(frame(255, 5), 0, 0); flush();
    assert.equal(screens(), drawn + 1);
});

test('turbo SPI card timings go only to the boards with an SPI card', async () => {
    for (const machine of ['x3', 'x4', 'x4pro', 'x4classic', 'picco']) {
        const {args} = await boot(machine, undefined, true);
        assert.equal(args.includes('ssi-sd.read-access-us=0'), machine === 'x3' || machine === 'x4', machine);
    }
});

test('Wi-Fi off keeps the radio with no access points', async () => {
    const {args} = await boot('x3', undefined, false, false);
    assert.equal(args[args.indexOf('-nic') + 1], 'hubport,hubid=0,model=esp32_wifi');
    assert.ok(args.includes('esp32_wifi.access-points=off'));
});

test('X4 Classic SSD1677 selection does not receive UC8179 ghosting globals', async () => {
    const {args} = await boot('x4classic', 'ssd1677', true);
    assert.equal(args[args.indexOf('-machine') + 1], 'x4classic,panel=ssd1677');
    assert.ok(!args.some(arg => arg.startsWith('uc8179.ghosting=')));
    assert.ok(!args.some(arg => arg.startsWith('ssd1677.ghosting=')));
});

test('heap memory requests reject invalid or oversized ranges before pausing QEMU', async () => {
    const listeners = {}, sent = [];
    const parent = {location: {search: ''}, postMessage: message => sent.push(message)};
    const context = vm.createContext({window: {addEventListener: (name, fn) => { listeners[name] = fn; }},
        parent, TextDecoder, URLSearchParams, location: {origin: 'http://localhost'},
        document: {querySelector: () => ({}), addEventListener() {}, createElement: () => ({}), body: {append() {}}}});
    vm.runInContext(readFileSync(new URL('./runtime.js', import.meta.url), 'utf8'), context);
    await listeners.message({source: parent, origin: 'http://localhost', data: {type: 'heap-read', id: 7, addr: 0x3fc80000, size: 32 * 1024 * 1024 + 1}});
    await listeners.message({source: parent, origin: 'http://localhost', data: {type: 'heap-read', id: 8, addr: -1, size: 16}});
    assert.deepEqual(sent.filter(message => message.type === 'heap-read-result').map(message => [message.id, message.ok, message.error.code]), [
        [7, false, 'EINVAL'], [8, false, 'EINVAL'],
    ]);
});


test('empty pause queue is a no-op after the last paused action', () => {
    const source = readFileSync(new URL('./runtime.js', import.meta.url), 'utf8') +
        '\nglobalThis.__testNextPause = nextPause;';
    const context = vm.createContext({window: {addEventListener() {}}, TextDecoder, TextEncoder, URLSearchParams,
        parent: {location: {search: ''}, postMessage() {}}, location: {origin: 'http://localhost'},
        document: {querySelector: () => ({}), addEventListener() {}, createElement: () => ({}), body: {append() {}}}});
    vm.runInContext(source, context);
    assert.doesNotThrow(() => context.__testNextPause());
});


test('heap reads quote an absolute MEMFS path and use virtual memsave', () => {
    const source = readFileSync(new URL('./runtime.js', import.meta.url), 'utf8') +
        '\nglobalThis.__testHeapRead = heapRead; globalThis.__testMonitorLine = monitorLine; globalThis.__testMonitorInput = monitorInput;';
    const context = vm.createContext({window: {addEventListener() {}}, TextDecoder, TextEncoder, URLSearchParams,
        parent: {location: {search: ''}, postMessage() {}}, location: {origin: 'http://localhost'},
        document: {querySelector: () => ({}), addEventListener() {}, createElement: () => ({}), body: {append() {}}}});
    context.Module = {FS: {lookupPath: () => ({node: {}})}};
    vm.runInContext(source, context);
    context.__testHeapRead({id: 42, addr: 0x3fc88000, size: 128});
    context.__testMonitorInput.length = 0;
    // The pause acknowledgment executes the heap-read action and queues memsave.
    context.__testMonitorLine('VM status: paused');
    const commands = new TextDecoder().decode(Uint8Array.from(context.__testMonitorInput));
    assert.match(commands, /memsave 0x3fc88000 128 \"\/heap-read-42\.bin\"/);
    assert.doesNotMatch(commands, /pmemsave/);
});

test('a pending Stop is released after an active Heap transaction ends', () => {
    const source = readFileSync(new URL('./runtime.js', import.meta.url), 'utf8') +
        '\nglobalThis.__testHeapBegin = heapBegin; globalThis.__testHeapEnd = heapEnd; globalThis.__testSnapshot = snapshot; globalThis.__testMonitorLine = monitorLine;';
    const sent = [], context = vm.createContext({window: {addEventListener() {}}, TextDecoder, TextEncoder, URLSearchParams,
        parent: {location: {search: ''}, postMessage: message => sent.push(message)}, location: {origin: 'http://localhost'},
        document: {querySelector: () => ({}), addEventListener() {}, createElement: () => ({}), body: {append() {}}}});
    const fs = {lookupPath: () => ({node: {notifyListeners() {}}}), readFile: () => new Uint8Array([1, 2, 3]), unlink() {}};
    context.Module = {FS: fs};
    vm.runInContext(source, context);
    context.__testHeapBegin({id: 1});
    context.__testMonitorLine('VM status: paused');
    context.__testSnapshot('stop');
    context.__testHeapEnd({id: 2});
    context.__testMonitorLine('VM status: paused');
    context.__testMonitorLine('VM status: paused');
    assert.ok(sent.some(message => message.type === 'heap-control-result' && message.id === 2 && message.ok));
    assert.ok(sent.some(message => message.type === 'snapshot' && message.action === 'stop'));
});

test('browser backend permits heap-end while a Stop request is pending', () => {
    const source = readFileSync(new URL('../../desktop/src/backend-browser.ts', import.meta.url), 'utf8');
    assert.match(source, /type === 'heap-end' && session\.state === 'stopping'/);
});


test('Heap reads retain QEMU monitor diagnostics for failed memory dumps', () => {
    const source = readFileSync(new URL('./runtime.js', import.meta.url), 'utf8') +
        '\nglobalThis.__testMonitorLine = monitorLine; globalThis.__setHeapOutput = value => heapReadMonitorOutput = value; globalThis.__getHeapOutput = () => heapReadMonitorOutput;';
    const context = vm.createContext({window: {addEventListener() {}}, TextDecoder, TextEncoder, URLSearchParams,
        parent: {location: {search: ''}, postMessage() {}}, location: {origin: 'http://localhost'},
        document: {querySelector: () => ({}), addEventListener() {}, createElement: () => ({}), body: {append() {}}}});
    vm.runInContext(source, context);
    context.__setHeapOutput([]);
    context.__getHeapOutput().push('memsave: cannot access guest address');
    context.__testMonitorLine('VM status: paused');
    assert.deepEqual(Array.from(context.__getHeapOutput()), ['memsave: cannot access guest address']);
});
