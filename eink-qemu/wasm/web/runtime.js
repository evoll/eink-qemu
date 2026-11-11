/* A fresh iframe owns each Emscripten instance and its pthread workers. */
'use strict';
// Monitor (HMP) traffic uses its own character device, /dev/hmp, so its echo
// and terminal escapes never interleave with the firmware's USB serial log.
const monitorInput = [];
let monitorOutput = '';
const monitorDecoder = new TextDecoder();
let machineType, homeHeld = false, heapHold = false;
let panelDiagTimer = 0, panelDiagPending = false;
let heapReadMonitorOutput = null;
// Actions that need the VM stopped (snapshots, SD card operations), FIFO.
// Each one runs on the 'VM status: paused' line of its own 'info status'.
const pauses = [];
let paused = null;
const canvas = document.querySelector('canvas');
// The iframe and workers are discarded on navigation. SDL's unload callback
// cannot finish a guest shutdown here, and its wasm64 string return currently
// trips Emscripten's BigInt-to-string conversion. Saves happen before unload.
window.addEventListener('beforeunload', event => event.stopImmediatePropagation(), {capture: true});
const send = (type, extra = {}) => parent.postMessage({type, ...extra}, location.origin);
// The page decides that firmware without a profile has booted once its
// screen stays quiet, so it hears when the panel shows something new. SDL's
// software renderer presents each frame with putImageData on this canvas; a
// fingerprint of the pixels skips repaints of an unchanged frame. A blank
// frame (one value throughout: the panel before the firmware draws, a
// refresh's flash) is reported at once, so the page drops a quiet-screen
// verdict it was about to reach; a drawn one at most every 100 ms. A new
// boot (reset, or the ROM's banner) forgets the fingerprint, so its first
// draw counts even when it repeats the last boot's image.
let screenPrint = 0, screenTimer = 0;
function screenChanged(blank) {
    if (blank) {
        clearTimeout(screenTimer);
        screenTimer = 0;
        send('screen', {blank: true});
    } else {
        screenTimer ||= setTimeout(() => { screenTimer = 0; send('screen', {blank: false}); }, 100);
    }
}
function newBoot() {
    screenPrint = 0;
    clearTimeout(screenTimer);
    screenTimer = 0;
}
if (typeof CanvasRenderingContext2D === 'function') {
    const putImageData = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (image, ...rest) {
        if (this.canvas === canvas && image?.data) {
            const words = new Uint32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength >> 2);
            let hash = 2166136261, blank = true;
            for (let i = 0; i < words.length; i++) {
                hash = Math.imul(hash ^ words[i], 16777619);
                blank &&= words[i] === words[0];
            }
            if (hash !== screenPrint) {
                screenPrint = hash;
                screenChanged(blank);
            }
        }
        return putImageData.call(this, image, ...rest);
    };
}
const keyCodes = {ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Enter: 13, Backspace: 8, Escape: 27, KeyP: 80, Home: 36};
// Home is a capacitive key on the GT911, separate from the GPIO buttons.
// Handle both forwarded page controls and keys typed with the canvas focused.
function homeKey(down) {
    if (machineType !== 'x4pro' || !window.Module?.FS || homeHeld === down) return;
    homeHeld = down;
    command(`qom-set /machine/gt911 home ${down}`);
}
for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
    if (machineType !== 'x4pro' || event.code !== 'Home' ||
        event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    homeKey(type === 'keydown');
}, {capture: true});
window.addEventListener('blur', () => homeKey(false));
// Keep these overrides in sync with eink-qemu/turbo-args.sh.
function turboProperties(machine, panel) {
    const properties = [
        // The X4 Pro and Picco cards sit on the S3's SDMMC host, not on SPI.
        ...(machine === 'x4pro' || machine === 'x4classic' || machine === 'picco' ? [] : ['read-access-us', 'read-seq-access-us', 'read-repeat-us', 'read-next-us',
            'write-busy-us', 'write-random-busy-us', 'write-repeat-busy-us',
            'write-block-busy-us', 'write-stop-busy-us', 'write-stop-decrement-us',
            'write-stop-random-extra-us'].map(name => `ssi-sd.${name}=0`)),
        ...['transaction-overhead-us', 'transaction-overhead-ns', 'buffer-overhead-ns']
            .map(name => `driver=ssi.esp32s3.gpspi,property=${name},value=0`),
        'driver=ssi.esp32s3.gpspi,property=zero-wire-time,value=on',
        ...(['x4pro', 'picco'].includes(machine) ? ['dwc_sdmmc.timing=off'] : []),
        'esp32_wifi.rx-frame-us=500',
        ...(machine === 'x3' ?
            [...['frame-us', 'refresh-overhead-us'].map(name => `uc8279.${name}=0`),
                ...['pon-ms', 'pof-ms', 'busy-ms'].map(name => `uc8279.${name}=1`)] :
            (machine === 'x4' || machine === 'picco' || panel === 'ssd1677') ? ['ssd1677.busy-ms=1'] :
            ['uc8179.frame-us=1', ...['pon-ms', 'pof-ms', 'busy-ms'].map(name => `uc8179.${name}=1`)])
    ];
    return properties.flatMap(property => ['-global', property]);
}
function output(line) {
    if (line.startsWith('ESP-ROM:')) newBoot();
    send('log', {line});
}
// Lines the monitor prints: prompts, echo of the page's own commands and
// their answers. Only the 'VM status' answer drives the page; nothing is logged.
function monitorLine(line) {
    // Preserve HMP diagnostics for Heap reads. A missing output file alone
    // cannot distinguish an unsupported command, an unmapped address, or a
    // QEMU-side file creation failure.
    if (heapReadMonitorOutput && !line.includes('VM status: paused') && !line.trim().startsWith('(qemu)')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('memsave ') && !trimmed.startsWith('pmemsave ')) heapReadMonitorOutput.push(trimmed);
    }
    if (panelDiagPending && line.trim() && !line.includes('qom-get') && !line.includes('(qemu)')) {
        panelDiagPending = false;
        send('log', {line: `[QEMU] ${line.trim()}`});
    }
    if (paused && line.includes('VM status: paused')) {
        const action = paused;
        const resume = action();
        if (resume === 'reset') {
            window.Module?.browserNetwork?.reset();
            command('system_reset\ncont');
        } else if (resume === 'cont') command('cont');
        nextPause();
    }
}
function whilePaused(action, heapSafe = false) {
    pauses.push({action, heapSafe});
    if (!paused) nextPause();
}
function nextPause() {
    // An action commonly drains the queue. Do not splice index 0 from an
    // empty queue: that returns undefined and used to throw while reading
    // `.action`, aborting the browser runtime before firmware boot.
    if (!pauses.length) { paused = null; return; }
    // While a Heap snapshot owns the stop, defer SD/save operations. Reads
    // and heapEnd are marked heapSafe and may continue within that pause.
    const index = heapHold ? pauses.findIndex(item => item.heapSafe) : 0;
    if (index < 0) { paused = null; return; }
    const next = pauses.splice(index, 1)[0];
    if (!next || typeof next.action !== 'function') { paused = null; return; }
    paused = next.action;
    command('stop\ninfo status');
}
function snapshot(action) {
    whilePaused(() => {
        if (action === 'stop') Module.browserNetwork?.close();
        const bytes = Module.FS.readFile('/sd.img');
        parent.postMessage({type: 'snapshot', action, bytes}, location.origin, [bytes.buffer]);
        return action === 'stop' ? null : 'cont';
    });
}
// The card image QEMU reads and writes, in place (writeFile(canOwn) adopted it).
function sdBytes() {
    const node = Module.FS.lookupPath('/sd.img').node;
    return node.contents.subarray(0, node.usedBytes);
}
function describeFsError(error) {
    if (error instanceof Error && error.message) return `${error.name}: ${error.message}`;
    if (error && typeof error === 'object') {
        const fields = ['name', 'message', 'code', 'errno', 'path'].filter(key => error[key] !== undefined)
            .map(key => `${key}=${String(error[key])}`);
        if (fields.length) return fields.join(', ');
        try { return JSON.stringify(error); } catch {}
    }
    return String(error);
}
function parsePhysicalDump(lines, addr, size) {
    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const line of lines) {
        const match = line.match(/^\s*0x([0-9a-f]+):\s*(.*)$/i);
        if (!match) continue;
        const lineAddress = Number.parseInt(match[1], 16);
        if (!Number.isSafeInteger(lineAddress) || lineAddress !== addr + cursor) continue;
        const values = [...match[2].matchAll(/\b0x([0-9a-f]{1,2})\b/gi)];
        if (!values.length) continue;
        for (const value of values) {
            if (cursor >= size) break;
            bytes[cursor++] = Number.parseInt(value[1], 16);
        }
    }
    if (cursor !== size) throw new Error(`QEMU xp returned ${cursor} of ${size} bytes.`);
    return bytes;
}
function heapRead({id, addr, size}) {
    if (!Number.isSafeInteger(id) || !Number.isInteger(addr) || addr < 0 || addr > 0xffffffff ||
        !Number.isInteger(size) || size < 1 || size > 32 * 1024 * 1024 || addr + size > 0x100000000) {
        send('heap-read-result', {id, ok: false, error: {code: 'EINVAL', message: 'Invalid guest-memory range.'}});
        return;
    }
    whilePaused(() => {
        const path = `/heap-read-${id}.bin`;
        heapReadMonitorOutput = [];
        try { Module.FS.unlink(path); } catch {}
        const fail = detail => {
            const monitor = heapReadMonitorOutput?.filter(line => !line.includes('info status')).slice(-8).join(' | ');
            heapReadMonitorOutput = null;
            send('heap-read-result', {id, ok: false, error: {code: 'EIO', message: `Cannot read guest memory at 0x${addr.toString(16)}: ${detail}${monitor ? `; QEMU: ${monitor}` : '; QEMU returned no diagnostic output'}`}});
        };
        const complete = bytes => {
            heapReadMonitorOutput = null;
            parent.postMessage({type: 'heap-read-result', id, ok: true, bytes}, location.origin, [bytes.buffer]);
        };
        const readWithXp = (offset, result) => {
            const count = Math.min(4096, size - offset);
            const chunkAddress = addr + offset;
            heapReadMonitorOutput = [];
            pauses.unshift({heapSafe: true, action: () => {
                try {
                    const chunk = parsePhysicalDump(heapReadMonitorOutput || [], chunkAddress, count);
                    result.set(chunk, offset);
                    if (offset + count < size) {
                        readWithXp(offset + count, result);
                    } else {
                        complete(result);
                    }
                } catch (error) {
                    fail(`pmemsave did not create a readable file and physical-memory fallback failed: ${describeFsError(error)}`);
                }
                return heapHold ? undefined : 'cont';
            }});
            // xp reads guest physical memory directly and prints byte values to HMP.
            // Chunking bounds monitor output while keeping the VM stopped for the full snapshot.
            command(`xp/${count}bx 0x${chunkAddress.toString(16)}\ninfo status`);
        };
        pauses.unshift({heapSafe: true, action: () => {
            try {
                const bytes = Module.FS.readFile(path);
                if (bytes.length !== size) throw new Error(`pmemsave produced ${bytes.length} of ${size} bytes.`);
                Module.FS.unlink(path);
                complete(bytes);
            } catch (error) {
                try { Module.FS.unlink(path); } catch {}
                // Some Emscripten builds do not expose QEMU's pmemsave output
                // file through MEMFS. Fall back to HMP xp, which dumps physical
                // bytes through the monitor and avoids host-file I/O entirely.
                readWithXp(0, new Uint8Array(size));
            }
            return heapHold ? undefined : 'cont';
        }});
        command(`pmemsave 0x${addr.toString(16)} ${size} ${path}\ninfo status`);
    }, true);
}

