'use strict';

// Emscripten's SDL screen-size helper reads the browser global `screen` even
// when QEMU is launched headlessly under Node (for example by wasm/smoke.sh).
// Node does not provide that Web API, so supply the minimal Screen dimensions
// needed by the generated glue. This file is loaded only by run-node.sh; the
// browser runtime and desktop application are not affected.
if (typeof globalThis.screen === 'undefined') {
    const width = Number.parseInt(process.env.WASM_SCREEN_WIDTH || '800', 10);
    const height = Number.parseInt(process.env.WASM_SCREEN_HEIGHT || '600', 10);
    globalThis.screen = {
        width: Number.isFinite(width) && width > 0 ? width : 800,
        height: Number.isFinite(height) && height > 0 ? height : 600,
    };
}
