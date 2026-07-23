# @wasm-gaming/fbneo-wasm

FinalBurn Neo (FBNeo) — the multi-system arcade emulator (Capcom CPS-1/2/3, SNK
Neo Geo, Sega System 16, Cave, PGM, and many more) — compiled to WebAssembly via
Emscripten and packaged as a wasm-gaming engine SDK.

This subproject follows the same engine-package approach used by jgenesis-wasm,
blastem-wasm, rsdkv3, and rsdkv4:

- typed `manifest`
- typed `options`
- `load(config)` engine SDK surface
- Makefile-driven build (`build-sdk`, `build-wasm`, `preview`)

It conforms to the [`@wasm-gaming/engine-specs`](https://github.com/wasm-gaming/engine-specs)
contract (`EngineSDK` = `{ manifest, load }`).

## Contract surface

```js
import { manifest, load } from '@wasm-gaming/fbneo-wasm';

const engine = await load({
  canvas,                         // per engine-specs EngineConfig
  assets: {
    rom: romZipBytes,             // arcade ROM set (zip)
    bios: neogeoZipBytes,         // optional: e.g. neogeo.zip for Neo Geo sets
  },
  options: { driver: 'mslug', renderFilter: 'pixelated' },
  onEvent: (e) => console.log(e),
});
engine.start();
```

FBNeo identifies a game by the ROM zip **filename** (without extension). Pass the
game short name explicitly via `options.driver` (e.g. `"mslug"`, `"sf2"`,
`"kof98"`), or let it be inferred from `options.romFileName` / the picked file's
name.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `romFileName` | `game.zip` | Filename used when writing ROM bytes to MEMFS. |
| `driver` | *(inferred)* | FBNeo ROM set short name to boot. |
| `renderFilter` | `pixelated` | `pixelated` (crisp) or `smooth` (linear). |
| `audioSampleRate` | `44100` | Target audio sample rate in Hz. |
| `vsync` | `true` | Enable vertical sync. |
| `integerScale` | `false` | Integer scaling only. |
| `windowScale` | `2` | Internal render-resolution multiplier. |

## Build

```sh
make build        # Full build: WASM (Docker/Emscripten) + TypeScript SDK
make build-sdk    # TypeScript only (SDK + manifest + demo shell)
make build-wasm   # FBNeo WASM only (via Docker)
make preview      # Serve dist/ with COOP/COEP headers
```

WebAssembly threads/SharedArrayBuffer require the COOP/COEP headers that
`make preview` sets — serve the built `dist/` with those headers in production too.

## WASM artifacts

| File | Description |
|------|-------------|
| `fbneo.js` | Emscripten-generated module loader (`createFbneoModule`). |
| `fbneo.wasm` | Compiled FBNeo runtime. |

FBNeo uses Emscripten SDL2. The JS loader expects a `<canvas id="canvas">` in the
DOM (the SDK sets this id automatically). ROM zips are written to the in-memory
MEMFS under `/roms/` before the emulator boots, and FBNeo is launched with the
driver short name.

See [CORE.md](CORE.md) for the mapping between upstream FBNeo capabilities and the
options currently exposed by this wrapper.
