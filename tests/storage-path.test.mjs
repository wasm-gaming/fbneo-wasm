// The engine owns its folder: every namespace resolves under fbneo/, and none can
// climb out of it. Runs against the built SDK (make build-sdk), the module a host
// actually imports — which also proves it loads with no import map or bundler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import FbneoSDK, { storagePath } from '../dist/fbneo/fbneo.sdk.js';

const cases = [
  [undefined, 'default', 'fbneo/default', false],
  ['', 'default', 'fbneo/default', false],
  [{ id: 'sonic-1' }, 'default', 'fbneo/default', false],
  ['sonic-1', 'sonic-1', 'fbneo/sonic-1', false],
  ['sonic-2/profile-a', 'sonic-2/profile-a', 'fbneo/sonic-2/profile-a', false],
  [' a b /c? ', 'a_b/c_', 'fbneo/a_b/c_', false],
  ['../x', 'x', 'fbneo/x', false],
  ['./../../etc', 'etc', 'fbneo/etc', false],
  ['..', 'default', 'fbneo/default', false],
  ['/abs/path', 'abs/path', 'fbneo/abs/path', false],
  // the old convention: the prefix is stripped once, so the files stay where they were
  ['fbneo/Sonic1', 'Sonic1', 'fbneo/Sonic1', true],
  // a game literally named like the engine is not mistaken for the prefix
  ['fbneo', 'fbneo', 'fbneo/fbneo', false],
];

for (const [input, namespace, path, prefixed] of cases) {
  test(`storagePath('fbneo', ${JSON.stringify(input)}) → ${path}`, () => {
    assert.deepEqual(storagePath('fbneo', input), { namespace, path, prefixed });
  });
}

test('the engine id is the folder', () => {
  assert.equal(FbneoSDK.id, 'fbneo');
  assert.ok(storagePath(FbneoSDK.id, 'x').path.startsWith(`${FbneoSDK.id}/`));
});

test('the spec says what a host needs to paint its settings', async () => {
  const { FBNEO_SPEC } = await import('../dist/fbneo/fbneo.sdk.js');
  assert.deepEqual(FBNEO_SPEC.assets.rom.allowedTypes, ['.zip', '.7z']);
  assert.deepEqual(FBNEO_SPEC.assets.bios.allowedTypes, ['.zip']);
  assert.equal(FBNEO_SPEC.config.renderFilter.default, 'pixelated');
  assert.equal(FBNEO_SPEC.storage.namespace.default, 'default');
});
