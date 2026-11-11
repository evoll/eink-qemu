"""Exercise the QMI8658 I2C register model used by X4 Classic and X4 Pro.

The test compiles the production register/event implementation with minimal
QEMU I2C type stubs, so it runs without a QEMU build or firmware image.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

PRELUDE = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
typedef struct Object { int unused; } Object;
typedef struct I2CSlave { int unused; } I2CSlave;
typedef struct QMI8658State QMI8658State;
enum i2c_event { I2C_START_SEND, I2C_START_RECV, I2C_FINISH };
typedef int ResetType;
#define QMI8658(p) ((QMI8658State *)(p))
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
#define CLAMP(v, lo, hi) ((v) < (lo) ? (lo) : ((v) > (hi) ? (hi) : (v)))
'''

CASES = r'''
static void write_reg(QMI8658State *s, uint8_t reg, uint8_t value)
{
    qmi8658_event(&s->parent_obj, I2C_START_SEND);
    qmi8658_send(&s->parent_obj, reg);
    qmi8658_send(&s->parent_obj, value);
}

static uint8_t read_reg(QMI8658State *s, uint8_t reg)
{
    qmi8658_event(&s->parent_obj, I2C_START_SEND);
    qmi8658_send(&s->parent_obj, reg);
    qmi8658_event(&s->parent_obj, I2C_START_RECV);
    return qmi8658_recv(&s->parent_obj);
}

static void identity_and_defaults(void)
{
    QMI8658State *s = calloc(1, sizeof(*s));
    qmi8658_reset_hold((Object *)s, 0);
    assert(read_reg(s, 0x00) == 0x05); /* WHO_AM_I */
    assert(read_reg(s, 0x01) == 0x7c); /* REVISION */
    assert(read_reg(s, 0x02) == 0x20); /* CTRL1 power-on default */
    assert(read_reg(s, 0x2e) == 0);    /* sensors disabled */
    assert(read_reg(s, 0x33) == 0);    /* temperature low */
    assert(read_reg(s, 0x34) == 25);   /* 25 C */
    assert(read_reg(s, 0x35) == 0);    /* AX low */
    assert(read_reg(s, 0x36) == 0);
    assert(read_reg(s, 0x37) == 0);
    assert(read_reg(s, 0x38) == 0);
    assert(read_reg(s, 0x39) == 0);    /* outputs remain zero while disabled */
    assert(read_reg(s, 0x3a) == 0);
    for (uint8_t reg = 0x3b; reg <= 0x40; reg++) {
        assert(read_reg(s, reg) == 0);
    }
    free(s);
}

static void enable_and_register_access(void)
{
    QMI8658State *s = calloc(1, sizeof(*s));
    qmi8658_reset_hold((Object *)s, 0);
    write_reg(s, 0x08, 0x03);          /* CTRL7: accel + gyro */
    assert(read_reg(s, 0x2e) == 0x03); /* STATUS0 data-ready */
    write_reg(s, 0x2e, 0xff);          /* read-only status ignored */
    assert(read_reg(s, 0x2e) == 0x03);
    write_reg(s, 0x07, 0x12);          /* writable CTRL register */
    assert(read_reg(s, 0x07) == 0x12);
    qmi8658_reset_hold((Object *)s, 0);
    assert(read_reg(s, 0x07) == 0);    /* reset clears controls */
    assert(read_reg(s, 0x2e) == 0);
    free(s);
}

static void shake_injection(void)
{
    QMI8658State *s = calloc(1, sizeof(*s));
    qmi8658_reset_hold((Object *)s, 0);
    write_reg(s, 0x08, 0x03); /* enable accel and gyro */
    s->shake = "left";
    qmi8658_latch(s);
    assert(read_reg(s, 0x35) == 0x00);
    assert(read_reg(s, 0x36) == 0xa0); /* -1.5 g at the default +/-2 g range */
    assert(read_reg(s, 0x39) == 0x00);
    assert(read_reg(s, 0x3a) == 0x40); /* +1 g Z */
    assert(read_reg(s, 0x3f) == 0x00);
    assert(read_reg(s, 0x40) == 0x40); /* +8 dps yaw at +/-16 dps */
    s->shake = "right";
    qmi8658_latch(s);
    assert(read_reg(s, 0x36) == 0x60); /* +1.5 g X */
    assert(read_reg(s, 0x40) == 0xc0); /* -8 dps yaw */

    /* The same physical impulse must scale with the guest's selected ranges. */
    write_reg(s, 0x03, 0x20); /* CTRL2: +/-8 g */
    write_reg(s, 0x04, 0x20); /* CTRL3: +/-64 dps */
    s->shake = "left";
    qmi8658_latch(s);
    assert(read_reg(s, 0x36) == 0xe8); /* -6144 = -1.5 g at +/-8 g */
    assert(read_reg(s, 0x3a) == 0x10); /* +4096 = +1 g at +/-8 g */
    assert(read_reg(s, 0x40) == 0x10); /* +4096 = +8 dps at +/-64 dps */
    s->shake = "none";
    qmi8658_latch(s);
    assert(read_reg(s, 0x36) == 0x00);
    assert(read_reg(s, 0x3a) == 0x10); /* +1 g at selected +/-8 g range */
    write_reg(s, 0x08, 0x00); /* disabled sensors stop producing samples */
    qmi8658_latch(s);
    assert(read_reg(s, 0x3a) == 0x10); /* last sample is retained */
    free(s);
}

static void sequential_read_autoincrement(void)
{
    QMI8658State *s = calloc(1, sizeof(*s));
    qmi8658_reset_hold((Object *)s, 0);
    qmi8658_event(&s->parent_obj, I2C_START_SEND);
    qmi8658_send(&s->parent_obj, 0x00);
    qmi8658_event(&s->parent_obj, I2C_START_RECV);
    assert(qmi8658_recv(&s->parent_obj) == 0x05);
    assert(qmi8658_recv(&s->parent_obj) == 0x05); /* ADDR_AI defaults off */

    write_reg(s, 0x02, 0x60); /* Enable ADDR_AI, preserving BE default. */
    qmi8658_event(&s->parent_obj, I2C_START_SEND);
    qmi8658_send(&s->parent_obj, 0x00);
    qmi8658_event(&s->parent_obj, I2C_START_RECV);
    assert(qmi8658_recv(&s->parent_obj) == 0x05);
    assert(qmi8658_recv(&s->parent_obj) == 0x7c);
    assert(qmi8658_recv(&s->parent_obj) == 0x60); /* CTRL1 now set */
    free(s);
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    if (!strcmp(argv[1], "defaults")) identity_and_defaults();
    else if (!strcmp(argv[1], "controls")) enable_and_register_access();
    else if (!strcmp(argv[1], "autoincrement")) sequential_read_autoincrement();
    else if (!strcmp(argv[1], "shake")) shake_injection();
    else abort();
    return 0;
}
'''


class QMI8658RegisterModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        source = (ROOT / 'hw/misc/qmi8658.c').read_text()
        core = source[source.index('#define QMI8658_NREGS'):
                      source.index('static char *qmi8658_get_shake')]
        path = Path(cls.directory.name) / 'qmi8658-test.c'
        cls.executable = Path(cls.directory.name) / 'qmi8658-test'
        path.write_text(PRELUDE + core + CASES)
        result = subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra',
                                '-Werror', '-Wno-unused-parameter', str(path), '-o',
                                str(cls.executable)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)

    def run_case(self, case):
        result = subprocess.run([str(self.executable), case], capture_output=True,
                                text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_identity_and_default_stationary_acceleration(self):
        self.run_case('defaults')

    def test_sensor_enable_read_only_status_and_reset(self):
        self.run_case('controls')

    def test_i2c_sequential_read_auto_increment(self):
        self.run_case('autoincrement')

    def test_left_right_shake_injects_imu_impulses(self):
        self.run_case('shake')


if __name__ == '__main__':
    unittest.main()
