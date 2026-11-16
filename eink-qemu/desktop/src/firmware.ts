/* The browser page's prepareFlash: release apps and X4 Pro .xota updates are
   composed into 16 MiB with the bundled boot assets (the Arduino-ESP32 16 MB
   partition table, or the Picco's); merged images and full dumps pass
   through. Images are validated before QEMU sees them. CrossPoint's NVS entry
   (its profile, eink-qemu/profiles/crosspoint.json) goes only into apps that
   carry its strings, on the boards it names; X4 panel screenType selectors
   are seeded into newly composed X4 Pro and X4 Classic app images. */
import '@web/xota.js';
import '@web/flash-image.js';
import crosspoint from '../../profiles/crosspoint.json' with { type: 'json' };
import { panelForMachine } from './devices';
import type { Settings } from './types';

export interface Flash {
  flash: Uint8Array;
  machine: Machine;
  panel: Settings['panel'];
  composed: boolean;
  /** Composition or validation note for the status bar and console; null when no note is needed. */
  composition: string | null;
}

const chipOf = (bytes: Uint8Array) => bytes[12] | (bytes[13] << 8);

async function bootAsset(name: string): Promise<Uint8Array> {
  const response = await fetch(`./boot/${name}`);
  if (!response.ok) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    throw new Error(`Could not load the boot file ${name} (HTTP ${response.status}). Reload the page to try again.` +
      (local ? ' Serving a checkout? Run scripts/prepare-resources.sh first.' : ''));
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function prepareFlash(input: Uint8Array, device: string, panel: Settings['panel'], progress: (text: string) => void): Promise<Flash> {
  let bytes = input;
  const xota = XOTA.isXota(bytes);
  if (xota) {
    progress('Reading and verifying XOTA firmware…');
    bytes = await XOTA.decode(bytes);
  }
  if (bytes.length === 0x1000000) {
    // A complete dump keeps its original bytes and partition contents. Check
    // its layout, bootloader and every app before passing it to QEMU.
    if (!FlashImage.expandMerged(bytes)) throw new Error('This 16 MiB file is not an ESP flash image: no bootloader or partition table.');
    const machine = FlashImage.selectMachine(chipOf(bytes), device);
    const normalized = machine === 'x4classic' ? FlashImage.normalizeX4ClassicLittlefs(bytes) : { flash: bytes, changed: false };
    bytes = normalized.flash;
    // The original X4 Classic ROM-read dump has a valid bootloader segment
    // checksum but a stale appended bootloader SHA-256. Tolerate that one
    // bootloader-only mismatch for this explicitly selected board; keep the
    // bootloader structure/checksum and every application hash mandatory.
    const bootloaderHashMismatch = await FlashImage.validateFlash(bytes, {
      allowBootloaderHashMismatch: machine === 'x4classic',
    });
    const validationNote = bootloaderHashMismatch
      ? 'Imported original X4 Classic 16 MiB dump; bootloader SHA-256 mismatch tolerated after checksum validation (application SHA-256 verified)'
      : null;
    const composition = [normalized.changed ? 'Normalized X4 Classic spiffs partition subtype from SPIFFS (0x82) to LittleFS (0x83); filesystem bytes preserved' : null, validationNote].filter(Boolean).join('; ') || null;
    return { flash: bytes, machine, panel: panelForMachine(machine, panel), composed: false, composition };
  }
  const merged = !xota && FlashImage.expandMerged(bytes);
  if (merged) {
    await FlashImage.validateFlash(merged);
    const machine = FlashImage.selectMachine(chipOf(merged), device);
    const normalized = machine === 'x4classic' ? FlashImage.normalizeX4ClassicLittlefs(merged) : { flash: merged, changed: false };
    return { flash: normalized.flash, machine, panel: panelForMachine(machine, panel), composed: false,
      composition: normalized.changed ? 'Normalized X4 Classic spiffs partition subtype from SPIFFS (0x82) to LittleFS (0x83); filesystem bytes preserved' : null };
  }
  if (bytes.length < 24 || bytes[0] !== 0xe9) {
    throw new Error('Choose a firmware .bin, an X4 Pro .xota update, or a 16 MiB flash dump (16777216 bytes).');
  }
  await validateApp(bytes);
  const chip = chipOf(bytes);
  if (chip !== 5 && chip !== 9) throw new Error(`Unsupported ESP chip ID ${chip}; expected ESP32-C3 (5) or ESP32-S3 (9).`);
  const machine = FlashImage.selectMachine(chip, device);
  panel = panelForMachine(machine, panel);
  const layout = FlashImage.appLayout(machine);
  progress('Composing 16 MiB flash image…');
  const crosspointApp = FlashImage.hasCStrings(bytes, crosspoint.detect.image_strings);
  const x3Seed = crosspoint.nvs_seed.machines.includes(machine) && crosspointApp;
  // CrossPoint 2.x X4 Classic images do not necessarily contain the legacy
  // cphw/dev_det C strings used by the X3 detector. The selected X4 Classic
  // panel is authoritative for this emulated board, so always seed its
  // screenType in newly composed app images. Full/merged flash images above
  // deliberately pass through unchanged.
  const x4PanelSeed = machine === 'x4pro' || machine === 'x4classic';
  // The stock X4 Classic firmware mounts LittleFS during startup. Its OTA
  // application does not contain the filesystem image, so seed the known
  // factory filesystem only for that firmware (CrossPoint remains unchanged).
  const x4ClassicStockLittlefs = machine === 'x4classic' && FlashImage.hasCStrings(bytes, [
    'esp_vfs_littlefs_register',
  ]);
  const seedAsset = x3Seed ? 'nvs-crosspoint.bin'
    : x4PanelSeed ? `nvs-${machine}-${panel}.bin` : null;
  // Keep the standard ESP32-S3 bootloader for all composed application
  // images, including stock X4 Classic. The factory bootloader was tested
  // diagnostically and did not resolve SD detection or first-boot behavior.
  const [boot, partitions, nvs, littlefs] = await Promise.all([
    bootAsset(layout.bootAsset), bootAsset(layout.partitionAsset), seedAsset ? bootAsset(seedAsset) : null,
    x4ClassicStockLittlefs ? bootAsset('x4classic-stock-littlefs.bin') : null,
  ]);
  const composition = `Composed 16 MiB flash from the ${xota ? 'XOTA update' : 'app'} with ${layout.partitionTable}` +
    (seedAsset ? ` and ${x4PanelSeed ? `${machine === 'x4pro' ? 'X4 Pro' : 'X4 Classic'} ${panel} screenType` : `${crosspoint.title}'s NVS entry`}` : '') +
    (littlefs ? ' and factory X4 Classic LittleFS seed' : '');
  return { flash: FlashImage.composeApp(bytes, { machine, boot, partitions, nvs, littlefs, selectOta: xota }), machine, panel, composed: true, composition };
}

async function validateApp(bytes: Uint8Array): Promise<void> {
  await FlashImage.validateEspImage(bytes);
}
