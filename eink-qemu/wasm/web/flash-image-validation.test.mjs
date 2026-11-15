import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import './flash-image.js';

globalThis.crypto ??= webcrypto;

async function makeEspImage(chip, {hashMismatch = false, corruptChecksum = false} = {}) {
    const payload = Uint8Array.from({length: 16}, (_, index) => index + 1);
    const image = new Uint8Array(96);
    image[0] = 0xe9;
    image[1] = 1;
    image[12] = chip & 0xff;
    image[13] = chip >>> 8;
    image[23] = 1;
    const view = new DataView(image.buffer);
    view.setUint32(24, 0x3fce0000, true);
    view.setUint32(28, payload.length, true);
    image.set(payload, 32);
    let checksum = 0xef;
    for (const byte of payload) checksum ^= byte;
    image[63] = corruptChecksum ? checksum ^ 1 : checksum;
    const digest = new Uint8Array(await awaitDigest(image.subarray(0, 64)));
    image.set(digest, 64);
    if (hashMismatch) image[64] ^= 0x80;
    return image;
}

function awaitDigest(bytes) {
    // Node and browsers both expose WebCrypto; this helper keeps image creation
    // deterministic while the tests below await the resulting Promise.
    return globalThis.crypto.subtle.digest('SHA-256', bytes);
}

async function makeFlash({bootHashMismatch = false, bootChecksumBad = false, appHashMismatch = false} = {}) {
    const flash = new Uint8Array(0x1000000).fill(0xff);
    const boot = await makeEspImage(9, {hashMismatch: bootHashMismatch, corruptChecksum: bootChecksumBad});
    const app = await makeEspImage(9, {hashMismatch: appHashMismatch});
    flash.set(boot, 0);
    const table = new DataView(flash.buffer);
    table.setUint16(0x8000, 0x50aa, true);
    table.setUint8(0x8002, 0);       // app partition
    table.setUint8(0x8003, 0x10);    // ota_0
    table.setUint32(0x8004, 0x10000, true);
    table.setUint32(0x8008, 0x7e0000, true);
    flash.set(new TextEncoder().encode('app0'), 0x800c);
    table.setUint16(0x8020, 0xebeb, true);
    flash.set(app, 0x10000);
    return flash;
}

const strictBoot = await makeEspImage(9, {hashMismatch: true});
await assert.rejects(
    FlashImage.validateEspImage(strictBoot, 'bootloader'),
    /Invalid ESP bootloader: SHA-256 mismatch\./,
);

const toleratedBoot = await makeEspImage(9, {hashMismatch: true});
const tolerated = await FlashImage.validateEspImage(toleratedBoot, 'bootloader', true);
assert.equal(tolerated.hashMismatch, true, 'bootloader hash exception must be reported');

const badChecksum = await makeEspImage(9, {hashMismatch: true, corruptChecksum: true});
await assert.rejects(
    FlashImage.validateEspImage(badChecksum, 'bootloader', true),
    /Invalid ESP bootloader: checksum mismatch\./,
    'the exception must not bypass the ESP segment checksum',
);

const dump = await makeFlash({bootHashMismatch: true});
assert.ok(FlashImage.expandMerged(dump), 'synthetic 16 MiB flash should be recognised');
assert.equal(await FlashImage.validateFlash(dump, {allowBootloaderHashMismatch: true}), true);
await assert.rejects(
    FlashImage.validateFlash(dump),
    /Invalid ESP bootloader: SHA-256 mismatch\./,
    'mismatch must remain rejected unless explicitly allowed',
);

const badApp = await makeFlash({bootHashMismatch: true, appHashMismatch: true});
await assert.rejects(
    FlashImage.validateFlash(badApp, {allowBootloaderHashMismatch: true}),
    /Invalid ESP application image: SHA-256 mismatch\./,
    'the bootloader exception must never weaken application validation',
);

const badBootChecksum = await makeFlash({bootHashMismatch: true, bootChecksumBad: true});
await assert.rejects(
    FlashImage.validateFlash(badBootChecksum, {allowBootloaderHashMismatch: true}),
    /Invalid ESP bootloader: checksum mismatch\./,
);

const originalPath = process.env.EINK_QEMU_TEST_X4CLASSIC_FLASH;
if (originalPath) {
    const original = new Uint8Array(await readFile(originalPath));
    assert.equal(original.length, 0x1000000, 'original X4 Classic dump must be 16 MiB');
    assert.ok(FlashImage.expandMerged(original), 'original X4 Classic dump must have a valid ESP partition layout');
    assert.equal(
        await FlashImage.validateFlash(original, {allowBootloaderHashMismatch: true}),
        true,
        'the supplied original X4 Classic dump should use only the bootloader hash exception',
    );
}

console.log('flash image validation: bootloader hash exception is scoped; checksums and app SHA-256 remain strict');
