import type {
  AssetData,
  EngineConfig,
  EngineEvent,
  EngineInstance,
  InputPreset,
  KeyMap,
} from '@wasm-gaming/engine-specs';
import { manifest } from './fbneo.manifest.js';
import { DEFAULT_FBNEO_OPTIONS, type FbneoOptions } from './fbneo.options.js';

export { manifest };

/**
 * Shape of the Emscripten Module object exposed by fbneo.js.
 *
 * FBNeo's Emscripten SDL2 build is expected to be produced with
 * `-sMODULARIZE -sEXPORT_NAME=createFbneoModule` and the full `FS` object
 * exported (`-sEXPORTED_RUNTIME_METHODS=FS,callMain`). We defensively support
 * both the modularized factory and the classic global-`Module` shape.
 */
type FbneoModule = {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    analyzePath(path: string): { exists: boolean };
    readdir(path: string): string[];
  };
  callMain(args: string[]): void;
  pauseMainLoop?: () => void;
  resumeMainLoop?: () => void;
  onRuntimeInitialized?: () => void;
  locateFile?: (path: string, prefix: string) => string;
  noInitialRun?: boolean;
  canvas: HTMLCanvasElement;
};

type FbneoModuleFactory = (overrides: Partial<FbneoModule>) => Promise<FbneoModule>;

const scriptLoadCache = new Map<string, Promise<void>>();

function loadClassicScriptOnce(src: string): Promise<void> {
  const cached = scriptLoadCache.get(src);
  if (cached) return cached;

  const p = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`fbneo: failed to load script: ${src}`));
    document.head.appendChild(script);
  });

  scriptLoadCache.set(src, p);
  return p;
}

function toUint8(x: AssetData | undefined | unknown): Uint8Array | null {
  if (x == null) return null;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('fbneo: asset must be Uint8Array | ArrayBuffer | string');
}

/** Strip a directory and extension from a zip filename to get the FBNeo driver name. */
function driverFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  return base.replace(/\.(zip|7z)$/i, '');
}

/**
 * Resolve the render canvas from the contract's `EngineConfig`.
 * The contract is a union: hosts pass either `canvasEl` (a render target) or
 * `attachTo` (a container the SDK mounts its own canvas into). Legacy `canvas`
 * is still accepted as a defensive fallback for hosts built against 0.1.x.
 */
function resolveCanvas(config: EngineConfig): HTMLCanvasElement {
  const c =
    (config as { canvasEl?: HTMLCanvasElement }).canvasEl ??
    (config as { canvas?: HTMLCanvasElement }).canvas;
  if (c) return c;

  const attachTo = (config as { attachTo?: HTMLElement }).attachTo;
  if (attachTo) {
    const existing = attachTo.querySelector('canvas');
    if (existing) return existing;
    const created = document.createElement('canvas');
    attachTo.appendChild(created);
    return created;
  }
  throw new Error('fbneo: config.canvasEl or config.attachTo is required');
}

/**
 * Ensure the canvas used by FBNeo has `id="canvas"`.
 * Emscripten SDL2 queries `document.querySelector('#canvas')` to locate its render target.
 */
function prepareCanvas(
  canvas: HTMLCanvasElement,
  renderFilter: Required<FbneoOptions>['renderFilter'],
): HTMLCanvasElement {
  if (canvas.id !== 'canvas') canvas.id = 'canvas';
  if (!canvas.width) canvas.width = manifest.video.baseWidth;
  if (!canvas.height) canvas.height = manifest.video.baseHeight;
  // SDL2's Emscripten backend measures getBoundingClientRect() (borders/padding
  // included) to detect external CSS sizing; decoration on the canvas itself
  // makes it create a tiny window. Host pages should decorate a wrapper instead.
  canvas.style.border = '0';
  canvas.style.padding = '0';
  canvas.style.imageRendering = renderFilter === 'pixelated' ? 'pixelated' : 'auto';
  return canvas;
}

