import type { Machine, Settings } from './types';

/** Hide routine SSD1677 command waits from the visible X4 Classic console.
 * The caller must still feed the original lines to readiness and diagnostics. */
export function visibleConsoleLines(lines: string[], machine: Machine | null, panel: Settings['panel']): string[] {
  if (machine !== 'x4classic' || panel !== 'ssd1677') return lines;
  return lines.filter(line => !/^\[\d+\]\s+Wait complete:\s+(?:CMD_SOFT_RESET|CMD_AUTO_WRITE_BW_RAM|CMD_AUTO_WRITE_RED_RAM)\b/.test(line));
}
