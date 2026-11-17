// Remapping player 1 in front of FBNeo: keys replayed as FBNeo's defaults, freed defaults
// swallowed, pad buttons reordered (fire 5 / 6 are pad-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FBNEO_CONTROLS, controlTables, remapPad } from '../dist/fbneo/fbneo.sdk.js';

const pad = (pressed) => ({
  id: 'pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
});
const held = (p) => p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);

test('the controls: four fire buttons on keys, fire 5 / 6 on the pad only, coin and start', () => {
  assert.deepEqual(FBNEO_CONTROLS.map((c) => c.id), ['fire1', 'fire2', 'fire3', 'fire4', 'fire5', 'fire6', 'coin', 'start', 'up', 'down', 'left', 'right']);
  assert.equal(FBNEO_CONTROLS.find((c) => c.id === 'fire5').code, undefined);
  assert.equal(FBNEO_CONTROLS.find((c) => c.id === 'coin').code, 'Digit5');
});

test('keys: a remapped key stands for the default one, and a freed default is swallowed', () => {
  const tables = controlTables({ keys: { fire1: 'KeyJ', fire5: 'KeyK' } });
  assert.equal(tables.keys.get('KeyJ').code, 'KeyZ');
  assert.ok(tables.blocked.has('KeyZ'));
  // Fire 5 has no key of its own in FBNeo: a key for it is ignored.
  assert.equal(tables.keys.has('KeyK'), false);
});

test('pads: the chosen button sits where FBNeo looks for the control', () => {
  // Fire 1 on button 3, fire 4 (button 3 by default) on button 0: a swap.
  const tables = controlTables({ buttons: { fire1: 3, fire4: 0 } });
  assert.deepEqual(held(remapPad(pad([3]), tables.pad)), [0]);
  assert.deepEqual(held(remapPad(pad([0]), tables.pad)), [3]);
  // Untouched controls pass through.
  assert.deepEqual(held(remapPad(pad([9]), tables.pad)), [9]);
});
