/**
 * What FBNeo accepts, as types and as data.
 *
 * The four payloads of the wasm-gaming engine contract, closed for this engine, and
 * {@link FBNEO_SPEC} — the same thing as data the contract's base class reads: every
 * default lives there and nowhere else.
 */
import type { EnginePayloads, EngineSpec } from '@wasm-gaming/engine-specs';

/** Bytes, or a thunk that produces them only when the engine actually needs them. */
export type FbneoAsset =
  | Uint8Array
  | ArrayBuffer
  | null
  | (() => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>);

/** The engine: fixed for the life of the wasm instance (`renderFilter` aside). */
export interface FbneoConfig {
  /** How the picture is scaled to the mount: crisp pixels or linear filtering. */
  renderFilter?: 'pixelated' | 'smooth';
  /** Emscripten glue URL. Defaults to `./fbneo.js` next to the SDK. */
  jsUrl?: string;
  /** WASM URL. Defaults to `./fbneo.wasm` next to the SDK. */
  wasmUrl?: string;
}

/** The session: which game the ROM set is. */
export interface FbneoOptions {
  /**
   * The FBNeo driver (ROM-set short name, e.g. `mslug`). When empty it is taken from
   * {@link FbneoOptions.romFileName}; the `romset` helper can recover it from a zip's
   * contents when the file name is unreliable.
   */
  driver?: string;
  /** The ROM zip's file name (`mslug.zip`), used for the driver when `driver` is empty. */
  romFileName?: string;
}

export interface FbneoAssets {
  /** The game's ROM set: a `.zip` (or `.7z`) named after its driver. Required to start. */
  rom?: FbneoAsset;
  /** A system BIOS set some games need (`neogeo.zip` for Neo Geo). */
  bios?: FbneoAsset;
}

/** Where this engine's files live, and whether they outlive the page. */
export interface FbneoStorage {
  /**
   * Per-game folder for NVRAM/EEPROM, hiscores and save states.
   *
   * Relative to the engine's own folder: the SDK always prefixes `fbneo/`, so the files
   * land in OPFS `fbneo/<namespace>/` and no namespace can reach another engine's
   * files. Segments are cleaned (`.`/`..` dropped, odd characters → `_`); anything
   * unusable becomes `"default"`. `play.storagePath` gives the result.
   *
   * @defaultValue `"default"`
   */
  namespace?: string;
  /** `null` keeps nothing; leaving it out (or `'opfs'`) mirrors the save folder to OPFS. */
  persist?: 'opfs' | null;
}

/** Engine events beyond the contract's core set. */
export interface FbneoEvents {
  /** Save files were just written to `fbneo/<namespace>/` (names relative to it). */
  saves: { files: string[] };
}

export interface FbneoPayloads extends EnginePayloads {
  config: FbneoConfig;
  options: FbneoOptions;
  assets: FbneoAssets;
  storage: FbneoStorage;
  events: FbneoEvents;
}

/** The canvas's backing size; FBNeo scales each game's picture into it. */
export const FBNEO_VIDEO = { width: 640, height: 480, aspect: '4:3' } as const;

export const FBNEO_SPEC: EngineSpec<FbneoPayloads> = {
  config: {
    renderFilter: {
      default: 'pixelated',
      enum: ['pixelated', 'smooth'],
      live: true,
      description: 'Scaling: crisp pixels or linear filtering.',
    },
    jsUrl: { live: false, description: 'Emscripten glue URL. Defaults to ./fbneo.js.' },
    wasmUrl: { live: false, description: 'WASM URL. Defaults to ./fbneo.wasm.' },
  },
  options: {
    driver: {
      default: '',
      live: false,
      description: 'FBNeo driver (ROM-set short name, e.g. "mslug"). Empty: taken from romFileName.',
    },
    romFileName: {
      default: '',
      live: false,
      description: 'The ROM zip file name; its stem is the driver when driver is empty.',
    },
  },
  assets: {
    rom: {
      allowedTypes: ['.zip', '.7z'],
      live: false,
      description: 'The arcade ROM set, named after its driver. Required to start.',
    },
    bios: {
      allowedTypes: ['.zip'],
      live: false,
      description: 'Optional system BIOS set (neogeo.zip for Neo Geo).',
    },
  },
  storage: {
    namespace: {
      default: 'default',
      live: false,
      description: "Folder for this game's saves, inside the engine's own fbneo/ folder (OPFS fbneo/<namespace>/).",
    },
    persist: {
      enum: ['opfs', null],
      live: false,
      description: 'null keeps nothing; otherwise saves are mirrored to OPFS.',
    },
  },
};
