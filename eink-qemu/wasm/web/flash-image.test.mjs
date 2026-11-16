// node --test eink-qemu/wasm/web/flash-image.test.mjs
import assert from 'node:assert/strict';
import {test} from 'node:test';
import './flash-image.js';

function merged(chip = 9) {
    const data = new Uint8Array(0x10100).fill(0xff), view = new DataView(data.buffer);
    for (const offset of [0, 0x10000]) {
        data[offset] = 0xe9; view.setUint16(offset + 12, chip, true);
    }
    view.setUint16(0x8000, 0x50aa, true); data[0x8002] = 0;
    view.setUint32(0x8004, 0x10000, true); view.setUint32(0x8008, 0x7e0000, true);
    data[0x9000] = 42;
    return data;
}
test('merged C3 and S3 images preserve all bytes and gain an erased tail', () => {
    for (const chip of [5, 9]) {
        const input = merged(chip), flash = FlashImage.expandMerged(input);
        assert.equal(flash.length, 0x1000000);
        assert.deepEqual(flash.subarray(0, input.length), input);
        assert.ok(flash.subarray(input.length).every(byte => byte === 255));
    }
});
test('ordinary app images are not identified as merged', () => {
    const data = merged(); data[0x8000] = 0;
    assert.equal(FlashImage.expandMerged(data), null);
    assert.equal(FlashImage.expandMerged(new Uint8Array(24)), null);
});
test('rejects missing applications, wrong chips and truncated tables', () => {
    const data = merged(); data[0x10000] = 0xff;
    assert.throws(() => FlashImage.expandMerged(data), /application/);
    data[0x10000] = 0xe9; data[0x1000c] = 5;
    assert.throws(() => FlashImage.expandMerged(data), /application/);
    assert.throws(() => FlashImage.expandMerged(data.subarray(0, 0x8010)), /Truncated/);
});
test('rejects overlapping and out-of-range partitions', () => {
    const data = merged(), view = new DataView(data.buffer);
    data.set(data.subarray(0x8000, 0x8020), 0x8020);
    assert.throws(() => FlashImage.expandMerged(data), /partition table/);
    data.fill(0xff, 0x8020, 0x8040);
    view.setUint32(0x8008, 0x1000000, true);
    assert.throws(() => FlashImage.expandMerged(data), /partition table/);
});

test('device selection defaults C3 to X3 and validates the chip', () => {
    assert.equal(FlashImage.selectMachine(9, 'auto'), 'x4pro');
    assert.equal(FlashImage.selectMachine(5, 'x3'), 'x3');
    assert.equal(FlashImage.selectMachine(5, 'x4'), 'x4');
    assert.equal(FlashImage.selectMachine(5, 'auto'), 'x3');
    assert.throws(() => FlashImage.selectMachine(9, 'x4'), /conflicts/);
    assert.throws(() => FlashImage.selectMachine(5, 'x4pro'), /conflicts/);
    assert.throws(() => FlashImage.selectMachine(261, 'x4'), /Unsupported/);
    assert.throws(() => FlashImage.selectMachine(9, 'typo'), /Unknown device/);
});

