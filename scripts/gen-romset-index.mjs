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
// Systems listed in `LAYOUT_SYSTEMS` additionally get each ROM's *size* (`s`) and
// hardware *region* (`r`), which together describe the chip layout of a set. That
// is what the `neo` helper needs to rebuild a ROM set from a Neo Geo `.neo`
// flash-cart image, where every region arrives as one contiguous blob. Layout is
// opt-in per system because the region encoding is hardware-specific and the extra
// fields would otherwise inflate every dataset for no reader.
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

// Systems whose dataset also carries a chip layout, mapping the low bits of a ROM
// row's flags field to a hardware region name. On Neo Geo the flags start with the
// region index (`3 | BRF_GRA` is a C/sprite chip); rows outside this map (BIOS,
// the SMA custom chip, padding) get no region and no size.
const LAYOUT_SYSTEMS = {
  neogeo: { 1: 'P', 2: 'S', 3: 'C', 4: 'M', 5: 'V1', 6: 'V2' },
};

// A ROM row: { "name", 0xSIZE, 0xCRC, flags }, — capture name, size, crc, flags.
const ROM_ROW = /\{\s*"([^"]*)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*([^,}]*)/g;

/**
 * Drop C comments so commented-out ROM rows are not parsed as real chips.
 * FBNeo's tables carry plenty of block-commented alternates and undumped variants
 * sitting between live rows; counting them inflates a set's ROM total (so it can
 * never reach full coverage) and, worse, shifts every chip boundary for a layout.
 * String literals are tracked so a slash inside a ROM name survives.
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Normalize a numeric literal ("0x1a2b" | "4096") to a Number. */
function toNumber(lit) {
  return lit.startsWith('0x') || lit.startsWith('0X') ? parseInt(lit, 16) : parseInt(lit, 10);
}

/**
 * Extract every `<base>RomDesc[]` table in a source file -> { base: [{n,c}, ...] }.
 *
 * Without `regions` (the default) this is a pure identity list: rows with an
 * empty/NULL name or a zero CRC (nodump / "not required") are dropped, since
 * nothing in a zip can ever match them. With `regions`, rows are additionally
 * tagged with size and region and the zero-CRC ones are *kept* — a layout has to
 * describe every chip in order or the carve boundaries shift.
 */
function parseRomTables(text, regions = null) {
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
      if (!regions) {
        if (crc === '00000000') continue; // nodump / placeholder
        roms.push({ n: name, c: crc });
        continue;
      }
      const lead = /^(\d+)\b/.exec(r[4].trim());
      const region = lead ? regions[Number(lead[1])] : undefined;
      const rom = { n: name, c: crc, s: toNumber(r[2]) };
      if (region) rom.r = region;
      roms.push(rom);
    }
    if (roms.length) tables[base] = roms;
  }
  return tables;
}

// A driver: struct BurnDriver[BS|D...]? <symbol> = { "name", parent, "bios", ... };
// Field 1 is the short name, field 2 is the clone parent (NULL or "parent"), and
// somewhere in the body it references its ROM table as `<base>RomInfo`.
// The C symbol is conventionally `BurnDrv<X>`, but FBNeo is not consistent about
// it — the ZX Spectrum drivers are `BurnSpec<X>`, the Megadrive has `Burnmd_<X>`,
// and one-off homebrew entries use the bare set name (`midnight`) — so match any
// symbol and let the `= {` + `"name", parent,` shape do the filtering.
const DRIVER_HEAD = /struct\s+BurnDriver\w*\s+\w+\s*=\s*\{/g;

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
    // Then: board ("neogeo" BIOS set), sample set, year, full name, comment, maker.
    const str = '(NULL|"(?:[^"\\\\]|\\\\.)*")';
    const meta = new RegExp(`^\\s*"[^"]+"\\s*,\\s*${str}\\s*,\\s*${str}\\s*,\\s*${str}\\s*,\\s*${str}\\s*,\\s*${str}\\s*,\\s*${str}\\s*,\\s*${str}`).exec(body);
    const unquote = (lit) => (!lit || lit === 'NULL' ? null : lit.slice(1, -1).replace(/\\0$/, '').replace(/\\(.)/g, '$1').trim() || null);
    drivers.push({
      name: nameParent[1],
      parent: nameParent[3] ?? null,
      base: romInfo[1],
      year: unquote(meta?.[4]),
      title: unquote(meta?.[5]),
      maker: unquote(meta?.[7]),
      // Neo Geo: the first program ROM is stored on the cart with its two halves
      // swapped and FBNeo un-swaps it after loading (neogeo.cpp). Anything
      // rebuilding a set from raw cart data has to swap it back.
      swapP: /HARDWARE_SNK_SWAPP/.test(body),
    });
  }
  return drivers;
}

/** Build the per-system dataset for one source file's text. */
function buildFromText(text, regions = null) {
  const tables = parseRomTables(text, regions);
  const drivers = parseDrivers(text);
  const games = {};
  for (const d of drivers) {
    const roms = tables[d.base];
    if (!roms) continue; // driver references a table defined in another file
    games[d.name] = { parent: d.parent, roms };
    // What a library shows: FBNeo's own full name, year and maker for the set.
    if (d.title) games[d.name].t = d.title;
    if (d.year) games[d.name].y = d.year;
    if (d.maker) games[d.name].m = d.maker;
    if (regions && d.swapP) games[d.name].swapP = true;
  }
  return games;
}

// A system is a subdirectory of `src/burn/drv`. Driver files sitting at the root
// (only `d_parent.cpp`, "a module for keeping parents who have no driver") would
// otherwise be emitted as a bogus `drv` system of sets that cannot be booted.
function collectDriverFiles(dir, acc = [], depth = 0) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) collectDriverFiles(p, acc, depth + 1);
    else if (depth > 0 && /^d_.*\.cpp$/.test(entry)) acc.push(p);
  }
  return acc;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  // Map: system -> merged games across that system's driver files.
  const bySystem = new Map();
  const addFile = (path, system) => {
    const text = stripComments(readFileSync(path, 'utf8'));
    const games = buildFromText(text, LAYOUT_SYSTEMS[system] ?? null);
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
    writeFileSync(join(args.out, `${system}.json`), JSON.stringify(payload, null, 2));
    manifest.push({ system, games: count });
    console.error(`  ${system}: ${count} games`);
  }
  writeFileSync(join(args.out, 'index.json'), JSON.stringify({ systems: manifest }, null, 2));
  console.error(`Wrote ${manifest.length} systems, ${totalGames} games to ${args.out}`);
}

main();
