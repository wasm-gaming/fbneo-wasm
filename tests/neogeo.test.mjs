// Which BIOS boots a Neo Geo as the AES, from the CRC-32s inside the BIOS zip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neoGeoAesBios } from '../dist/fbneo/fbneo.sdk.js';

const entries = (...crcs) => crcs.map((crc) => ({ crc }));

test('the real AES World BIOS wins when the zip has it', () => {
  assert.deepEqual(neoGeoAesBios(entries('9036d879', 'a7aab458', 'D27A71F1')), {
    bios: 'aes',
    dips: [['BIOS', 'AES World']],
  });
});

test('else Universe BIOS 4.0 in its AES mode (MAME 0.251 neogeo.zip)', () => {
  assert.deepEqual(neoGeoAesBios(entries('9036d879', 'a7aab458')), {
    bios: 'unibios',
    dips: [['BIOS', 'Universe BIOS (Hack, Ver. 4.0)'], ['Unibios mode', 'AES']],
  });
});

test('neither: null (the SDK refuses AES with a clear message)', () => {
  assert.equal(neoGeoAesBios(entries('9036d879', '16d0c132')), null); // MVS + AES Japan only
  assert.equal(neoGeoAesBios([]), null);
});
