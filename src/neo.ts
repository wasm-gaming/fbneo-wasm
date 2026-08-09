// Opt-in helper: turn a Neo Geo `.neo` file (the NeoSD / Terraonion flash-cart
// image) into the FBNeo ROM-set zip the core can actually boot — in the browser,
// with no dependencies.
//
// FBNeo — like MAME — only reads `<driver>.zip` / `<driver>.7z` holding the
// individual *chip* dumps (p1, s1, c1..cN, m1, v1..vN). A `.neo` is the opposite
// packaging: a 4096-byte header followed by each region as one contiguous blob,
// with the C (sprite) region byte-interleaved the way the cartridge wires it. So
// a `.neo` can never be handed to the engine directly — but every byte FBNeo
// wants is in there, and this module rebuilds the chip split:
//
//   header: "NEO1" | P size | S size | M size | V1 size | V2 size | C size | ...
//   data:   P | S | M | V1 | V2 | C          (C = even bytes -> c1, odd -> c2)
//
// The chip layout (how many chips per region and how big each one is) comes from
// the same `data/romsets/neogeo.json` dataset the `romset` helper uses for
// content identity: for systems that need it, `gen-romset-index.mjs` records each
// ROM's size (`s`) and region (`r`) alongside its CRC-32. The driver is
// identified by matching the `.neo` header's region sizes against those layouts,
// and every carved chip is CRC-32 verified before a zip is written — if a set
// needs a layout this simple carve cannot reproduce (some SMA-protected games
// store their program ROM inside the custom chip), this throws rather than hand
// the engine a silently broken zip.
//
// @example
// const neogeo = await fetch('/romsets/neogeo.json').then((r) => r.json());
// if (isNeoFile(bytes)) {
//   const { driver, zip } = neoToRomset(bytes, neogeo);
//   await engine.load({ ...config, assets: { ...assets, rom: zip }, options: { driver } });
// }

import type { RomsetGame, RomsetSystem } from './romset.js';

/** A Neo Geo cartridge region, in the order a `.neo` file stores them. */
export type NeoRegion = 'P' | 'S' | 'M' | 'V1' | 'V2' | 'C';

/** The regions in `.neo` file order — the order the blobs follow the header. */
export const NEO_REGIONS: readonly NeoRegion[] = ['P', 'S', 'M', 'V1', 'V2', 'C'];

/** Header fields of a `.neo` file. */
export interface NeoInfo {
  /** Cartridge title from the header's `Name[33]` field. */
  name: string;
  /** Manufacturer from the header's `Manu[17]` field. */
  manufacturer: string;
  year: number;
  /** Bytes each region occupies in the file. */
  sizes: Record<NeoRegion, number>;
}

/** A parsed `.neo` file: its header plus a view over each region's bytes. */
export interface NeoFile extends NeoInfo {
  /** Views into the source buffer — no copying. */
  regions: Record<NeoRegion, Uint8Array>;
}

/** One chip carved out of a `.neo`, ready to become a zip entry. */
export interface NeoChip {
  /** Internal ROM name FBNeo expects (e.g. `201-c1.c1`). */
  name: string;
  /** Lowercase 8-hex CRC-32 of `data`, verified against the driver table. */
  crc: string;
  region: NeoRegion;
  data: Uint8Array;
}

/** The result of a successful conversion. */
export interface NeoRomset {
  /** FBNeo driver short name — pass as `options.driver`. */
  driver: string;
  system: string;
  /** Clone parent's driver name, or `null` for a parent set. */
  parent: string | null;
  info: NeoInfo;
  chips: NeoChip[];
  /**
   * The rebuilt ROM set as a *stored* (uncompressed) zip — feed as `assets.rom`.
   * Deflating would only be undone by FBNeo on the next line, so the bytes are
   * stored: the conversion stays synchronous and costs no extra CPU.
   */
  zip: Uint8Array;
}

export interface NeoToRomsetOptions {
  /** Force a driver instead of matching the header's region sizes against every set. */
  driver?: string;
}

const NEO_HEADER_SIZE = 4096;
const NAME_OFFSET = 0x2c;
const NAME_LENGTH = 33;
const MANUFACTURER_OFFSET = 0x4d;
const MANUFACTURER_LENGTH = 17;