function heapBegin({id}) {
    if (heapHold) {
        send('heap-control-result', {id, ok: false, error: {code: 'EBUSY', message: 'A Heap memory transaction is already active.'}});
        return;
    }
    whilePaused(() => {
        heapHold = true;
        send('heap-control-result', {id, ok: true});
        // Keep the VM stopped until heapEnd; subsequent reads share this pause.
        return undefined;
    });
}
function heapEnd({id}) {
    if (!heapHold) {
        send('heap-control-result', {id, ok: true});
        return;
    }
    whilePaused(() => {
        heapHold = false;
        send('heap-control-result', {id, ok: true});
        return 'cont';
    }, true);
}
function sdOperation({id, op, args}) {
    whilePaused(() => {
        const reply = {type: 'sd-result', id, ok: true, reset: false};
        const transfer = [];
        try {
            const image = sdBytes();
            reply.result = sdExecute(image, op, args);
            if (reply.result.bytes) {
                // Transfer only a buffer that holds nothing but the file.
                const {bytes} = reply.result;
                if (bytes.buffer === image.buffer || bytes.byteOffset || bytes.byteLength !== bytes.buffer.byteLength) {
                    reply.result.bytes = bytes.slice();
                }
                transfer.push(reply.result.bytes.buffer);
            }
            reply.reset = sdMutates(op);
        } catch (error) {
            reply.ok = false;
            reply.error = {code: error.code || 'EIO', message: error.message};
            // Anything that may have touched a sector needs a remount.
            reply.reset = sdChanged(op, error);
        }
        if (reply.reset) {
            // Save the edited card before the reset lets firmware write again.
            reply.image = Module.FS.readFile('/sd.img');
            transfer.push(reply.image.buffer);
        }
        parent.postMessage(reply, location.origin, transfer);
        return reply.reset ? 'reset' : 'cont';
    });
}
function command(text) {
    monitorInput.push(...new TextEncoder().encode(text + '\n'));
    Module.FS.lookupPath('/dev/hmp').node.notifyListeners?.(1);
}
// Character device behind '-chardev file,path=/dev/hmp,input-path=/dev/hmp'.
// QEMU polls it like any other fd; reads report EAGAIN until a command is queued.
function monitorDevice(FS) {
    const POLLIN = 1, POLLOUT = 4, EAGAIN = 6;
    const device = FS.makedev(64, 0);
    FS.registerDevice(device, {
        // A character device is a stream: never seek, even for O_APPEND writes.
        open(stream) { stream.seekable = false; },
        read(stream, buffer, offset, length) {
            if (!monitorInput.length) throw new FS.ErrnoError(EAGAIN);
            const n = Math.min(length, monitorInput.length);
            buffer.set(monitorInput.splice(0, n), offset);
            return n;
        },
        write(stream, buffer, offset, length) {
            monitorOutput += monitorDecoder.decode(buffer.slice(offset, offset + length), {stream: true});
            const lines = monitorOutput.split('\n');
            monitorOutput = lines.pop();
            lines.forEach(monitorLine);
            return length;
        },
        poll: () => (monitorInput.length ? POLLIN : 0) | POLLOUT
    });
    FS.mkdev('/dev/hmp', device);
}
window.addEventListener('message', async ({source, origin, data}) => {
    if (source !== parent || origin !== location.origin) return;
    if (data.type === 'key') {
        document.dispatchEvent(new KeyboardEvent(data.down ? 'keydown' : 'keyup', {
            key: data.code === 'KeyP' ? 'p' : data.code, code: data.code,
            keyCode: keyCodes[data.code], which: keyCodes[data.code], bubbles: true
        }));
    } else if (data.type === 'reset') {
        newBoot();
        homeKey(false);
        window.Module?.browserNetwork?.reset();
        command('system_reset');
    } else if (data.type === 'download' || data.type === 'stop' || data.type === 'autosave') {
        snapshot(data.type);
    } else if (data.type === 'sd') {
        sdOperation(data);
    } else if (data.type === 'heap-read') {
        heapRead(data);
    } else if (data.type === 'heap-begin') {
        heapBegin(data);
    } else if (data.type === 'heap-end') {
        heapEnd(data);
    } else if (data.type === 'boot') {
        newBoot();
        clearInterval(panelDiagTimer);
        panelDiagTimer = 0;
        panelDiagPending = false;
        const {machine, panel = 'uc8279-68', flash, sd, rom, wifi = true, turbo = false, ghosting = true} = data;
        machineType = machine;
        // Picco distinguishes taps from long presses in guest time. Keep its
        // interactive clock paced even with faster peripheral timings, or an
        // ordinary host click can become a multi-second guest long press.
        // Explicit benchmark runs can still opt out with ?sleep=off.
        const sleep = (turbo && machine !== 'picco') ||
            new URLSearchParams(parent.location.search).get('sleep') === 'off' ? 'off' : 'on';
        let browserNetwork = null;
        try {
            if (wifi) browserNetwork = await (await import('./browser-network.mjs')).createBrowserNetwork({log: output});
        } catch (error) {
            // Return the card so a failed Wi-Fi startup can be retried without
            // losing a card preserved by Stop in the previous session.
            parent.postMessage({type: 'boot-error', message: String(error), sd}, location.origin, [sd]);
            return;
        }
        window.Module = {
            browserNetwork,
            canvas,
            arguments: ['-L', '/', '-machine', (machine === 'x4pro' || machine === 'x4classic') ? `${machine},panel=${panel}` : machine,
                '-accel', 'tcg,tb-size=64',
                '-icount', `shift=${machine === 'picco' ? 2 : 0},sleep=${sleep}`,
                ...(turbo ? turboProperties(machine, panel) : []),
                ...((machine === 'x4' || machine === 'picco' || panel === 'ssd1677') ? [] : ['-global', `${machine === 'x3' ? 'uc8279' : 'uc8179'}.ghosting=${ghosting ? 'on' : 'off'}`]),
                '-drive', 'file=/flash.bin,if=mtd,format=raw,cache.direct=off',
                '-drive', 'file=/sd.img,if=sd,format=raw,cache.direct=off',
                '-chardev', 'stdio,id=cdc', '-serial', 'null', '-parallel', 'none',
                '-global', 'driver=misc.esp32s3.usb_serial_jtag,property=chardev,value=cdc',
                '-chardev', 'file,id=hmp,path=/dev/hmp,input-path=/dev/hmp,append=on',
                '-object', 'monitor-hmp,id=hmp0,chardev=hmp', '-display', 'sdl,show-cursor=on',
                // With Wi-Fi off the radio stays, with no access points to find.
                '-nic', wifi ? 'browser,model=esp32_wifi' : 'hubport,hubid=0,model=esp32_wifi',
                ...(wifi ? [] : ['-global', 'esp32_wifi.access-points=off'])],
            print: output, printErr: output,
            onAbort: reason => send('error', {message: String(reason)}),
            onExit: status => send('exit', {status}),
            preRun: [() => {
                monitorDevice(Module.FS);
                Module.FS.writeFile('/flash.bin', new Uint8Array(flash), {canOwn: true});
                Module.FS.writeFile('/sd.img', new Uint8Array(sd), {canOwn: true});
                Module.FS.writeFile((machine === 'x3' || machine === 'x4') ? '/esp32c3-rom.bin' : '/esp32s3_rev0_rom.bin', new Uint8Array(rom));
            }],
            onRuntimeInitialized: () => {
                // Nothing is typed into the firmware's serial port: keep stdin quiet.
                Module.TTY.default_tty_ops.get_char = () => undefined;
                const stdin = Module.FS.getStream(0);
                stdin.stream_ops = {...stdin.stream_ops, poll: () => 0};
                send('running');
                canvas.focus({preventScroll: true});
                if (machine === 'x4classic' && panel === 'ssd1677') {
                    // QEMU LOG_GUEST_ERROR is host-side stderr, not guest UART.
                    // Expose controller state through a read-only QOM property.
                    const report = () => {
                        if (panelDiagPending || !window.Module?.FS) return;
                        panelDiagPending = true;
                        command('qom-get /machine/peripheral/panel diagnostics');
                    };
                    setTimeout(report, 3000);
                    panelDiagTimer = setInterval(report, 10000);
                }
            }
        };
        const script = document.createElement('script');
        script.src = `qemu-system-${(machine === 'x3' || machine === 'x4') ? 'riscv32' : 'xtensa'}.js`;
        script.onerror = () => send('error', {message: `Could not load the emulator (${script.src.split('/').pop()}). Reload the page to try again.` +
            (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? ' Serving a checkout? Run package-web.sh first.' : '')});
        document.body.append(script);
    }
});
window.addEventListener('error', event => send('error', {message: event.message}));
window.addEventListener('pagehide', () => window.Module?.browserNetwork?.close());
send('ready');

window.addEventListener('unhandledrejection', event => send('error', {message: String(event.reason)}));
