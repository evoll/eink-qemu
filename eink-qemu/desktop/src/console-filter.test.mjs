import assert from 'node:assert/strict';
import { visibleConsoleLines } from './console-filter.ts';

const lines = [
  '[1304]   Wait complete:  CMD_SOFT_RESET (0 ms)',
  '[1309]   Wait complete:  CMD_AUTO_WRITE_BW_RAM (5 ms)',
  '[1314]   Wait complete:  CMD_AUTO_WRITE_RED_RAM (5 ms)',
  '[1326]   Wait complete:  refresh (1 ms)',
  '[10044] [INF] [MEM] Free: 173636 bytes',
];
assert.deepEqual(visibleConsoleLines(lines, 'x4classic', 'ssd1677'), lines.slice(3));
assert.deepEqual(visibleConsoleLines(lines, 'x4classic', 'uc8279-68'), lines);
assert.deepEqual(visibleConsoleLines(lines, 'x4pro', 'ssd1677'), lines);
console.log('console-filter: only routine X4 Classic SSD1677 command waits are hidden');