/** Cheap sniff: does this look like a `.neo` flash-cart image? */
export function isNeoFile(bytes: Uint8Array): boolean {
  return (
    bytes.length > NEO_HEADER_SIZE &&
    bytes[0] === 0x4e /* N */ &&
    bytes[1] === 0x45 /* E */ &&
    bytes[2] === 0x4f /* O */
  );
}

/**
 * Read a `.neo` file's header and slice out each region.
 *
 * @throws if the magic is missing or the file is shorter than its header describes.
 */
export function parseNeo(bytes: Uint8Array): NeoFile {
  if (!isNeoFile(bytes)) throw new Error('neo: not a .neo file (missing NEO magic)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Region sizes are six consecutive LE uint32s, but the header stores them in
  // P S M V1 V2 C order while the C blob is written last — same order here.
  const sizes = {
    P: view.getUint32(4, true),
    S: view.getUint32(8, true),
    M: view.getUint32(12, true),
    V1: view.getUint32(16, true),
    V2: view.getUint32(20, true),
    C: view.getUint32(24, true),
  } satisfies Record<NeoRegion, number>;

  const regions = {} as Record<NeoRegion, Uint8Array>;
  let offset = NEO_HEADER_SIZE;
  for (const region of NEO_REGIONS) {
    const end = offset + sizes[region];
    if (end > bytes.length) {
      throw new Error(
        `neo: truncated file — header describes ${end} bytes through region ${region}, ` +
          `file is ${bytes.length}`,
      );
    }
    regions[region] = bytes.subarray(offset, end);
    offset = end;
  }

  return {
    name: cString(bytes, NAME_OFFSET, NAME_LENGTH),
    manufacturer: cString(bytes, MANUFACTURER_OFFSET, MANUFACTURER_LENGTH),
    year: view.getUint32(28, true),
    sizes,
    regions,
  };
}

/** Read a fixed-width NUL-padded latin-1 string field. */
function cString(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = Math.min(start + length, bytes.length);
  while (end < limit && bytes[end] !== 0) end++;
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * Rebuild an FBNeo ROM set from a `.neo` file.
 *
 * @param bytes    The raw `.neo` bytes.
 * @param datasets One or more romset datasets carrying chip layouts (`s`/`r` per
 *                 ROM) — in practice `data/romsets/neogeo.json`.
 * @throws if no driver's chip layout matches the header's region sizes, or if
 *         every size-matched candidate fails CRC-32 verification.
 */
export function neoToRomset(
  bytes: Uint8Array,
  datasets: RomsetSystem | readonly RomsetSystem[],
  options: NeoToRomsetOptions = {},
): NeoRomset {
  const neo = parseNeo(bytes);
  const systems: readonly RomsetSystem[] = Array.isArray(datasets)
    ? (datasets as readonly RomsetSystem[])
    : [datasets as RomsetSystem];

  // Candidates: drivers whose chip layout adds up to exactly this .neo's regions.
  // A size match alone can be ambiguous between a set and its clones, so this is
  // only a filter — the CRC check below decides. Parents are tried first so the
  // canonical boot name wins when a clone is byte-identical.
  const candidates: { system: string; driver: string; game: RomsetGame }[] = [];
  for (const system of systems) {
    for (const [driver, game] of Object.entries(system.games)) {
      if (options.driver ? driver !== options.driver : !layoutMatchesSizes(game, neo.sizes)) continue;
      candidates.push({ system: system.system, driver, game });
    }
  }
  candidates.sort(
    (a, b) =>
      Number(a.game.parent === null) - Number(b.game.parent === null) ||
      a.driver.localeCompare(b.driver),
  );

  if (!candidates.length) {
    throw new Error(
      options.driver
        ? `neo: driver "${options.driver}" is not in the supplied dataset(s)`
        : `neo: no driver matches this file's region sizes ` +
          `(${NEO_REGIONS.map((r) => `${r}=0x${neo.sizes[r].toString(16)}`).join(' ')}) — ` +
          'not a Neo Geo set this FBNeo build knows',
    );
  }

  const failures: string[] = [];
  for (const { system, driver, game } of candidates) {
    let carved: CarvedChip[];
    try {
      carved = carve(game, neo.regions);
    } catch (err) {
      failures.push(`${driver}: ${(err as Error).message}`);
      continue;
    }
    // Every chip must hash to the CRC-32 the driver table declares. This is what
    // separates a real match from a set that merely happens to share region sizes,
    // and what catches layouts this straight carve cannot reproduce.
    const chips: NeoChip[] = carved.map((chip) => ({
      name: chip.name,
      region: chip.region,
      data: chip.data,
      crc: crc32Hex(chip.data),
    }));
    const bad = chips.filter((chip, i) => chip.crc !== carved[i]!.expected);
    if (bad.length) {
      failures.push(
        `${driver}: ${bad.length}/${chips.length} chips CRC-mismatched ` +
          `(${bad.slice(0, 4).map((c) => c.name).join(', ')}${bad.length > 4 ? ', …' : ''})`,
      );
      continue;
    }
    return {
      driver,
      system,
      parent: game.parent,
      info: { name: neo.name, manufacturer: neo.manufacturer, year: neo.year, sizes: neo.sizes },
      chips,
      zip: zipStore(chips),
    };
  }

  throw new Error(
    `neo: matched ${candidates.length} driver(s) by size but none by content:\n  ${failures.join('\n  ')}`,
  );
}

/** The chips of a game's layout, in table order. Sets without layout data yield none. */
function layoutChips(game: RomsetGame): { n: string; c: string; s: number; r: NeoRegion }[] {
  const out: { n: string; c: string; s: number; r: NeoRegion }[] = [];
  for (const rom of game.roms) {
    // Rows outside the six cartridge regions (BIOS, the SMA custom chip, padding)
    // carry no `r` and occupy no bytes in a .neo — skip without moving any cursor.
    if (rom.r === undefined || rom.s === undefined) continue;
    if (!NEO_REGIONS.includes(rom.r as NeoRegion)) continue;
    out.push({ n: rom.n, c: rom.c, s: rom.s, r: rom.r as NeoRegion });
  }
  return out;
}

function layoutMatchesSizes(game: RomsetGame, sizes: Record<NeoRegion, number>): boolean {
  const chips = layoutChips(game);
  if (!chips.length) return false;
  const sums: Record<NeoRegion, number> = { P: 0, S: 0, M: 0, V1: 0, V2: 0, C: 0 };
  for (const chip of chips) sums[chip.r] += chip.s;
  return NEO_REGIONS.every((r) => sums[r] === sizes[r]);
}

/** A chip sliced out of the blobs, carrying the CRC-32 its driver table expects. */
interface CarvedChip {
  name: string;
  region: NeoRegion;
  data: Uint8Array;
  /** CRC-32 from the driver table — what `data` has to hash to. */
  expected: string;
}

/**
 * Carve a driver's chip files out of the `.neo` regions.
 *
 * C chips come in even/odd pairs sharing one interleaved slice of the C region;
 * every other region is a straight sequential split.
 */
function carve(game: RomsetGame, regions: Record<NeoRegion, Uint8Array>): CarvedChip[] {
  const layout = layoutChips(game);
  const cursor: Record<NeoRegion, number> = { P: 0, S: 0, M: 0, V1: 0, V2: 0, C: 0 };
  const out: CarvedChip[] = [];

  // Size matching normally guarantees the cursors land exactly on each region's
  // end, but a forced `options.driver` can ask for a layout that overruns — and
  // `subarray` would clamp rather than complain, leaving a short chip to fail CRC
  // for a misleading reason.
  const take = (region: NeoRegion, length: number): Uint8Array => {
    const start = cursor[region];
    if (start + length > regions[region].length) {
      throw new Error(
        `region ${region} is ${regions[region].length} bytes, layout needs at least ${start + length}`,
      );
    }
    cursor[region] = start + length;
    return regions[region].subarray(start, start + length);
  };

  for (let i = 0; i < layout.length; i++) {
    const rom = layout[i]!;

    if (rom.r !== 'C') {
      const first = cursor[rom.r] === 0;
      let data = take(rom.r, rom.s);
      if (game.swapP && rom.r === 'P' && first) {
        // On these carts the first program ROM has its two halves swapped; FBNeo
        // undoes that after loading (neogeo.cpp, HARDWARE_SNK_SWAPP), so a .neo —
        // which stores the cart's own order — has to be swapped back to match the
        // dump's CRC.
        const half = rom.s >> 1;
        const swapped = new Uint8Array(rom.s);
        swapped.set(data.subarray(half), 0);
        swapped.set(data.subarray(0, half), rom.s - half);
        data = swapped;
      }
      out.push({ name: rom.n, expected: rom.c, region: rom.r, data });
      continue;
    }

    // Interleaved pair: this chip supplies the even bytes, the next one the odd.
    const mate = layout[i + 1];
    if (!mate || mate.r !== 'C' || mate.s !== rom.s) {
      throw new Error(`unpaired C ROM "${rom.n}" — cannot de-interleave sprite data`);
    }
    const slice = take('C', rom.s * 2);
    const even = new Uint8Array(rom.s);
    const odd = new Uint8Array(rom.s);
    for (let b = 0; b < rom.s; b++) {
      even[b] = slice[2 * b]!;
      odd[b] = slice[2 * b + 1]!;
    }
    out.push(
      { name: rom.n, expected: rom.c, region: 'C', data: even },
      { name: mate.n, expected: mate.c, region: 'C', data: odd },
    );
    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// CRC-32 and a minimal stored-zip writer
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return (crcTable = table);
}

/** CRC-32 (IEEE, the one zip and FBNeo's ROM tables use) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Lowercase 8-hex CRC-32, the form the romset dataset stores. */
export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0');
}

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const DOS_EPOCH_DATE = 0x0021; // 1980-01-01, the earliest date the format can express

/**
 * Build a zip with every entry *stored* (method 0).
 *
 * FBNeo decompresses each chip straight into its ROM buffer, so deflating here
 * would just be undone a moment later; storing keeps this synchronous (no
 * `CompressionStream`) and costs one pass over the data.
 */
export function zipStore(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const names = entries.map((e) => latin1(e.name));
  const crcs = entries.map((e) => crc32(e.data));

  let localSize = 0;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) {
    localSize += 30 + names[i]!.length + entries[i]!.data.length;
    centralSize += 46 + names[i]!.length;
  }

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let p = 0;

  for (let i = 0; i < entries.length; i++) {
    const { data } = entries[i]!;
    const name = names[i]!;
    offsets.push(p);
    view.setUint32(p, LFH_SIG, true);
    view.setUint16(p + 4, 10, true); // version needed: 1.0 (stored)
    view.setUint16(p + 6, 0, true); // flags
    view.setUint16(p + 8, 0, true); // method: stored
    view.setUint16(p + 10, 0, true); // dos time
    view.setUint16(p + 12, DOS_EPOCH_DATE, true);
    view.setUint32(p + 14, crcs[i]!, true);
    view.setUint32(p + 18, data.length, true); // compressed size
    view.setUint32(p + 22, data.length, true); // uncompressed size
    view.setUint16(p + 26, name.length, true);
    view.setUint16(p + 28, 0, true); // extra length
    out.set(name, p + 30);
    out.set(data, p + 30 + name.length);
    p += 30 + name.length + data.length;
  }

  const centralStart = p;
  for (let i = 0; i < entries.length; i++) {
    const { data } = entries[i]!;
    const name = names[i]!;
    view.setUint32(p, CDH_SIG, true);
    view.setUint16(p + 4, 10, true); // version made by
    view.setUint16(p + 6, 10, true); // version needed
    view.setUint16(p + 8, 0, true); // flags
    view.setUint16(p + 10, 0, true); // method: stored
    view.setUint16(p + 12, 0, true); // dos time
    view.setUint16(p + 14, DOS_EPOCH_DATE, true);
    view.setUint32(p + 16, crcs[i]!, true);
    view.setUint32(p + 20, data.length, true);
    view.setUint32(p + 24, data.length, true);
    view.setUint16(p + 28, name.length, true);
    view.setUint16(p + 30, 0, true); // extra length
    view.setUint16(p + 32, 0, true); // comment length
    view.setUint16(p + 34, 0, true); // disk number
    view.setUint16(p + 36, 0, true); // internal attrs
    view.setUint32(p + 38, 0, true); // external attrs
    view.setUint32(p + 42, offsets[i]!, true);
    out.set(name, p + 46);
    p += 46 + name.length;
  }

  view.setUint32(p, EOCD_SIG, true);
  view.setUint16(p + 4, 0, true); // disk number
  view.setUint16(p + 6, 0, true); // central directory start disk
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, centralSize, true);
  view.setUint32(p + 16, centralStart, true);
  view.setUint16(p + 20, 0, true); // comment length

  return out;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
