// Which game a ROM set is: the SDK's driverName() (options → name), and the app's
// identifyDriver() (bytes → name), against the built package and its own datasets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { driverName } from '../dist/fbneo/fbneo.sdk.js';
import { zipStore } from '../dist/fbneo/neo.js';

// The app module touches `document` only inside mount(), so it loads under node.
const { identifyDriver, mount, FIRST_SYSTEMS } = await import('../dist/fbneo/app/app.js');

const dataset = (system) => JSON.parse(readFileSync(new URL(`../dist/fbneo/romsets/${system}.json`, import.meta.url)));
const load = async (system) => dataset(system);

test('driverName: explicit driver wins, else the file stem', () => {
  assert.equal(driverName({ driver: ' mslug ', romFileName: 'x.zip' }), 'mslug');
  assert.equal(driverName({ romFileName: 'kof98.zip' }), 'kof98');
  assert.equal(driverName({ romFileName: 'C:\\roms\\sf2.7z' }), 'sf2');
  assert.equal(driverName({ romFileName: '/a/b/MSLUG.ZIP' }), 'MSLUG');
  assert.equal(driverName({}), '');
});

test('the app is an EngineApp, searching the common systems first', () => {
  assert.equal(typeof mount, 'function');
  assert.equal(FIRST_SYSTEMS[0], 'neogeo');
});

// A zip whose entries carry a real set's names and CRC-32s is what the matcher reads
// (the central directory), so a stored zip of fake data with those CRCs is not needed:
// build one whose *declared* CRCs come from the dataset by writing data that hashes to
// them is impossible — instead, take a set from the dataset and check the lookup path
// with a zip of its exact entry list by patching CRCs into a stored archive.
function zipWithCrcs(entries) {
  const zip = zipStore(entries.map(({ name }) => ({ name, data: new Uint8Array(1) })));
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Rewrite the CRC-32 of each central-directory entry (signature 0x02014b50, CRC at +16).
  let i = 0;
  for (let p = 0; p + 4 <= zip.length; p++) {
    if (view.getUint32(p, true) === 0x02014b50) view.setUint32(p + 16, parseInt(entries[i++].crc, 16) >>> 0, true);
  }
  assert.equal(i, entries.length);
  return zip;
}

test('identifyDriver: a zip is matched by the CRC-32s inside it, whatever its name', async () => {
  const neogeo = dataset('neogeo');
  const [driver, game] = Object.entries(neogeo.games).find(([, g]) => g.roms?.length > 3 && !g.parent) ?? [];
  assert.ok(driver, 'a Neo Geo set to try');
  const zip = zipWithCrcs(game.roms.filter((r) => /^[0-9a-f]{8}$/.test(r.c)).map((r) => ({ name: r.n, crc: r.c })));
  const result = await identifyDriver(zip, { slug: 'whatever', load, systems: async () => ['neogeo'] });
  assert.equal(result.how, 'content');
  assert.equal(result.driver, driver);
  assert.equal(result.rom, zip);
});

test('identifyDriver: nothing matching falls back to the slug; missing datasets are skipped', async () => {
  const zip = zipStore([{ name: 'nothing.bin', data: new Uint8Array([1, 2, 3]) }]);
  const failing = async (system) => {
    if (system === 'capcom') throw new Error('offline');
    return dataset(system);
  };
  const result = await identifyDriver(zip, { slug: 'mslug', load: failing, systems: async () => ['capcom', 'cave'] });
  assert.deepEqual({ driver: result.driver, how: result.how }, { driver: 'mslug', how: 'slug' });
});
