"""Regression test for the ESP32-S3 SPI1 byte-transfer loop.

Compile the exact production helper body with a deterministic SSI stub. This
catches payload-dependent bounds checks and TX/RX buffer overreads without
requiring a complete QEMU build or an ESP32 firmware image.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "hw/ssi/esp32s3_spi.c"


def extract_function(source: str, signature: str) -> str:
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 0
    for pos in range(brace, len(source)):
        if source[pos] == "{":
            depth += 1
        elif source[pos] == "}":
            depth -= 1
            if depth == 0:
                return source[start:pos + 1]
    raise AssertionError("unterminated production helper")


@unittest.skipUnless(shutil.which("cc"), "requires a C compiler")
class Esp32S3SpiTransfer(unittest.TestCase):
    def test_tx_rx_bounds_are_index_based_and_data_is_copied(self):
        source = SOURCE.read_text()
        helper = extract_function(
            source,
            "static void esp32s3_spi_txrx_buffer(ESP32S3SpiState *s,",
        )
        harness = r'''#include <assert.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#define MAX(a, b) ((a) > (b) ? (a) : (b))
typedef struct ESP32S3SpiState { void *spi; } ESP32S3SpiState;
static uint8_t wire[32];
static size_t wire_count;
static uint32_t ssi_transfer(void *spi, uint8_t value)
{
    (void)spi;
    wire[wire_count++] = value;
    return (uint32_t)(value ^ 0xA5);
}
'''
        cases = r'''
int main(void)
{
    ESP32S3SpiState state = {0};

    /* RX shorter than TX: only the first RX byte is copied. */
    {
        const uint8_t tx[] = {0x10, 0x20, 0x30};
        uint8_t rx[] = {0, 0xCC, 0xCC};
        wire_count = 0;
        esp32s3_spi_txrx_buffer(&state, tx, 3, rx, 1);
        assert(wire_count == 3);
        assert(wire[0] == 0x10 && wire[1] == 0x20 && wire[2] == 0x30);
        assert(rx[0] == (uint8_t)(0x10 ^ 0xA5));
        assert(rx[1] == 0xCC && rx[2] == 0xCC);
    }

    /* RX longer than TX: remaining clocks transmit 0 and fill RX safely. */
    {
        const uint8_t tx[] = {0x11, 0x22};
        uint8_t rx[] = {0, 0, 0};
        wire_count = 0;
        esp32s3_spi_txrx_buffer(&state, tx, 2, rx, 3);
        assert(wire_count == 3);
        assert(wire[0] == 0x11 && wire[1] == 0x22 && wire[2] == 0);
        assert(rx[0] == (uint8_t)(0x11 ^ 0xA5));
        assert(rx[1] == (uint8_t)(0x22 ^ 0xA5));
        assert(rx[2] == (uint8_t)0xA5);
    }

    /* Pure receive must not dereference a NULL TX pointer. */
    {
        uint8_t rx[] = {0, 0};
        wire_count = 0;
        esp32s3_spi_txrx_buffer(&state, NULL, 0, rx, 2);
        assert(wire_count == 2 && wire[0] == 0 && wire[1] == 0);
        assert(rx[0] == 0xA5 && rx[1] == 0xA5);
    }
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            c_file = Path(tmp) / "spi-transfer-test.c"
            exe = Path(tmp) / "spi-transfer-test"
            c_file.write_text(harness + "\n" + helper + "\n" + cases)
            subprocess.run(
                [shutil.which("cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                 str(c_file), "-o", str(exe)],
                check=True, capture_output=True, text=True,
            )
            subprocess.run([str(exe)], check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
