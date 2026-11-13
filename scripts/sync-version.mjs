#!/usr/bin/env node
// Put one version in every place that carries one.
//
// The version lives twice: `package.json`, and the `static readonly version` of
// `FbneoSDK` in src/fbneo.sdk.ts — which is where the contract puts an
// engine's identity as of engine-specs 0.3.0, so a launcher reads
// `FbneoSDK.version` off the imported class. `npm version` only knows about the
// first, so a bump on its own ships a class claiming the previous release.
//
//   node scripts/sync-version.mjs           # take package.json as the truth
//   node scripts/sync-version.mjs 0.2.0     # set that version everywhere
//
// The release workflow calls the second form before building, so the artifacts
// carry the version that is about to be tagged; the first form is the local fix
// after editing package.json by hand.

import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const write = (rel, text) => writeFileSync(new URL(rel, root), text);

const die = (message) => {
  console.error(`sync-version: ${message}`);
  process.exit(1);
};

const requested = process.argv[2];
if (requested && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)) {
  die(`"${requested}" is not a version. Pass an exact one (0.2.0), not a bump keyword.`);
}

const pkg = JSON.parse(read('package.json'));
const version = requested ?? pkg.version;
const changed = [];

// --- package.json ------------------------------------------------------------
if (pkg.version !== version) {
  pkg.version = version;
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  changed.push('package.json');
}

// --- package-lock.json -------------------------------------------------------
// Two copies of the same field, and `npm ci` fails on a lockfile that disagrees
// with the manifest it locks.
const lock = JSON.parse(read('package-lock.json'));
if (lock.version !== version || lock.packages?.['']?.version !== version) {
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  changed.push('package-lock.json');
}

// --- src/fbneo.sdk.ts -------------------------------------------------------
// A string literal in a hand-written file, so this is a targeted rewrite rather
// than a regeneration. Anchored to the `static readonly` it is declared with,
// and asserted to match exactly once — a second one in this file means the
// anchor stopped being unambiguous and this script needs revisiting rather than
// guessing.
const sdkPath = 'src/fbneo.sdk.ts';
const source = read(sdkPath);
const pattern = /^(\s+static readonly version = ')([^']*)(';)$/gm;
const matches = [...source.matchAll(pattern)];

if (matches.length !== 1) {
  die(`expected exactly one \`static readonly version = '…'\` in ${sdkPath}, found ${matches.length}`);
}

if (matches[0][2] !== version) {
  write(sdkPath, source.replace(pattern, `$1${version}$3`));
  changed.push(sdkPath);
}

console.log(changed.length ? `sync-version: ${version} → ${changed.join(', ')}` : `sync-version: already at ${version}`);
