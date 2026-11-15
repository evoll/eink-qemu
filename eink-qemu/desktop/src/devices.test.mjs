import assert from 'node:assert/strict';
import { panelForMachine } from './devices.ts';

assert.equal(panelForMachine('x4pro', 'ssd1677'), 'uc8279-68', 'X4 Pro must fall back to its factory default when a previous Classic SSD1677 choice is restored');
assert.equal(panelForMachine('x4pro', 'uc8179'), 'uc8179');
assert.equal(panelForMachine('x4pro', 'uc8279-68'), 'uc8279-68');
assert.equal(panelForMachine('x4classic', 'ssd1677'), 'ssd1677', 'X4 Classic must retain SSD1677 support');
assert.equal(panelForMachine('x4classic', 'uc8179'), 'uc8179');
assert.equal(panelForMachine('x3', 'ssd1677'), 'ssd1677', 'non-X4 panel setting is not rewritten here');
console.log('devices: machine-specific panel selection passed');
