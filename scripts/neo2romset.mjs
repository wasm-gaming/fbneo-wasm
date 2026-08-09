#!/usr/bin/env node
// Convert a Neo Geo `.neo` file (the NeoSD / Terraonion flash-cart format) into
// the FBNeo ROM set zip the emulator can actually boot.
//
// This is a thin CLI over `src/neo.ts` — the same conversion the browser runs via
// the `@wasm-gaming/fbneo-wasm/neo` export, so a `.neo` that works in the demo
// works here and vice versa. The chip layout comes from `data/romsets/neogeo.json`
// (generated from FBNeo's own `BurnRomInfo` tables by `make romsets`), so no FBNeo
// checkout is needed; every carved chip is CRC-32 verified before the zip is
// written.
//
// Usage:
//   node scripts/neo2romset.mjs <file.neo> [--out <dir>] [--driver <name>]
//                               [--dataset <path/to/neogeo.json>]
//
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATASET = join(ROOT, 'data/romsets/neogeo.json');
const NEO_MODULE = join(ROOT, 'dist/fbneo/neo.js');

function parseArgs(argv) {
  const args = { neo: null, out: '.', driver: null, dataset: DEFAULT_DATASET };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--driver') args.driver = argv[++i];
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (!args.neo) args.neo = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.neo) {
  console.error(
    'usage: node scripts/neo2romset.mjs <file.neo> [--out <dir>] [--driver <name>] [--dataset <neogeo.json>]',
  );
  process.exit(1);
}

let neoToRomset;
try {
  ({ neoToRomset } = await import(NEO_MODULE));
} catch {
  console.error(`error: ${NEO_MODULE} not found — run 'make build-lib' first.`);
  process.exit(1);
}

const dataset = JSON.parse(readFileSync(args.dataset, 'utf8'));
const bytes = new Uint8Array(readFileSync(args.neo));

let result;
try {
  result = neoToRomset(bytes, dataset, args.driver ? { driver: args.driver } : {});
} catch (err) {
  console.error(`${basename(args.neo)}: ${err.message}`);
  process.exit(2);
}

const { driver, info, chips, zip } = result;
console.error(`${basename(args.neo)}: "${info.name}" (${info.manufacturer}, ${info.year})`);
console.error(
  '  regions: ' +
    Object.entries(info.sizes)
      .map(([k, v]) => `${k}=0x${v.toString(16)}`)
      .join(' '),
);

mkdirSync(args.out, { recursive: true });
const dest = join(args.out, `${driver}.zip`);
writeFileSync(dest, zip);
console.error(`  driver: ${driver} — ${chips.length} chips, all CRC-verified`);
console.error(`  wrote:  ${dest} (${zip.length.toLocaleString()} bytes, stored)`);
console.error('  Neo Geo sets also need a neogeo.zip BIOS alongside this file.');
