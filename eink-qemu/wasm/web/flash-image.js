/* Compose board-specific app images and preserve merged ESP flash images.
   App images go into a bundled partition table: Arduino-ESP32's 16 MB
   default (boot/partitions.csv) or the stock BOOX Picco layout. An NVS image
   is written only when the caller passes one (CrossPoint's, firmware.ts). */
'use strict';
globalThis.FlashImage = (() => {
    function selectMachine(chip, selected = 'auto') {
        if (chip !== 5 && chip !== 9) throw new Error(`Unsupported ESP chip ID ${chip}.`);
        const chips = {x3: 5, x4: 5, x4pro: 9, x4classic: 9, picco: 9};
        if (selected === 'auto') {
            return chip === 5 ? 'x3' : 'x4pro';
        }
        if (!Object.hasOwn(chips, selected)) throw new Error(`Unknown device: ${selected}.`);
        if (chips[selected] !== chip) throw new Error(`Device ${selected} conflicts with this ESP32-${chip === 5 ? 'C3' : 'S3'} firmware.`);
        return selected;
    }
    function appLayout(machine) {
        if (!['x3', 'x4', 'x4pro', 'x4classic', 'picco'].includes(machine)) {
            throw new Error(`Unknown device: ${machine}.`);
        }
        const picco = machine === 'picco', c3 = machine === 'x3' || machine === 'x4';
        const x4Family = machine === 'x4pro' || machine === 'x4classic';
        return Object.freeze({
            appOffset: picco ? 0xe0000 : 0x10000,
            appSize: picco ? 0xe70000 : x4Family ? 0x7e0000 : 0x640000,
            otaOffset: picco ? 0x15000 : 0xe000,
            bootAsset: `bootloader-${c3 ? 'esp32c3' : 'esp32s3'}.bin`,
            partitionAsset: picco ? 'partitions-picco.bin' : machine === 'x4classic' ? 'partitions-x4classic.bin' : machine === 'x4pro' ? 'partitions-x4pro.bin' : 'partitions.bin',
            partitionTable: picco ? 'the stock BOOX Picco partition table' : x4Family ? `the stock ${machine === 'x4classic' ? 'X4 Classic' : 'X4 Pro'} partition table` : 'the Arduino-ESP32 16 MB partition table'
        });
    }
    function readPartitions(bytes, offset = 0) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), partitions = [];
        for (let pos = offset; pos < offset + 0xc00; pos += 32) {
            const magic = view.getUint16(pos, true);
            if (magic === 0xffff || magic === 0xebeb) break;
            const address = view.getUint32(pos + 4, true), size = view.getUint32(pos + 8, true);
            if (magic !== 0x50aa || !size || address < 0x9000 || address + size > 0x1000000 ||
                partitions.some(p => address < p.offset + p.size && p.offset < address + size)) {
                throw new Error('Invalid firmware partition table.');
            }
            partitions.push({type: bytes[pos + 2], subtype: bytes[pos + 3], offset: address, size});
        }
        return partitions;
    }
    function composeApp(input, {machine, boot, partitions, nvs = null, selectOta = false}) {
        const bytes = new Uint8Array(input), layout = appLayout(machine);
        if (bytes.length < 24 || bytes[0] !== 0xe9) throw new Error('Expected an ESP application image.');
        const chip = bytes[12] | bytes[13] << 8;
        selectMachine(chip, machine);
        if (bytes.length > layout.appSize) throw new Error(`App image exceeds the ${machine} app partition (${layout.appSize} bytes).`);
        boot = new Uint8Array(boot);
        partitions = new Uint8Array(partitions);
        nvs = nvs == null ? null : new Uint8Array(nvs);
        if (boot.length < 24 || boot.length > 0x8000 || boot[0] !== 0xe9 ||
            (boot[12] | boot[13] << 8) !== chip || partitions.length !== 0xc00) {
            throw new Error('Invalid bundled boot assets. Run package-web.sh to regenerate the distribution.');
        }
        const entries = readPartitions(partitions);
        const nvsPartition = entries.find(p => p.type === 1 && p.subtype === 2);
        if (!entries.some(p => p.type === 0 && p.subtype === 0x10 &&
                p.offset === layout.appOffset && p.size === layout.appSize) ||
            !entries.some(p => p.type === 1 && p.subtype === 0 && p.offset === layout.otaOffset && p.size === 0x2000) ||
            (nvs && nvsPartition?.size !== nvs.length)) {
            throw new Error(`Bundled partition table does not match ${machine}.`);
        }
        const flash = new Uint8Array(0x1000000).fill(0xff);
        flash.set(boot, 0);
        flash.set(partitions, 0x8000);
        if (nvs) flash.set(nvs, nvsPartition.offset);
        if (machine === 'picco' || selectOta) {
            // Select valid ota_0; Picco's factory recovery slot remains erased.
            const view = new DataView(flash.buffer);
            view.setUint32(layout.otaOffset, 1, true);
            view.setUint32(layout.otaOffset + 24, 2, true);
            view.setUint32(layout.otaOffset + 28, 0x4743989a, true);
        }
        flash.set(bytes, layout.appOffset);
        return flash;
    }
    /** Validate an ESP image's header, segments and XOR checksum. App images
        require a matching appended SHA-256. Some factory-read X4 Classic
        flash dumps contain a bootloader whose appended digest does not match
        the otherwise valid image; callers may tolerate that digest mismatch
        for the bootloader only, while retaining all structural/checksum checks. */
    async function validateEspImage(bytes, label = 'application image', allowHashMismatch = false) {
        const invalid = reason => { throw new Error(`Invalid ESP ${label}: ${reason}.`); };
        if (bytes.length < 24 || bytes[0] !== 0xe9 || bytes[1] < 1 || bytes[1] > 16) {
            invalid('bad header or segment count');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 24, checksum = 0xef;
        for (let segment = 0; segment < bytes[1]; segment++) {
            if (offset + 8 > bytes.length) invalid('truncated segment header');
            const address = view.getUint32(offset, true), length = view.getUint32(offset + 4, true);
            offset += 8;
            if (length > 0x1000000 || offset + length > bytes.length || address + length > 0x100000000) {
                invalid('truncated or invalid segment length');
            }
            for (let i = offset; i < offset + length; i++) checksum ^= bytes[i];
            offset += length;
        }
        const checksumOffset = Math.floor(offset / 16) * 16 + 15;
        if (checksumOffset >= bytes.length) invalid('truncated checksum');
        if (bytes[checksumOffset] !== checksum) invalid('checksum mismatch');
        if (bytes[23] > 1) invalid('invalid appended-hash flag');
        let hashMismatch = false;
        if (bytes[23] === 1) {
            const end = checksumOffset + 1;
            if (end + 32 > bytes.length) invalid('truncated SHA-256 digest');
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(0, end)));
            hashMismatch = !digest.every((value, index) => value === bytes[end + index]);
            if (hashMismatch && !allowHashMismatch) invalid('SHA-256 mismatch');
        }
        return Object.freeze({hashMismatch});
    }

    /** Validate a merged image or full flash dump. Only the bootloader hash
        may be tolerated by an explicitly opted-in X4 Classic full-dump path;
        application hashes remain mandatory. Returns whether that exception
        was used so the UI can report it to the user. */
    async function validateFlash(bytes, {allowBootloaderHashMismatch = false} = {}) {
        const boot = await validateEspImage(bytes.subarray(0, 0x8000), 'bootloader', allowBootloaderHashMismatch);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const bootChip = view.getUint16(12, true);
        let applications = 0;
        for (let offset = 0x8000; offset < 0x8c00; offset += 32) {
            const magic = view.getUint16(offset, true);
            if (magic === 0xffff || magic === 0xebeb) break;
            if (magic !== 0x50aa) throw new Error('Invalid firmware partition table.');
            const address = view.getUint32(offset + 4, true), size = view.getUint32(offset + 8, true);
            if (!size || address < 0x9000 || address + size > bytes.length) {
                throw new Error('Invalid firmware partition bounds.');
            }
            if (bytes[offset + 2] === 0 && bytes[address] === 0xe9) {
                const appView = new DataView(bytes.buffer, bytes.byteOffset + address, bytes.byteLength - address);
                if (appView.getUint16(12, true) !== bootChip) {
                    throw new Error('An application in this flash image is for a different chip than its bootloader.');
                }
                await validateEspImage(bytes.subarray(address, address + size));
                applications++;
            }
        }
        if (!applications) throw new Error('The flash image contains no valid ESP application.');
        return boot.hashMismatch;
    }

    function expandMerged(bytes) {
        if (bytes.length < 0x8002 || bytes[0] !== 0xe9 ||
            bytes[0x8000] !== 0xaa || bytes[0x8001] !== 0x50) return null;
        if (bytes.length > 0x1000000) throw new Error('Merged firmware exceeds 16 MiB flash.');
        if (bytes.length < 0x8c00) throw new Error('Truncated merged firmware partition table.');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const chip = view.getUint16(12, true);
        if (chip !== 5 && chip !== 9) throw new Error('Unsupported chip in merged firmware.');
        const partitions = readPartitions(bytes, 0x8000);
        const app = partitions.some(p => p.type === 0 && p.offset + 24 <= bytes.length &&
            bytes[p.offset] === 0xe9 && view.getUint16(p.offset + 12, true) === chip);
        if (!app) throw new Error('Merged firmware has no matching application image.');
        const flash = new Uint8Array(0x1000000).fill(0xff);
        flash.set(bytes);
        return flash;
    }
    /** Whether every string occurs in `bytes` followed by a NUL, as C strings
        are stored in an app image (how a firmware profile recognises its app). */
    function hasCStrings(bytes, strings) {
        const encoder = new TextEncoder();
        return strings.every(text => {
            const needle = [...encoder.encode(text), 0];
            for (let at = bytes.indexOf(needle[0]); at >= 0 && at + needle.length <= bytes.length;
                at = bytes.indexOf(needle[0], at + 1)) {
                if (needle.every((byte, i) => bytes[at + i] === byte)) return true;
            }
            return false;
        });
    }
    return Object.freeze({expandMerged, selectMachine, appLayout, composeApp, hasCStrings, validateEspImage, validateFlash});
})();