function app(chip = 9, length = 64) {
    const bytes = new Uint8Array(length).fill(0x42);
    bytes[0] = 0xe9;
    new DataView(bytes.buffer).setUint16(12, chip, true);
    return bytes;
}
function table(picco = false, x4Family = false) {
    const bytes = new Uint8Array(0xc00).fill(0xff), view = new DataView(bytes.buffer);
    const entries = picco ? [
        [1, 2, 0x9000, 0xc000], [1, 0, 0x15000, 0x2000],
        [0, 0, 0x20000, 0xc0000], [0, 0x10, 0xe0000, 0xe70000],
        [1, 0x82, 0xf50000, 0xb0000]
    ] : x4Family ? [[1, 2, 0x9000, 0x5000], [1, 0, 0xe000, 0x2000], [0, 0x10, 0x10000, 0x7e0000], [0, 0x11, 0x7f0000, 0x7e0000], [1, 0x82, 0xfd0000, 0x14000], [1, 3, 0xfe4000, 0x1c000]] : [[1, 2, 0x9000, 0x5000], [1, 0, 0xe000, 0x2000], [0, 0x10, 0x10000, 0x640000]];
    entries.forEach(([type, subtype, offset, size], i) => {
        const pos = i * 32;
        view.setUint16(pos, 0x50aa, true); bytes[pos + 2] = type; bytes[pos + 3] = subtype;
        view.setUint32(pos + 4, offset, true); view.setUint32(pos + 8, size, true);
    });
    return bytes;
}
test('Picco is an explicit S3 board with its own composition assets', () => {
    assert.equal(FlashImage.selectMachine(9, 'picco'), 'picco');
    assert.throws(() => FlashImage.selectMachine(5, 'picco'), /conflicts/);
    assert.deepEqual(FlashImage.appLayout('picco'), {
        appOffset: 0xe0000, appSize: 0xe70000, otaOffset: 0x15000,
        bootAsset: 'bootloader-esp32s3.bin', partitionAsset: 'partitions-picco.bin',
        partitionTable: 'the stock BOOX Picco partition table'
    });
    assert.equal(FlashImage.appLayout('x3').partitionTable, 'the Arduino-ESP32 16 MB partition table');
    assert.equal(FlashImage.appLayout('x4pro').appOffset, 0x10000);
    assert.throws(() => FlashImage.appLayout('unknown'), /Unknown device/);
});
test('Picco composition selects valid ota_0 and keeps app and recovery bytes intact', () => {
    const bytes = app(9, 0x640001), boot = app(), partitions = table(true);
    const flash = FlashImage.composeApp(bytes, {machine: 'picco', boot, partitions});
    assert.equal(flash.length, 0x1000000);
    assert.deepEqual(flash.subarray(0, boot.length), boot);
    assert.deepEqual(flash.subarray(0x8000, 0x8c00), partitions);
    assert.deepEqual(flash.subarray(0xe0000, 0xe0000 + bytes.length), bytes);
    assert.ok(flash.subarray(0x20000, 0xe0000).every(byte => byte === 255));
    assert.ok(flash.subarray(0x9000, 0x15000).every(byte => byte === 255));
    assert.ok(flash.subarray(0xf50000).every(byte => byte === 255));
    const view = new DataView(flash.buffer);
    assert.equal(view.getUint32(0x15000, true), 1);
    assert.equal(view.getUint32(0x15018, true), 2);
    assert.equal(view.getUint32(0x1501c, true), 0x4743989a);
    assert.ok(flash.subarray(0x15020, 0x17000).every(byte => byte === 255));
});
test('composition validates app capacity and bundled assets', () => {
    const options = {machine: 'picco', boot: app(), partitions: table(true)};
    assert.throws(() => FlashImage.composeApp(app(9, 0xe70001), options), /partition/);
    assert.throws(() => FlashImage.composeApp(app(5), options), /conflicts/);
    assert.throws(() => FlashImage.composeApp(app(), {...options, boot: app(5)}), /boot assets/);
    assert.throws(() => FlashImage.composeApp(app(), {...options, partitions: table()}), /partition/);
});
test('app composition retains existing offsets and boot selection', () => {
    const bytes = app(), options = {machine: 'x4pro', boot: app(), partitions: table(false, true)};
    const flash = FlashImage.composeApp(bytes, options);
    assert.deepEqual(flash.subarray(0x10000, 0x10000 + bytes.length), bytes);
    assert.ok(flash.subarray(0xe000, 0x10000).every(byte => byte === 255));
    const xota = FlashImage.composeApp(bytes, {...options, selectOta: true});
    assert.equal(new DataView(xota.buffer).getUint32(0xe018, true), 2);
    assert.equal(FlashImage.selectMachine(9, 'x4classic'), 'x4classic');
    const classic = FlashImage.composeApp(bytes, {machine: 'x4classic', boot: app(), partitions: table(false, true)});
    assert.deepEqual(classic.subarray(0x10000, 0x10000 + bytes.length), bytes);
    assert.equal(FlashImage.appLayout('x4classic').appSize, 0x7e0000);
    const nvs = new Uint8Array(0x5000).fill(0x37);
    const x3 = FlashImage.composeApp(app(5), {machine: 'x3', boot: app(5), partitions: table(), nvs});
    assert.deepEqual(x3.subarray(0x9000, 0xe000), nvs);
});
test('X4 Classic stock LittleFS seed is copied only into its exact partition', () => {
    const partitions = table(false, true);
    // The X4 Classic CSV uses the LittleFS subtype (0x83) for this partition.
    partitions[4 * 32 + 3] = 0x83;
    const seed = new Uint8Array(0x14000);
    for (let i = 0; i < seed.length; i++) seed[i] = (i * 17 + 3) & 0xff;
    const flash = FlashImage.composeApp(app(9), {
        machine: 'x4classic', boot: app(9), partitions, littlefs: seed,
    });
    assert.deepEqual(flash.subarray(0xfd0000, 0xfe4000), seed);
    assert.ok(flash.subarray(0xfe4000, 0x1000000).every(byte => byte === 0xff));
    assert.throws(() => FlashImage.composeApp(app(9), {
        machine: 'x4pro', boot: app(9), partitions, littlefs: seed,
    }), /partition table/);
    assert.throws(() => FlashImage.composeApp(app(9), {
        machine: 'x4classic', boot: app(9), partitions, littlefs: new Uint8Array(0x1000),
    }), /partition table/);
});

