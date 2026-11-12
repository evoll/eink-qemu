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

// SDL's Emscripten glue still initializes its 2D framebuffer path even when
// QEMU is launched with -display none. Node has no DOM or Canvas API, so
// provide an inert canvas and the tiny 2D-context surface SDL uses to allocate
// and submit ImageData. Pixel writes are intentionally discarded: this shim
// is loaded only by the headless Node smoke launcher, never by the browser.
if (typeof globalThis.document === 'undefined') {
    const noop = () => {};
    const context2d = {
        createImageData(width, height) {
            const w = Math.max(0, Number(width) | 0);
            const h = Math.max(0, Number(height) | 0);
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        },
        putImageData: noop,
        clearRect: noop,
        fillRect: noop,
        drawImage: noop,
        save: noop,
        restore: noop,
        setTransform: noop,
    };
    const canvas = {
        width: globalThis.screen.width,
        height: globalThis.screen.height,
        style: {},
        addEventListener: noop,
        removeEventListener: noop,
        getBoundingClientRect: () => ({
            x: 0, y: 0, left: 0, top: 0,
            right: globalThis.screen.width,
            bottom: globalThis.screen.height,
            width: globalThis.screen.width,
            height: globalThis.screen.height,
        }),
        getContext(type) {
            return type === '2d' ? context2d : null;
        },
    };
    const body = {
        appendChild: noop,
        removeChild: noop,
        addEventListener: noop,
        removeEventListener: noop,
    };
    globalThis.document = {
        body,
        documentElement: body,
        querySelector(selector) {
            return selector === 'canvas' || selector === '#canvas' ? canvas : null;
        },
        getElementById(id) {
            return id === 'canvas' ? canvas : null;
        },
        createElement(tagName) {
            return String(tagName).toLowerCase() === 'canvas' ? { ...canvas } : {
                style: {}, addEventListener: noop, removeEventListener: noop,
            };
        },
        addEventListener: noop,
        removeEventListener: noop,
    };
}
