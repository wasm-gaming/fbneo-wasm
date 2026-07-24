#!/usr/bin/env node
// Generate the romset-identity dataset from FBNeo's driver source.
//
// FBNeo identifies a game by a ROM-set "short name" (the driver, e.g. `mslug`),
// which the SDK normally derives from the ROM zip's filename. When that filename
// is unreliable (`mslug (1).zip`, a browser-mangled download), the driver can
// instead be recovered from the *contents* of the zip: every ROM chip dump inside
// carries a CRC-32, and FBNeo's driver tables declare the exact CRC-32 of each
// ROM it expects. This script extracts those tables and emits, per system, a JSON
// map of driver -> the CRC-32s of its ROMs, which `resolveDriver()` matches
// against the CRC-32s stored in a zip's central directory.
//
// Source of truth: the `BurnRomInfo <base>RomDesc[]` tables and `BurnDriver`
// structs in `src/burn/drv/<system>/d_*.cpp`. Parsing the source (rather than a
// built binary's DAT export) keeps generation deterministic and independent of a
// working WASM/native build. Run against the same FBNeo checkout that is compiled
// so the dataset stays in lockstep with the core.
//
// Usage:
//   node scripts/gen-romset-index.mjs --src <fbneo>/src/burn/drv --out data/romsets
//   node scripts/gen-romset-index.mjs --file d_neogeo.cpp --system neogeo --out /tmp
//
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

function parseArgs(argv) {
  const args = { src: null, out: 'data/romsets', files: [], system: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') args.src = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--system') args.system = argv[++i];
    else if (a === '--file') args.files.push(argv[++i]);
  }
  return args;
}

/** Normalize a numeric literal ("0x1a2b" | "4096") to a lowercase 8-hex CRC string. */
function toCrc(lit) {
  const n = lit.startsWith('0x') || lit.startsWith('0X') ? parseInt(lit, 16) : parseInt(lit, 10);
  return (n >>> 0).toString(16).padStart(8, '0');
}

// A ROM row: { "name", 0xSIZE, 0xCRC, flags }, — capture name, size, crc.
// Rows with an empty/NULL name or a zero CRC (nodump / "not required") are skipped.
const ROM_ROW = /\{\s*"([^"]*)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,/g;

/** Extract every `<base>RomDesc[]` table in a source file -> { base: [{n,c}, ...] }. */
function parseRomTables(text) {
  const tables = {};
  const head = /static\s+struct\s+BurnRomInfo\s+(\w+)RomDesc\s*\[\s*\]\s*=\s*\{/g;
  let m;
  while ((m = head.exec(text))) {
    const base = m[1];
    // Walk braces from the opening `{` to find the matching close of the array.
    let depth = 1;
    let i = head.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = text.slice(head.lastIndex, i - 1);
    const roms = [];
    let r;
    ROM_ROW.lastIndex = 0;
    while ((r = ROM_ROW.exec(body))) {
      const name = r[1];
      const crc = toCrc(r[3]);
      if (!name || name === 'NULL') continue;
      if (crc === '00000000') continue; // nodump / placeholder
      roms.push({ n: name, c: crc });
    }
    if (roms.length) tables[base] = roms;
  }
  return tables;
}

// A driver: struct BurnDriver[BS|D...]? BurnDrv<X> = { "name", parent, "bios", ... };
// Field 1 is the short name, field 2 is the clone parent (NULL or "parent"), and
// somewhere in the body it references its ROM table as `<base>RomInfo`.
const DRIVER_HEAD = /struct\s+BurnDriver\w*\s+BurnDrv\w+\s*=\s*\{/g;

function parseDrivers(text) {
  const drivers = [];
  let m;
  while ((m = DRIVER_HEAD.exec(text))) {
    let depth = 1;
    let i = DRIVER_HEAD.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = text.slice(DRIVER_HEAD.lastIndex, i - 1);
    const nameParent = /^\s*"([^"]+)"\s*,\s*(NULL|"([^"]+)")\s*,/m.exec(body);
    if (!nameParent) continue;
    const romInfo = /(\w+)RomInfo\b/.exec(body);
    if (!romInfo) continue;
    drivers.push({
      name: nameParent[1],
      parent: nameParent[3] ?? null,
      base: romInfo[1],
    });
  }
  return drivers;
}

/** Build the per-system dataset for one source file's text. */
function buildFromText(text) {
  const tables = parseRomTables(text);
  const drivers = parseDrivers(text);
  const games = {};
  for (const d of drivers) {
    const roms = tables[d.base];
    if (!roms) continue; // driver references a table defined in another file
    games[d.name] = { parent: d.parent, roms };
  }
  return games;
}

function collectDriverFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) collectDriverFiles(p, acc);
    else if (/^d_.*\.cpp$/.test(entry)) acc.push(p);
  }
  return acc;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  // Map: system -> merged games across that system's driver files.
  const bySystem = new Map();
  const addFile = (path, system) => {
    const text = readFileSync(path, 'utf8');
    const games = buildFromText(text);
    const bucket = bySystem.get(system) ?? {};
    Object.assign(bucket, games);
    bySystem.set(system, bucket);
  };

  if (args.files.length) {
    for (const f of args.files) addFile(f, args.system ?? basename(dirname(f)));
  } else if (args.src) {
    for (const f of collectDriverFiles(args.src)) addFile(f, basename(dirname(f)));
  } else {
    console.error('error: pass --src <drv dir> or --file <d_*.cpp> --system <name>');
    process.exit(1);
  }

  const manifest = [];
  let totalGames = 0;
  for (const [system, games] of [...bySystem].sort()) {
    const count = Object.keys(games).length;
    if (!count) continue;
    totalGames += count;
    const payload = { system, games };
    writeFileSync(join(args.out, `${system}.json`), JSON.stringify(payload));
    manifest.push({ system, games: count });
    console.error(`  ${system}: ${count} games`);
  }
  writeFileSync(join(args.out, 'index.json'), JSON.stringify({ systems: manifest }, null, 2));
  console.error(`Wrote ${manifest.length} systems, ${totalGames} games to ${args.out}`);
}

main();
