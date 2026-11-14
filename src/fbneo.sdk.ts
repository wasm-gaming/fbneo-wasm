/**
 * The engine package's entry point: an `EngineSDK` for FBNeo (FinalBurn Neo), the
 * arcade emulator.
 *
 * ```js
 * import FbneoSDK from '@wasm-gaming/fbneo-wasm';
 *
 * const play = await new FbneoSDK()
 *   .options({ driver: 'mslug' })                       // or romFileName: 'mslug.zip'
 *   .assets({ rom: () => readZip(), bios: () => readBios() })
 *   .storage({ namespace: 'mslug' })                    // → OPFS fbneo/mslug/
 *   .mount(document.querySelector('#stage'))
 *   .start();
 *
 * play.pause('menu'); play.resume('menu');
 * await play.restart();                                  // soft reset
 * await play.destroy();                                  // saves flushed, loop stopped
 * ```
 *
 * Everything a host drives is the contract's (`@wasm-gaming/engine-specs`); what is
 * this engine's own: {@link FbneoConfig} and friends, owner-aware
 * {@link FbneoPlay.pause} / {@link FbneoPlay.resume}, {@link FbneoPlay.states},
 * {@link FbneoPlay.storagePath} and the `saves` event.
 *
 * Saves: the build points FBNeo's NVRAM/EEPROM and hiscore paths at MEMFS `/save`.
 * The SDK seeds it from OPFS `fbneo/<namespace>/` before boot and mirrors it back
 * after asking FBNeo to write (`web_persist`): every 10 s, on pause, when the page is
 * hidden and on destroy. Upstream only wrote at exit, which a web page never reaches.
 */
import {
  EnginePlayBase,
  EngineSDKBase,
  EventEmitter,
  type EngineInit,
  type EngineSDKConstructor,
  type EventsOf,
} from '@wasm-gaming/engine-specs';
import {
  FBNEO_SPEC,
  FBNEO_VIDEO,
  type FbneoAsset,
  type FbneoConfig,
  type FbneoOptions,
  type FbneoPayloads,
} from './fbneo.options.js';

export type {
  FbneoAsset,
  FbneoAssets,
  FbneoConfig,
  FbneoEvents,
  FbneoOptions,
  FbneoPayloads,
  FbneoStorage,
} from './fbneo.options.js';
export { FBNEO_SPEC, FBNEO_VIDEO } from './fbneo.options.js';
import { parseZipEntries } from './romset.js';

const ENGINE_ID = 'fbneo';
const DEFAULT_STORAGE_NAMESPACE = 'default';
const SAVE_DIR = '/save';
/**
 * FBNeo's ROM search paths (src/burner/sdl/drv.cpp): the absolute one is always
 * searched; `/roms` covers the cwd-relative `roms/` with the cwd at `/`.
 */
const ROM_DIRS = ['/usr/local/share/roms', '/roms'];
const SAVE_INTERVAL_MS = 10_000;
/** How long a ROM set may take to load before start() gives up. */
const LOAD_TIMEOUT_MS = 30_000;

/** The Emscripten module this build produces (`createFbneoModule` from fbneo.js). */
interface FbneoModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    stat(path: string): { mode: number; mtime: Date | number };
    unlink(path: string): void;
    isFile(mode: number): boolean;
  };
  callMain(args: string[]): void;
  _web_set_paused(paused: number): void;
  _web_reset(): void;
  _web_persist(): number;
  _web_save_state(slot: number): number;
  _web_load_state(slot: number): number;
  _web_running(): number;
  _web_quit(): void;
  _web_memcard_insert(): number;
  ccall(name: string, returnType: 'number', argTypes: string[], args: unknown[]): number;
  SDL2?: { audioContext?: AudioContext };
}

type FbneoFactory = (overrides: Record<string, unknown>) => Promise<FbneoModule>;

/**
 * Where an engine keeps one namespace: `<engineId>/<namespace>`, relative to the OPFS
 * root. Identical to the other engines': segments cleaned, `.` and `..` dropped,
 * anything outside `[A-Za-z0-9._-]` → `_`, nothing usable → `default`; a leading
 * `<engineId>/` is stripped once.
 */
