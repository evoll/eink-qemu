/*
 * Copyright (c) 2019 Espressif Systems (Shanghai) Co. Ltd.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 2 or
 * (at your option) any later version.
 */

#include "qemu/osdep.h"
#include "qemu/error-report.h"
#include "qemu/wasm-boot-diagnostics.h"
#include "cpu.h"
#include "gdbstub/helpers.h"
#include "qemu/host-utils.h"

#include "core-esp32s3/core-isa.h"
#include "overlay_tool.h"

#define xtensa_modules xtensa_modules_esp32s3
#include "core-esp32s3/xtensa-modules.inc.c"

extern const XtensaOpcodeTranslators xtensa_tie_opcodes;

static const XtensaOpcodeTranslators * esp32s3_opcode_translators[] = {
    &xtensa_core_opcodes,
    &xtensa_fpu_opcodes,
    &xtensa_tie_opcodes,
    NULL
};

static XtensaConfig xtensa_core_esp32s3 __attribute__((unused)) = {
    .name = "esp32s3",
    .gdb_regmap = {
        .reg = {
#include "core-esp32s3/gdb-config.inc.c"
        }
    },
    .isa_internal = &xtensa_modules,
    .clock_freq_khz = 40000,
    .opcode_translators = esp32s3_opcode_translators,
    DEFAULT_SECTIONS
};

REGISTER_CORE(xtensa_core_esp32s3)

/*
 * Ensure the ESP32-S3 CPU type exists before the SoC instantiates its CPUs.
 * The normal REGISTER_CORE() path is a type_init hook.  Keep this idempotent
 * fallback for machine initialization so that an omitted/late core type
 * registration cannot silently resolve to a different Xtensa model.
 */
void xtensa_esp32s3_register_core(void)
{
    const char *type_name = XTENSA_CPU_TYPE_NAME("esp32s3");
    ObjectClass *oc = object_class_by_name(type_name);

    if (oc) {
        XtensaCPUClass *xcc = XTENSA_CPU_CLASS(oc);
        if (!xcc->config || strcmp(xcc->config->name, "esp32s3") != 0) {
            error_report("Xtensa CPU type '%s' is bound to '%s', expected 'esp32s3'",
                         type_name,
                         xcc->config ? xcc->config->name : "(null)");
            exit(1);
        }
#ifdef __EMSCRIPTEN__
        if (qemu_wasm_boot_diagnostics_enabled()) {
            fprintf(stderr,
                    "WASM_XTENSA_CORE_REGISTER status=already-registered type=%s config=%s\n",
                    type_name, xcc->config->name);
            fflush(stderr);
        }
#endif
        return;
    }

#if TARGET_BIG_ENDIAN
    error_report("ESP32-S3 requires a little-endian Xtensa target; "
                 "cannot register %s", type_name);
    exit(1);
#else
    static XtensaConfigList node = {
        .config = &xtensa_core_esp32s3,
    };

    xtensa_register_core(&node);
#ifdef __EMSCRIPTEN__
    if (qemu_wasm_boot_diagnostics_enabled()) {
        fprintf(stderr, "WASM_XTENSA_CORE_REGISTER status=registered name=%s qom_type=%s\n",
                xtensa_core_esp32s3.name, type_name);
        fflush(stderr);
    }
#endif
#endif
}
