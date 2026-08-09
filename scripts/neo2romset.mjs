#!/usr/bin/env node
// Convert a Neo Geo `.neo` file (the NeoSD / Terraonion flash-cart format) into
// the FBNeo ROM set zip the emulator can actually boot.
//
// FBNeo — like MAME — only reads `<driver>.zip` / `<driver>.7z` holding the
// individual *chip* dumps (p1, s1, c1..cN, m1, v1..vN). A `.neo` is the opposite
// packaging: a 4096-byte header followed by each region as one contiguous blob,
// with the C (sprite) region byte-interleaved the way the cartridge wires it. So
// a `.neo` can never be handed to the engine directly — but every byte FBNeo
// wants is in there, and this script rebuilds the chip split.
//
//   header: "NEO1" | P size | S size | M size | V1 size | V2 size | C size | year | ...
//   data:   P | S | M | V1 | V2 | C          (C = even bytes -> c1, odd -> c2)
//
// The chip layout (how many chips per region and how big each one is) lives in
// FBNeo's own `BurnRomInfo` tables, so this reads them from a FBNeo checkout —
// the same source of truth `make romsets` uses. The driver is identified by
// matching the `.neo` header's region sizes against those tables, and every
// carved chip is CRC-32 verified against the table before the zip is written:
// if a set needs a layout this simple carve cannot reproduce (some SMA-protected
// games reorder their program ROM), the script says so instead of writing a
// broken zip.
//
// Usage:
//   node scripts/neo2romset.mjs <file.neo> [--out <dir>] [--driver <name>]
//                               [--src <fbneo>/src/burn/drv/neogeo/d_neogeo.cpp]
//
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { deflateRawSync } from 'node:zlib';

const DEFAULT_SRC = '.tmp/fbneo-build/src/burn/drv/neogeo/d_neogeo.cpp';

// BurnRomInfo region codes (low nibble of the type field) for Neo Geo sets.
const REGION = { 1: 'P', 2: 'S', 3: 'C', 4: 'M', 5: 'V1', 6: 'V2' };

function parseArgs(argv) {
  const args = { neo: null, out: '.', driver: null, src: DEFAULT_SRC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--driver') args.driver = argv[++i];
    else if (a === '--src') args.src = argv[++i];
    else if (!args.neo) args.neo = a;
  }
  return args;
}

function crcHex(buf) {
  return (crc32(buf) >>> 0).toString(16).padStart(8, '0');
}

/** Read a `.neo` file into its header sizes and per-region byte ranges. */
function parseNeo(buf) {
  if (buf.toString('latin1', 0, 3) !== 'NEO') {
    throw new Error('not a .neo file (missing NEO magic)');
  }
  const u32 = (o) => buf.readUInt32LE(o);
  const sizes = { P: u32(4), S: u32(8), M: u32(12), V1: u32(16), V2: u32(20), C: u32(24) };
  const name = buf.toString('latin1', 0x2c, 0x2c + 33).replace(/\0.*$/, '');
  const regions = {};
  let off = 4096; // header is a fixed 4 KiB block
  for (const k of ['P', 'S', 'M', 'V1', 'V2', 'C']) {
    regions[k] = buf.subarray(off, off + sizes[k]);
    off += sizes[k];
  }
  if (off !== buf.length) {
    throw new Error(`.neo size mismatch: header describes ${off} bytes, file is ${buf.length}`);
  }
  return { sizes, regions, name };
}

/** Extract every `<base>RomDesc[]` table (name, size, crc, region) from FBNeo source. */
function parseRomTables(text) {
  const tables = {};
  const head = /static\s+struct\s+BurnRomInfo\s+(\w+)RomDesc\s*\[\s*\]\s*=\s*\{/g;
  const row = /\{\s*"([^"]*)"\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(\d+)/g;
  let m;
  while ((m = head.exec(text))) {
    let depth = 1;
    let i = head.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    const body = text.slice(head.lastIndex, i - 1);
    const roms = [];
    row.lastIndex = 0;
    let r;
    while ((r = row.exec(body))) {
      const region = REGION[Number(r[4])];
      if (!r[1] || !region) continue;
      roms.push({
        name: r[1],
        size: Number(r[2]),
        crc: (Number(r[3]) >>> 0).toString(16).padStart(8, '0'),
        region,
      });
    }
    if (roms.length) tables[m[1]] = roms;
  }
  return tables;
}

/** Map driver short name -> its ROM table (`struct BurnDriver <sym> = { "name", ... }`). */
function parseDrivers(text, tables) {
  const drivers = new Map();
  const head = /struct\s+BurnDriver\w*\s+\w+\s*=\s*\{/g;
  let m;
  while ((m = head.exec(text))) {
    let depth = 1;
    let i = head.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    const body = text.slice(head.lastIndex, i - 1);
    const name = /^\s*"([^"]+)"\s*,/m.exec(body);
    const romInfo = /(\w+)RomInfo\b/.exec(body);
    if (!name || !romInfo || !tables[romInfo[1]]) continue;
    drivers.set(name[1], {
      roms: tables[romInfo[1]],
      // On these carts the first program ROM has its two halves swapped; FBNeo
      // undoes that after loading (neogeo.cpp, HARDWARE_SNK_SWAPP), so a .neo —
      // which stores the cart's own order — has to be swapped back to match the
      // dump's CRC.
      swapP: /HARDWARE_SNK_SWAPP/.test(body),
    });
  }
  return drivers;
}

