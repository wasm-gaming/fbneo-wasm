// Who plays player 1. FBNeo binds each input to one device: `-joy` makes the first pad
// player 1 (with its Start and Select), and must not be passed with no pad at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbneoArgs } from '../dist/fbneo/fbneo.sdk.js';

test('no pad at start: player 1 on the keyboard, FBNeo as before', () => {
  assert.deepEqual(fbneoArgs('mslug', []), { args: ['mslug'], controller: 'keyboard' });
  assert.deepEqual(fbneoArgs('mslug', [null, null, null, null]), { args: ['mslug'], controller: 'keyboard' });
  assert.deepEqual(fbneoArgs('mslug', undefined), { args: ['mslug'], controller: 'keyboard' });
});

test('a pad at start: -joy, so the pad is player 1', () => {
  assert.deepEqual(fbneoArgs('mslug', [{ connected: true }]), { args: ['mslug', '-joy'], controller: 'gamepad' });
  assert.deepEqual(fbneoArgs('kof98', [null, { connected: true }]).controller, 'gamepad');
});

test('a listed pad that is not connected does not count', () => {
  assert.deepEqual(fbneoArgs('mslug', [{ connected: false }]).controller, 'keyboard');
});
