/* Node-only boot diagnostics for the Emscripten ROM smoke test. */
#ifndef QEMU_WASM_BOOT_DIAGNOSTICS_H
#define QEMU_WASM_BOOT_DIAGNOSTICS_H

#include "qemu/osdep.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
static inline bool qemu_wasm_boot_diagnostics_enabled(void)
{
    return EM_ASM_INT({
        return (typeof process === 'object' && process !== null &&
                process.env && process.env.WASM_BOOT_DIAGNOSTICS === '1') ? 1 : 0;
    });
}
#else
static inline bool qemu_wasm_boot_diagnostics_enabled(void)
{
    return false;
}
#endif

#endif /* QEMU_WASM_BOOT_DIAGNOSTICS_H */