/** Total bytes each region occupies in a driver's chip table. */
function regionSizes(roms) {
  const sums = { P: 0, S: 0, M: 0, V1: 0, V2: 0, C: 0 };
  for (const r of roms) sums[r.region] += r.size;
  return sums;
}

/**
 * Carve a driver's chip files out of the `.neo` regions.
 * C chips come in even/odd pairs sharing one interleaved slice of the C region;
 * every other region is a straight sequential split.
 */
function carve(roms, regions, swapP = false) {
  const cursor = { P: 0, S: 0, M: 0, V1: 0, V2: 0, C: 0 };
  const out = [];
  for (let i = 0; i < roms.length; i++) {
    const r = roms[i];
    if (r.region !== 'C') {
      let data = regions[r.region].subarray(cursor[r.region], cursor[r.region] + r.size);
      if (swapP && r.region === 'P' && cursor.P === 0) {
        const half = r.size >> 1;
        data = Buffer.concat([data.subarray(half), data.subarray(0, half)]);
      }
      out.push({ ...r, data });
      cursor[r.region] += r.size;
      continue;
    }
    // Interleaved pair: this chip supplies the even bytes, the next one the odd.
    const mate = roms[i + 1];
    if (!mate || mate.region !== 'C' || mate.size !== r.size) {
      throw new Error(`unpaired C ROM "${r.name}" — cannot de-interleave sprite data`);
    }
    const slice = regions.C.subarray(cursor.C, cursor.C + r.size * 2);
    cursor.C += r.size * 2;
    const even = Buffer.alloc(r.size);
    const odd = Buffer.alloc(r.size);
    for (let b = 0; b < r.size; b++) {
      even[b] = slice[2 * b];
      odd[b] = slice[2 * b + 1];
    }
    out.push({ ...r, data: even }, { ...mate, data: odd });
    i++;
  }
  return out;
}

/** Minimal deflate zip writer (no dependencies). */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1');
    const body = deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt32LE(0, 10); // dos time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.neo) {
    console.error('usage: node scripts/neo2romset.mjs <file.neo> [--out <dir>] [--driver <name>] [--src <d_neogeo.cpp>]');
    process.exit(1);
  }

  const neo = parseNeo(readFileSync(args.neo));
  console.error(`${basename(args.neo)}: "${neo.name}"`);
  console.error(
    '  regions: ' +
      Object.entries(neo.sizes)
        .map(([k, v]) => `${k}=0x${v.toString(16)}`)
        .join(' '),
  );

  let src;
  try {
    src = readFileSync(args.src, 'utf8');
  } catch {
    console.error(`error: FBNeo driver source not found at ${args.src}`);
    console.error("       run 'make build-wasm-ci' first, or pass --src <fbneo>/src/burn/drv/neogeo/d_neogeo.cpp");
    process.exit(1);
  }
  const drivers = parseDrivers(src, parseRomTables(src));

  // Candidates: drivers whose chip table adds up to exactly this .neo's regions.
  const candidates = [];
  for (const [name, drv] of drivers) {
    if (args.driver && name !== args.driver) continue;
    const sums = regionSizes(drv.roms);
    if (Object.keys(neo.sizes).every((k) => sums[k] === neo.sizes[k])) candidates.push({ name, ...drv });
  }
  if (!candidates.length) {
    console.error('error: no FBNeo driver matches these region sizes — this .neo is not a set FBNeo knows.');
    process.exit(2);
  }

  // Verify by CRC; a size match alone can be ambiguous between a set and its clones.
  const failures = [];
  for (const cand of candidates) {
    let carved;
    try {
      carved = carve(cand.roms, neo.regions, cand.swapP);
    } catch (e) {
      failures.push(`${cand.name}: ${e.message}`);
      continue;
    }
    const bad = carved.filter((c) => crcHex(c.data) !== c.crc);
    if (bad.length) {
      failures.push(`${cand.name}: ${bad.length}/${carved.length} chips CRC-mismatched (${bad.map((b) => b.name).join(', ')})`);
      continue;
    }
    mkdirSync(args.out, { recursive: true });
    const dest = join(args.out, `${cand.name}.zip`);
    writeFileSync(dest, makeZip(carved.map((c) => ({ name: c.name, data: c.data }))));
    console.error(`  driver: ${cand.name} — ${carved.length} chips, all CRC-verified`);
    console.error(`  wrote:  ${dest}`);
    console.error('  Neo Geo sets also need a neogeo.zip BIOS alongside this file.');
    process.exit(0);
  }

  console.error('error: matched driver(s) by size but not by content:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(3);
}

main();
