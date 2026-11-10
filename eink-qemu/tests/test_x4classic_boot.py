"""Xteink X4 Classic board wiring without proprietary firmware.

Build qemu-system-xtensa first, then run:
    python3 -m unittest eink-qemu.tests.test_x4classic_boot
"""
import os
import json
from pathlib import Path
import select
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
QEMU = Path(os.environ.get('QEMU_XTENSA', ROOT / 'build/qemu-system-xtensa'))


@unittest.skipUnless(QEMU.exists(), 'build qemu-system-xtensa first')
class X4ClassicBoard(unittest.TestCase):
    GPIO = 0x60004000
    GPIO_IN = GPIO + 0x3c

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        flash = Path(self.directory.name) / 'flash.bin'
        data = bytearray(b'\xff' * 0x1000000)
        data[0x10000:0x10008] = bytes.fromhex('123456789abcdef0')
        flash.write_bytes(data)
        self.err = tempfile.TemporaryFile()
        self.addCleanup(self.err.close)
        monitor = Path(self.directory.name) / 'qmp'
        for suffix in ['in', 'out']:
            os.mkfifo(f'{monitor}.{suffix}')
        self.qmp_in = os.fdopen(os.open(f'{monitor}.in', os.O_RDWR), 'w')
        self.qmp_out = os.fdopen(os.open(f'{monitor}.out', os.O_RDWR), 'rb', buffering=0)
        self.addCleanup(self.qmp_in.close)
        self.addCleanup(self.qmp_out.close)
        self.proc = subprocess.Popen([
            str(QEMU), '-machine', 'x4classic,panel=uc8279-68', '-accel', 'qtest',
            '-display', 'none', '-monitor', 'none', '-serial', 'none',
            '-nic', 'none', '-qtest', 'stdio',
            '-chardev', f'pipe,id=qmp,path={monitor}', '-mon', 'chardev=qmp,mode=control',
            '-drive', f'file={flash},if=mtd,format=raw',
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err,
            text=True, bufsize=1)
        self.addCleanup(self.stop)
        self.assertTrue(select.select([self.qmp_out], [], [], 5)[0])
        self.assertIn('QMP', json.loads(self.qmp_out.readline()))
        self.qmp('qmp_capabilities')

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.proc.stdin.close()
        self.proc.stdout.close()

    def qmp(self, command, **arguments):
        self.qmp_in.write(json.dumps({'execute': command, 'arguments': arguments}) + '\n')
        self.qmp_in.flush()
        while True:
            self.assertTrue(select.select([self.qmp_out], [], [], 5)[0])
            reply = json.loads(self.qmp_out.readline())
            if 'event' not in reply:
                self.assertIn('return', reply)
                return reply['return']

    def write(self, address, value):
        self.proc.stdin.write(f'writel {address:#x} {value:#x}\n')
        self.proc.stdin.flush()
        self.assertTrue(select.select([self.proc.stdout], [], [], 5)[0])
        response = self.proc.stdout.readline().strip()
        self.assertTrue(response.startswith('OK'), response)

    def read(self, address):
        self.proc.stdin.write(f'readl {address:#x}\n')
        self.proc.stdin.flush()
        self.assertTrue(select.select([self.proc.stdout], [], [], 5)[0])
        response = self.proc.stdout.readline().strip()
        self.assertTrue(response.startswith('OK'), response)
        return int(response.split()[1], 0)

    def test_seven_active_low_keys_keep_verified_gpio_mapping(self):
        # The six non-power buttons and Power are exposed as QOM properties.
        mapping = {
            'up': 0, 'down': 7, 'left': 5, 'right': 2,
            'confirm': 8, 'back': 9, 'power': 3,
        }
        baseline = self.read(self.GPIO_IN)
        for name, pin in mapping.items():
            with self.subTest(key=name, gpio=pin):
                mask = 1 << pin
                self.assertNotEqual(baseline & mask, 0, f'{name} GPIO{pin} must idle high')
                self.qmp('qom-set', path='/machine/x4classic-keys', property=name, value=True)
                self.assertEqual(self.read(self.GPIO_IN) & mask, 0,
                                 f'{name} must pull GPIO{pin} low')
                self.qmp('qom-set', path='/machine/x4classic-keys', property=name, value=False)
                self.assertNotEqual(self.read(self.GPIO_IN) & mask, 0,
                                    f'{name} must release GPIO{pin}')

    def test_board_status_inputs_and_motion_sensor(self):
        levels = self.read(self.GPIO_IN)
        self.assertEqual(levels & (1 << 21), 0, 'GPIO21 charger status must idle low')
        self.assertNotEqual(levels & (1 << 4), 0, 'unused GPIO4 must remain pulled high')

        # QMI8658 identity register at the board's documented I2C address.
        base = 0x60013000
        self.write(base + 0x18, 3 << 12)
        self.write(base + 0x18, 0)
        self.write(base + 0x24, 0xffffffff)
        for byte in (0x6a << 1, 0x00):
            self.write(base + 0x1c, byte)
        for index, command in enumerate((6 << 11, (1 << 11) | (1 << 8) | 1, 2 << 11)):
            self.write(base + 0x58 + index * 4, command)
        self.write(base + 4, 1 << 5)
        self.assertEqual(self.read(base + 0x1c) & 0xff, 0x05)

class X4ClassicPanelDefaults(unittest.TestCase):
    def test_default_panel_is_ssd1677_and_other_revisions_remain_selectable(self):
        source = (ROOT / 'hw/xtensa/esp32s3.c').read_text()
        self.assertIn('s->ssd1677 = true;\n    s->uc8279_68 = false;', source)
        self.assertIn('"Panel: ssd1677 (default), uc8179 or uc8279-68"', source)
        self.assertIn('strcmp(value, "ssd1677") && strcmp(value, "uc8179") &&', source)

    def test_x4classic_app_composition_always_seeds_selected_screen_type(self):
        firmware = (ROOT / 'eink-qemu/desktop/src/firmware.ts').read_text()
        resources = (ROOT / 'eink-qemu/desktop/scripts/prepare-resources.sh').read_text()
        self.assertIn("const x4ClassicSeed = machine === 'x4classic';", firmware)
        self.assertIn("('uc8179', 1), ('uc8279-68', 2), ('ssd1677', 3)", resources)
        self.assertIn('nvs-x4classic-${panel}.bin', firmware)

    def test_shake_controls_are_temporarily_removed_from_frontends(self):
        paths = [
            ROOT / 'eink-qemu/desktop/index.html',
            ROOT / 'eink-qemu/desktop/src/app.ts',
            ROOT / 'eink-qemu/desktop/src/backend.ts',
            ROOT / 'eink-qemu/desktop/src/backend-browser.ts',
            ROOT / 'eink-qemu/wasm/web/runtime.js',
            ROOT / 'eink-qemu/wasm/web/style.css',
        ]
        for path in paths:
            with self.subTest(path=path.name):
                text = path.read_text()
                self.assertNotIn('shake-controls', text)
                self.assertNotIn('api.shake', text)
                self.assertNotIn("data.type === 'shake'", text)