export async function load(config: EngineConfig): Promise<EngineInstance> {
  const { assets, onEvent } = config;

  const emit = (e: EngineEvent): void => {
    try {
      onEvent?.(e);
    } catch {
      // host callback must not break the engine runtime
    }
  };

  // Generic hosts (e.g. the engine-specs demo shell) pass the picked file's name
  // as `options.fileName`; treat it as an alias for `romFileName` so the driver
  // can be inferred from the ROM's filename without a FBNeo-specific option.
  const rawOptions = config.options as
    | (FbneoOptions & { fileName?: string })
    | undefined;
  const opts: Required<FbneoOptions> = {
    ...DEFAULT_FBNEO_OPTIONS,
    ...rawOptions,
    romFileName:
      rawOptions?.romFileName ??
      rawOptions?.fileName ??
      DEFAULT_FBNEO_OPTIONS.romFileName,
  };

  const romBytes = toUint8(assets?.rom ?? assets?.data);
  if (!romBytes) {
    throw new Error('fbneo: no ROM bytes provided — pass assets.rom (an arcade ROM zip)');
  }
  const biosBytes = toUint8(assets?.bios);

  const canvas = prepareCanvas(resolveCanvas(config), opts.renderFilter);

  // FBNeo boots a game by its ROM-set short name ("driver", e.g. "mslug") and
  // searches its ROM paths for a matching `<driver>.zip`. Prefer an explicit
  // `options.driver`; otherwise derive it from the ROM filename (stripping the
  // extension). Whatever the source, the zip is mounted as `<driver>.zip` so the
  // name FBNeo looks up and the name on disk always agree.
  const driver = (opts.driver || driverFromFileName(opts.romFileName)).trim();
  if (!driver || driver === 'game') {
    throw new Error(
      'fbneo: could not determine the ROM-set name. Pass options.driver (the FBNeo ' +
        'short name, e.g. "mslug") or name the ROM file after it (e.g. mslug.zip).',
    );
  }
  const romFileName = `${driver}.zip`;

  const jsUrl = config.jsUrl ?? new URL('./fbneo.js', import.meta.url).href;
  const wasmUrl = config.wasmUrl ?? new URL('./fbneo.wasm', jsUrl).href;

  let modRef: FbneoModule | null = null;
  let readyResolve: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  // FBNeo's default ROM search paths (src/burner/sdl/drv.cpp) are the absolute
  // "/usr/local/share/roms/" and the cwd-relative "roms/". Under Emscripten the
  // cwd is not guaranteed to be "/", so write to the absolute path (always
  // searched) as well as "/roms/". FBNeo matches ROM files inside each zip by
  // name/CRC, so the zip must be named after the driver.
  const romDirs = ['/usr/local/share/roms', '/roms'];
  const writeRoms = (mod: FbneoModule): void => {
    for (const dir of romDirs) {
      mod.FS.mkdirTree(dir);
      mod.FS.writeFile(`${dir}/${romFileName}`, romBytes);
      if (biosBytes) mod.FS.writeFile(`${dir}/neogeo.zip`, biosBytes);
    }
  };

  const moduleOverrides: Partial<FbneoModule> = {
    canvas,
    noInitialRun: true,
    locateFile(path: string): string {
      if (path.endsWith('.wasm')) return wasmUrl;
      return new URL(path, jsUrl).href;
    },
  };

  await loadClassicScriptOnce(jsUrl);

  const g = globalThis as {
    createFbneoModule?: FbneoModuleFactory;
    Module?: FbneoModule;
  };

  // Our build is a MODULARIZE factory (createFbneoModule). The factory promise
  // resolves *after* the runtime is initialized and FS is available, so this is
  // the correct point to populate MEMFS — write the ROMs before callMain().
  if (typeof g.createFbneoModule === 'function') {
    modRef = await g.createFbneoModule(moduleOverrides);
  } else if (g.Module) {
    modRef = g.Module;
  } else {
    throw new Error('fbneo: unable to initialize runtime module from fbneo.js');
  }

  writeRoms(modRef);
  readyResolve();

  await readyPromise;

  let running = false;
  const boot = (): void => {
    if (running) return;
    running = true;
    // FBNeo SDL takes the ROM set short name and searches its rom paths for it.
    modRef!.callMain([driver]);
    emit({ type: 'ready' });
  };

  const setInput = (_map: InputPreset | KeyMap): void => {
    // Input is handled by the Emscripten SDL2 event loop; no external override yet.
  };

  return {
    start() {
      boot();
    },
    pause() {
      modRef?.pauseMainLoop?.();
    },
    resume() {
      modRef?.resumeMainLoop?.();
    },
    reset() {
      // FBNeo does not expose a soft-reset hook through this WASM build.
      throw new Error('fbneo: reset is not supported by this build');
    },
    setInput,
    destroy() {
      modRef?.pauseMainLoop?.();
      running = false;
      emit({ type: 'exit' });
    },
  };
}

export default { manifest, load };