export function storagePath(
  engineId: string,
  namespace: unknown,
): { namespace: string; path: string; prefixed: boolean } {
  const segments =
    typeof namespace === 'string'
      ? namespace
          .split('/')
          .map((segment) => segment.trim())
          .filter((segment) => segment && segment !== '.' && segment !== '..')
          .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
      : [];
  const prefixed = segments.length > 1 && segments[0] === engineId;
  if (prefixed) segments.shift();
  const cleaned = segments.join('/') || DEFAULT_STORAGE_NAMESPACE;
  return { namespace: cleaned, path: `${engineId}/${cleaned}`, prefixed };
}

/**
 * The FBNeo driver for a session: `driver` when given, else the ROM file name's stem
 * (`mslug.zip`, `C:\roms\mslug.7z` → `mslug`). Empty when neither says.
 */
export function driverName(options: { driver?: string; romFileName?: string }): string {
  const explicit = options.driver?.trim();
  if (explicit) return explicit;
  const base = (options.romFileName ?? '').replace(/^.*[\\/]/, '');
  return base.replace(/\.(zip|7z)$/i, '').trim();
}

async function opfsDir(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  } catch {
    return null;
  }
}

async function resolveAsset(asset: FbneoAsset | undefined): Promise<Uint8Array | null> {
  const value = typeof asset === 'function' ? await asset() : asset;
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('fbneo: an asset must be a Uint8Array, an ArrayBuffer or a thunk returning one');
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The Neo Geo BIOS FBNeo should run, from what the BIOS zip holds (by CRC). */
export interface NeoGeoBiosChoice {
  /** `aes`: the real AES BIOS; `unibios`: Universe BIOS 4.0 in its AES mode. */
  bios: 'aes' | 'unibios';
  /** The driver's settings to apply: `[group, option]`, as FBNeo names them. */
  dips: Array<[string, string]>;
}

const AES_WORLD_CRC = 'd27a71f1'; // neo-epo.bin
const UNIBIOS_40_CRC = 'a7aab458'; // uni-bios_4_0.rom

/**
 * How to boot a Neo Geo as the AES (the home console) with the BIOS zip at hand: the
 * real AES World BIOS when it is there, else Universe BIOS 4.0 in AES mode, else null.
 */
export function neoGeoAesBios(entries: Array<{ crc: string }>): NeoGeoBiosChoice | null {
  const crcs = new Set(entries.map((entry) => entry.crc.toLowerCase()));
  if (crcs.has(AES_WORLD_CRC)) return { bios: 'aes', dips: [['BIOS', 'AES World']] };
  if (crcs.has(UNIBIOS_40_CRC)) {
    return { bios: 'unibios', dips: [['BIOS', 'Universe BIOS (Hack, Ver. 4.0)'], ['Unibios mode', 'AES']] };
  }
  return null;
}

/** The player's save-state slots: 0-3. */
export const STATE_SLOTS = 4;
/**
 * The *unsaved* suspend point: written when the player leaves, offered when they come
 * back, and saved into a numbered slot only when they ask.
 */
export const AUTO_STATE_SLOT = 9;

/** One save-state slot. */
export interface FbneoStateSlot {
  slot: number;
  /** When the state was written, or null for an empty slot. */
  savedAt: Date | null;
  /** The frame saved with it (PNG), when the host handed one over. */
  thumbnail: Blob | null;
  /** Protected: cannot be overwritten or removed until unlocked. */
  locked: boolean;
}

/** Save states: whole-machine snapshots kept in the save folder (and OPFS). */
export interface FbneoStates {
  /** The player's slots, 0-3. */
  list(): FbneoStateSlot[];
  /** Any slot, {@link AUTO_STATE_SLOT} included. */
  get(slot: number): FbneoStateSlot;
  /** Save the running game into `slot` (paused or not). Refuses a locked slot. */
  save(slot: number, options?: { thumbnail?: Blob | null }): Promise<void>;
  /** Load `slot` into the running game; false when it is empty or FBNeo refused it. */
  load(slot: number): boolean;
  /** Copy a state (and its frame) into another slot — the unsaved point into a numbered one. */
  copy(from: number, to: number): Promise<void>;
  lock(slot: number, locked: boolean): Promise<void>;
  remove(slot: number): Promise<void>;
}

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const mtimeOf = (value: Date | number | undefined): number =>
  value instanceof Date ? value.getTime() : typeof value === 'number' ? value : 0;

/** The live engine: one booted FBNeo and its session. */
export class FbneoPlay extends EnginePlayBase<FbneoPayloads> {
  #module: FbneoModule | null = null;
  #destroyed = false;
  #pauseOwner: string | null = null;
  #driver = '';
  #neogeo: { mode: 'aes'; bios: 'aes' | 'unibios'; card: boolean } | null = null;

  #canvas: HTMLCanvasElement | null = null;
  #ownsCanvas = false;
  #box: HTMLElement | null = null;
  #boxObserver: ResizeObserver | null = null;
  #canvasObserver: MutationObserver | null = null;

  #namespace = DEFAULT_STORAGE_NAMESPACE;
  #storagePath = `${ENGINE_ID}/${DEFAULT_STORAGE_NAMESPACE}`;
  #persist = true;
  #saveTimer: ReturnType<typeof setInterval> | null = null;
  #lastSaved = new Map<string, Uint8Array>();
  #flushing: Promise<void> | null = null;
  #onHidden = (): void => {
    if (document.visibilityState === 'hidden') void this.flushSaves();
  };

  constructor(init?: EngineInit<FbneoPayloads>, events?: EventEmitter<EventsOf<FbneoPayloads>>) {
    super(FBNEO_SPEC, init, events);
  }

  /** The normalised namespace this session uses. */
  get namespace(): string {
    return this.#namespace;
  }

  /** Where this session's saves live, relative to the OPFS root: `fbneo/<namespace>`. */
  get storagePath(): string {
    return this.#storagePath;
  }

  /** The driver (ROM-set short name) this session booted. */
  get driver(): string {
    return this.#driver;
  }

  /** How a Neo Geo set was booted as the AES: `{ mode, bios, card }`; null otherwise. */
  get neogeo(): { mode: 'aes'; bios: 'aes' | 'unibios'; card: boolean } | null {
    return this.#neogeo;
  }

  /** Who holds the pause, or null while running. */
  get pausedBy(): string | null {
    return this.#pauseOwner;
  }

  /**
   * The current frame as a PNG (also while paused: the picture is kept). Null when
   * there is nothing to read.
   */
  async snapshot(): Promise<Blob | null> {
    const canvas = this.#canvas;
    if (!canvas || !this.#module) return null;
    await nextFrame();
    const copy = document.createElement('canvas');
    copy.width = canvas.width || FBNEO_VIDEO.width;
    copy.height = canvas.height || FBNEO_VIDEO.height;
    copy.getContext('2d')?.drawImage(canvas, 0, 0, copy.width, copy.height);
    return new Promise((resolve) => copy.toBlob((blob) => resolve(blob), 'image/png'));
  }

  /** Save states — see {@link FbneoStates}. */
  get states(): FbneoStates {
    const Module = this.#requireModule();
    const { FS } = Module;
    const file = (name: string): string => `${SAVE_DIR}/${name}`;
    const exists = (name: string): boolean => {
      try {
        FS.stat(file(name));
        return true;
      } catch {
        return false;
      }
    };
    const stateName = (slot: number): string => `slot_${slot}.fs`;
    const mtime = (name: string): number | null => {
      try {
        return mtimeOf(FS.stat(file(name)).mtime);
      } catch {
        return null;
      }
    };
    const checkSlot = (slot: number): number => {
      if (slot === AUTO_STATE_SLOT || (Number.isInteger(slot) && slot >= 0 && slot < STATE_SLOTS)) return slot;
      throw new RangeError(`fbneo: a state slot is 0-${STATE_SLOTS - 1} or ${AUTO_STATE_SLOT}, not ${slot}`);
    };
    const isLocked = (slot: number): boolean => exists(`slot_${slot}.lock`);
    const refuseLocked = (slot: number): void => {
      if (isLocked(slot)) throw new Error(`fbneo: state slot ${slot} is locked`);
    };
    // Removed files have to leave OPFS too: the mirror only ever writes.
    const forget = async (names: string[]): Promise<void> => {
      for (const name of names) {
        try {
          FS.unlink(file(name));
        } catch {
          /* not there */
        }
        this.#lastSaved.delete(name);
      }
      const dir = this.#persist ? await opfsDir(this.#storagePath, false) : null;
      for (const name of names) await dir?.removeEntry(name).catch(() => {});
    };
    const get = (slot: number): FbneoStateSlot => {
      checkSlot(slot);
      const savedAt = mtime(stateName(slot));
      let thumbnail: Blob | null = null;
      if (savedAt !== null && exists(`slot_${slot}.png`)) {
        thumbnail = new Blob([new Uint8Array(FS.readFile(file(`slot_${slot}.png`)))], { type: 'image/png' });
      }
      return { slot, savedAt: savedAt === null ? null : new Date(savedAt), thumbnail, locked: isLocked(slot) };
    };
    return {
      list: () => Array.from({ length: STATE_SLOTS }, (_, slot) => get(slot)),
      get,
      save: async (slot, options = {}) => {
        checkSlot(slot);
        refuseLocked(slot);
        // FBNeo writes the state at once (between frames: JS only runs while its loop sleeps).
        if (!Module._web_save_state(slot)) throw new Error('fbneo: the state could not be saved (no game running?)');
        if (options.thumbnail) {
          FS.writeFile(file(`slot_${slot}.png`), new Uint8Array(await options.thumbnail.arrayBuffer()));
        } else await forget([`slot_${slot}.png`]);
        await this.flushSaves();
      },
      load: (slot) => {
        checkSlot(slot);
        if (mtime(stateName(slot)) === null) return false;
        return Module._web_load_state(slot) !== 0;
      },
      copy: async (from, to) => {
        checkSlot(from);
        checkSlot(to);
        refuseLocked(to);
        if (mtime(stateName(from)) === null) throw new Error(`fbneo: state slot ${from} is empty`);
        await forget([stateName(to), `slot_${to}.png`]);
        FS.writeFile(file(stateName(to)), new Uint8Array(FS.readFile(file(stateName(from)))));
        if (exists(`slot_${from}.png`)) {
          FS.writeFile(file(`slot_${to}.png`), new Uint8Array(FS.readFile(file(`slot_${from}.png`))));
        }
        await this.flushSaves();
      },
      lock: async (slot, locked) => {
        checkSlot(slot);
        if (locked) {
          if (mtime(stateName(slot)) === null) throw new Error(`fbneo: state slot ${slot} is empty`);
          FS.writeFile(file(`slot_${slot}.lock`), new Uint8Array([1]));
          await this.flushSaves();
        } else {
          await forget([`slot_${slot}.lock`]);
          this.emit('saves', { files: [`slot_${slot}.lock`] });
        }
      },
      remove: async (slot) => {
        checkSlot(slot);
        refuseLocked(slot);
        const names = [stateName(slot), `slot_${slot}.png`];
        await forget(names);
        this.emit('saves', { files: names });
      },
    };
  }

  #requireModule(): FbneoModule {
    if (!this.#module) throw new Error('fbneo: the engine is not running — start() it first');
    return this.#module;
  }

  /**
   * Freeze emulation and sound. The first caller owns the pause, and only that
   * owner's {@link resume} lifts it, so an overlay cannot resume a game the host had
   * already frozen. Saves are flushed, since a paused game is often a closed one.
   */
  pause(owner = 'host'): void {
    const Module = this.#module;
    if (!Module || this.#pauseOwner) return;
    this.#pauseOwner = owner;
    Module._web_set_paused(1);
    void Module.SDL2?.audioContext?.suspend();
    void this.flushSaves();
    this.emit('pause', { owner });
  }

  resume(owner = 'host'): void {
    const Module = this.#module;
    if (!Module || this.#pauseOwner !== owner) return;
    this.#pauseOwner = null;
    void Module.SDL2?.audioContext?.resume();
    Module._web_set_paused(0);
    this.emit('resume', { owner });
  }

  /**
   * Ask FBNeo to write its NVRAM, then copy whatever changed in `/save` to OPFS
   * `fbneo/<namespace>/`. Emits `saves` with the files that moved. Safe to call any
   * time; overlapping calls share one flush.
   */
  flushSaves(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  // ---- Contract hooks ----

  protected override mounted(target: HTMLElement): void {
    if (target instanceof HTMLCanvasElement) {
      this.#canvas = target;
      this.#ownsCanvas = false;
      this.#box = target.parentElement;
    } else {
      this.#canvas = document.createElement('canvas');
      this.#ownsCanvas = true;
      this.#box = target;
      target.appendChild(this.#canvas);
    }
    const canvas = this.#canvas;
    // Emscripten's SDL2 finds its window by id, and measures the element: no border or
    // padding on the canvas itself, or SDL creates a tiny window.
    canvas.id = 'canvas';
    if (!canvas.width) canvas.width = FBNEO_VIDEO.width;
    if (!canvas.height) canvas.height = FBNEO_VIDEO.height;
    canvas.tabIndex = 0;
    canvas.style.border = '0';
    canvas.style.padding = '0';
    canvas.style.display = 'block';
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    void this.#applyFilter();

    if (this.#box && this.#ownsCanvas) {
      this.#boxObserver?.disconnect();
      this.#boxObserver = new ResizeObserver(() => this.#fit());
      this.#boxObserver.observe(this.#box);
      // FBNeo sizes the canvas to each game's picture (vertical games too): refit then.
      this.#canvasObserver?.disconnect();
      this.#canvasObserver = new MutationObserver(() => this.#fit());
      this.#canvasObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
      this.#fit();
    }
  }

  protected override async open(_options: FbneoOptions): Promise<void> {
    if (this.#destroyed) {
      throw new Error('fbneo: this engine has been destroyed and cannot be started again in this page — build a new FbneoSDK in a new page');
    }
    if (this.#module) {
      // Already running: a restart is the machine's soft reset.
      if (this.#pauseOwner) this.resume(this.#pauseOwner);
      this.#module._web_reset();
      return;
    }
    await this.#boot();
  }

  protected override patched(kind: string, patch: object): void {
    if (kind === 'config' && 'renderFilter' in patch) void this.#applyFilter();
  }

  protected override async close(): Promise<void> {
    if (this.#saveTimer) clearInterval(this.#saveTimer);
    this.#saveTimer = null;
    document.removeEventListener('visibilitychange', this.#onHidden);
    window.removeEventListener('pagehide', this.#onHidden);

    const Module = this.#module;
    if (Module) {
      await this.flushSaves();
      const context = Module.SDL2?.audioContext;
      try {
        Module._web_set_paused(1);
        // Ends FBNeo's loop: it exits the game its own way (NVRAM written, sound closed).
        Module._web_quit();
      } catch {
        /* already gone */
      }
      // FBNeo's exit closes the AudioContext on the loop's next turn; close it here only
      // if it didn't (closing it first makes FBNeo's own close throw).
      const deadline = performance.now() + 1000;
      while (context && context.state !== 'closed' && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (context && context.state !== 'closed') await context.close().catch(() => {});
    }
    this.#boxObserver?.disconnect();
    this.#boxObserver = null;
    this.#canvasObserver?.disconnect();
    this.#canvasObserver = null;
    if (this.#ownsCanvas) this.#canvas?.remove();
    this.#canvas = null;
    this.#module = null;
    this.#pauseOwner = null;
    this.#destroyed = true;
  }

  // ---- Boot ----

  async #boot(): Promise<void> {
    const config = await this.#values<FbneoConfig>('config');
    const options = await this.#values<FbneoOptions>('options');
    const assets = await this.#values<{ rom?: FbneoAsset; bios?: FbneoAsset }>('assets');
    const storage = await this.#values<{ namespace?: string; persist?: 'opfs' | null }>('storage');

    if (!this.#canvas) {
      throw new Error('fbneo: mount() an element (or a canvas) before start()');
    }

    const driver = driverName(options);
    if (!driver) {
      throw new Error(
        'fbneo: which game is it? Pass options.driver (the FBNeo short name, e.g. "mslug") ' +
          'or options.romFileName named after it (mslug.zip).',
      );
    }
    const rom = await resolveAsset(assets.rom);
    if (!rom) throw new Error('fbneo: no ROM set — hand one over as assets.rom (bytes or a thunk)');
    const bios = await resolveAsset(assets.bios);
    this.#driver = driver;

    const resolved = storagePath(ENGINE_ID, storage.namespace);
    this.#namespace = resolved.namespace;
    this.#storagePath = resolved.path;
    this.#persist = storage.persist !== null;

    const jsUrl = config.jsUrl ?? new URL('./fbneo.js', import.meta.url).href;
    const wasmUrl = config.wasmUrl ?? new URL('./fbneo.wasm', import.meta.url).href;
    const { default: createFbneoModule } = (await import(/* @vite-ignore */ jsUrl)) as {
      default: FbneoFactory;
    };

    // The context SDL will use, made first so it keeps its picture between frames:
    // FBNeo draws from timers, not animation frames, so without this snapshot() (the
    // app's suspend-point frames) reads a cleared buffer. SDL gets this one back.
    this.#canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });

    let failed: ((error: Error) => void) | null = null;
    // FBNeo reports a set it could not load only on stdout (then main() returns).
    let refused: string | null = null;
    const Module = await createFbneoModule({
      canvas: this.#canvas,
      noInitialRun: true,
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : new URL(path, jsUrl).href),
      print: (text: string) => {
        if (/error loading your selected game/i.test(text)) refused = text;
        console.log('[fbneo]', text);
      },
      printErr: (text: string) => console.warn('[fbneo]', text),
      onAbort: (what: unknown) => failed?.(new Error(`fbneo: aborted — ${String(what)}`)),
    });
    this.#module = Module;
    failed = (error) => this.emit('error', error);

    const { FS } = Module;
    // FBNeo finds a game by `<driver>.zip` in its ROM paths, and matches the files
    // inside by name/CRC: whatever the player named the file, it lands as that.
    for (const dir of ROM_DIRS) {
      FS.mkdirTree(dir);
      FS.writeFile(`${dir}/${driver}.zip`, rom);
      if (bios) FS.writeFile(`${dir}/neogeo.zip`, bios);
    }
    FS.mkdirTree(SAVE_DIR);
    if (this.#persist) await this.#restoreSaves();

    // callMain() returns at FBNeo's first yield, before the set is loaded: wait for
    // the game to run, or for FBNeo to say it refused the set, so a bad set is an
    // error here and not a black screen.
    Module.callMain([driver]);
    const deadline = performance.now() + LOAD_TIMEOUT_MS;
    while (!Module._web_running() && !refused && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!Module._web_running()) {
      throw new Error(
        refused
          ? `fbneo: FBNeo could not load "${driver}" — the ROM set is incomplete, is not that driver, or needs a BIOS (neogeo.zip for Neo Geo)`
          : `fbneo: "${driver}" did not start within ${LOAD_TIMEOUT_MS / 1000} s`,
      );
    }

    if (options.neogeo === 'aes') await this.#bootAes(Module, bios);

    if (this.#persist) {
      this.#saveTimer = setInterval(() => void this.flushSaves(), SAVE_INTERVAL_MS);
      document.addEventListener('visibilitychange', this.#onHidden);
      window.addEventListener('pagehide', this.#onHidden);
    }
    this.#fit();
  }

  /**
   * Neo Geo as the AES: pick the BIOS from the BIOS zip, set the driver's BIOS settings,
   * insert the game's memory card and reset, so the machine boots that BIOS (FBNeo
   * loads it at reset). A set that isn't Neo Geo has no "BIOS" setting: left as is.
   */
  async #bootAes(Module: FbneoModule, bios: Uint8Array | null): Promise<void> {
    let choice: NeoGeoBiosChoice | null = null;
    try {
      choice = bios ? neoGeoAesBios(parseZipEntries(bios)) : null;
    } catch {
      choice = null; // not a zip: no BIOS to choose from
    }
    const setDip = (group: string, option: string): boolean =>
      Module.ccall('web_set_dip', 'number', ['string', 'string'], [group, option]) === 1;
    if (!choice) {
      // Only a Neo Geo driver has the setting; anything else plays as it always has.
      if (!setDip('BIOS', 'AES World')) return;
      throw new Error(
        'fbneo: Neo Geo as the AES needs a BIOS zip (neogeo.zip) with the AES BIOS (neo-epo.bin) or Universe BIOS 4.0',
      );
    }
    for (const [group, option] of choice.dips) {
      if (!setDip(group, option)) {
        if (group === 'BIOS') return; // not a Neo Geo set
        throw new Error(`fbneo: this FBNeo build has no "${group}: ${option}" setting`);
      }
    }
    const card = Module._web_memcard_insert() === 1;
    // The settings reach the driver on the next frame; the BIOS is loaded at reset.
    await new Promise((resolve) => setTimeout(resolve, 100));
    Module._web_reset();
    this.#neogeo = { mode: 'aes', bios: choice.bios, card };
  }

  /** The plain values behind one payload's descriptors. */
  async #values<T>(kind: 'config' | 'options' | 'assets' | 'storage'): Promise<T> {
    const described = (await this[kind]()) as Record<string, { value: unknown }>;
    const out: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(described)) out[key] = property.value;
    return out as T;
  }

  // ---- Saves ----

  async #restoreSaves(): Promise<void> {
    const dir = await opfsDir(this.#storagePath, false);
    if (!dir || !this.#module) return;
    const iterable = dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
    for await (const [name, handle] of iterable.entries()) {
      if (handle.kind !== 'file') continue;
      const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
      this.#module.FS.writeFile(`${SAVE_DIR}/${name}`, bytes);
      this.#lastSaved.set(name, bytes);
    }
  }

  async #flush(): Promise<void> {
    const Module = this.#module;
    if (!Module || !this.#persist) return;
    try {
      Module._web_persist();
    } catch (e) {
      console.warn('[fbneo] persist failed', e);
      return;
    }
    const changed: Array<[string, Uint8Array<ArrayBuffer>]> = [];
    for (const name of Module.FS.readdir(SAVE_DIR)) {
      if (name === '.' || name === '..') continue;
      const path = `${SAVE_DIR}/${name}`;
      if (!Module.FS.isFile(Module.FS.stat(path).mode)) continue;
      const bytes = new Uint8Array(Module.FS.readFile(path));
      if (!sameBytes(this.#lastSaved.get(name), bytes)) changed.push([name, bytes]);
    }
    if (changed.length === 0) return;

    const dir = await opfsDir(this.#storagePath, true);
    if (!dir) return;
    const written: string[] = [];
    for (const [name, bytes] of changed) {
      try {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
        this.#lastSaved.set(name, bytes);
        written.push(name);
      } catch (e) {
        console.warn(`[fbneo] could not persist ${name}`, e);
      }
    }
    if (written.length) this.emit('saves', { files: written });
  }

  // ---- Picture ----

  /** Scale the canvas to fit its box, keeping the picture's own proportions. */
  #fit(): void {
    const canvas = this.#canvas;
    const box = this.#box;
    if (!canvas || !box || !this.#ownsCanvas) return;
    const { width, height } = box.getBoundingClientRect();
    const w = canvas.width || FBNEO_VIDEO.width;
    const h = canvas.height || FBNEO_VIDEO.height;
    if (!width || !height) return;
    const scale = Math.min(width / w, height / h);
    canvas.style.width = `${Math.floor(w * scale)}px`;
    canvas.style.height = `${Math.floor(h * scale)}px`;
  }

  async #applyFilter(): Promise<void> {
    const canvas = this.#canvas;
    if (!canvas) return;
    const { renderFilter } = await this.#values<FbneoConfig>('config');
    canvas.style.imageRendering = renderFilter === 'smooth' ? 'auto' : 'pixelated';
  }
}

/**
 * The factory a host constructs: static identity, the configuration chain, and a
 * `start()` that boots FBNeo and opens a session.
 */
export class FbneoSDK extends EngineSDKBase<FbneoPayloads> {
  static readonly id = ENGINE_ID;
  /** Kept in step with package.json by `node scripts/sync-version.mjs`. */
  static readonly version = '0.3.0';
  static readonly name = 'FinalBurn Neo';
  static readonly description =
    'FBNeo, the arcade emulator (Capcom CPS-1/2/3, SNK Neo Geo, Sega System 16 and more), compiled to WebAssembly. Ships no games: the player provides the ROM sets, and they never leave their browser.';

  protected override createPlay(
    init: EngineInit<FbneoPayloads>,
    events: EventEmitter<EventsOf<FbneoPayloads>>,
  ): FbneoPlay {
    return new FbneoPlay(init, events);
  }
}

/** CI's conformance line: if this class stops satisfying the contract, `make test` fails. */
export const FBNEO_ENGINE: EngineSDKConstructor<FbneoPayloads> = FbneoSDK;

export default FbneoSDK;