test('NVS is written only when given, and must fit the table\'s NVS partition', () => {
    const options = {machine: 'x3', boot: app(5), partitions: table()};
    const plain = FlashImage.composeApp(app(5), options);
    assert.ok(plain.subarray(0x9000, 0xe000).every(byte => byte === 255));
    assert.throws(() => FlashImage.composeApp(app(5), {...options, nvs: new Uint8Array(0x4000)}), /partition table/);
    const picco = FlashImage.composeApp(app(), {machine: 'picco', boot: app(), partitions: table(true),
        nvs: new Uint8Array(0xc000).fill(1)});
    assert.equal(picco[0x9000], 1);
});
test('C strings are found only whole, with their terminating NUL', () => {
    const bytes = new TextEncoder().encode('xx\0cphw\0dev_det\0cphwx');
    assert.ok(FlashImage.hasCStrings(bytes, ['cphw', 'dev_det']));
    assert.ok(FlashImage.hasCStrings(bytes, []));
    assert.ok(!FlashImage.hasCStrings(bytes, ['cphwx']));
    assert.ok(!FlashImage.hasCStrings(bytes, ['cphw', 'missing']));
    assert.ok(!FlashImage.hasCStrings(new Uint8Array([0x63, 0x70, 0x68, 0x77]), ['cphw']));
});
test('merged Picco images preserve a populated recovery slot and original OTA selection', () => {
    const bytes = app(), flash = FlashImage.composeApp(bytes, {
        machine: 'picco', boot: app(), partitions: table(true)
    });
    flash.fill(0xff, 0x15000, 0x17000);
    flash.set(bytes, 0x20000);
    flash[0xf50000] = 42;
    const merged = flash.subarray(0, 0xf50001), expanded = FlashImage.expandMerged(merged);
    assert.deepEqual(expanded.subarray(0, merged.length), merged);
    assert.ok(expanded.subarray(merged.length).every(byte => byte === 255));
});

test('X4 Classic dump normalization changes only LittleFS subtype and table MD5', () => {
    const flash = new Uint8Array(0x1000000).fill(0xff), view = new DataView(flash.buffer);
    // Stock X4 Classic table records from the ROM-read dump.
    const rows = [
        [1, 2, 0x9000, 0x5000, 'nvs'], [1, 0, 0xe000, 0x2000, 'otadata'],
        [0, 0x10, 0x10000, 0x7e0000, 'app0'], [0, 0x11, 0x7f0000, 0x7e0000, 'app1'],
        [1, 0x82, 0xfd0000, 0x14000, 'spiffs'], [1, 3, 0xfe4000, 0x1c000, 'coredump']
    ];
    rows.forEach(([type, subtype, offset, size, label], i) => {
        const pos = 0x8000 + i * 32;
        view.setUint16(pos, 0x50aa, true); flash[pos + 2] = type; flash[pos + 3] = subtype;
        view.setUint32(pos + 4, offset, true); view.setUint32(pos + 8, size, true);
        flash.fill(0, pos + 12, pos + 28); flash.set(new TextEncoder().encode(label), pos + 12);
    });
    const marker = 0x80c0; view.setUint16(marker, 0xebeb, true);
    flash.set(Buffer.from('cdf6c703ad3f5cfd62194feec63a1c58', 'hex'), marker + 16);
    flash[0xfd0000] = 0x6c; // A byte of filesystem payload must remain unchanged.
    const result = FlashImage.normalizeX4ClassicLittlefs(flash);
    assert.equal(result.changed, true);
    assert.equal(result.flash[0x8083], 0x83);
    assert.equal(result.flash[0xfd0000], 0x6c);
    assert.equal(flash[0x8083], 0x82, 'input buffer must not be mutated');
    assert.equal(Buffer.from(result.flash.subarray(marker + 16, marker + 32)).toString('hex'), 'f30d2781d72b1c5393ea00eb5b87289c');
    assert.equal(FlashImage.normalizeX4ClassicLittlefs(result.flash).changed, false);
});
