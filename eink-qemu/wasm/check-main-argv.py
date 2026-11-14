#!/usr/bin/env python3
"""Inspect generated Emscripten glue for main() argument forwarding."""
from pathlib import Path
import re
import sys


def inspect(path: Path) -> int:
    if not path.is_file():
        print(f"WASM_MAIN_ARGV_CHECK missing={path}", file=sys.stderr)
        return 2
    source = path.read_text(encoding="utf-8", errors="replace")
    patterns = {
        "proxy_main": r"__emscripten_proxy_main",
        "main_reads_params_zero": r"var\s+argc\s*=\s*0\s*;\s*var\s+argv\s*=\s*0",
        "main_reads_params_forwarded": r"args\.unshift\(thisProgram\)",
        "node_process_argv": r"process\.argv\.slice\(2\)",
    }
    matches = {name: bool(re.search(pattern, source))
               for name, pattern in patterns.items()}
    rendered = " ".join(f"{name}={int(value)}"
                        for name, value in matches.items())
    print(f"WASM_MAIN_ARGV_CHECK file={path.name} {rendered}")

    # Emit short context around relevant constructs so CI logs show the exact
    # generated branch, even if Emscripten changes whitespace or minification.
    for token in ("__emscripten_proxy_main", "args.unshift(thisProgram)",
                  "var argc = 0"):
        index = source.find(token)
        if index >= 0:
            excerpt = re.sub(r"\s+", " ", source[max(0, index - 180):index + 260])
            print(f"WASM_MAIN_ARGV_CONTEXT token={token} text={excerpt[:440]}")
    return 0


if __name__ == "__main__":
    status = 0
    for item in sys.argv[1:]:
        status = max(status, inspect(Path(item)))
    if len(sys.argv) == 1:
        raise SystemExit("usage: check-main-argv.py generated.js [generated.js ...]")
    raise SystemExit(status)
