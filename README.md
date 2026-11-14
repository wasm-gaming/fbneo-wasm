# @wasm-gaming/fbneo-wasm

FinalBurn Neo (FBNeo), the multi-system arcade emulator (Capcom CPS-1/2/3, SNK Neo Geo,
Sega System 16, Cave, PGM and many more), compiled to WebAssembly and wrapped in a small JS
SDK that implements the [wasm-gaming engine contract](https://github.com/wasm-gaming/engine-specs)
1.0. It ships no games: the player brings the ROM sets, and they never leave the browser.

## Install

```sh
npm install @wasm-gaming/fbneo-wasm
```

The SDK is self-contained: the contract's runtime ships beside it in `dist/fbneo/` and is
imported relatively, so it loads from any static server with no bundler and no import map.
The wasm and its glue sit next to it (`fbneo.js`, `fbneo.wasm`).

## Use

```js
import FbneoSDK from '@wasm-gaming/fbneo-wasm';

FbneoSDK.id;   // 'fbneo' — also this engine's folder in OPFS

const play = await new FbneoSDK()
  .options({ driver: 'mslug' })                       // or romFileName: 'mslug.zip'
  .assets({ rom: () => zip.arrayBuffer(), bios: () => neogeo.arrayBuffer() })
  .storage({ namespace: 'mslug' })                    // → OPFS fbneo/mslug/
  .on('saves', ({ detail }) => console.log('saved', detail.files))
  .mount(document.querySelector('#stage'))            // a <canvas> is used as is; anything else gets one
  .start();

play.pause('menu');            // the first caller owns the pause…
play.resume('menu');           // …and only it lifts it; sound stops too
await play.restart();          // soft reset
await play.states.save(0);     // save states: slots 0-3, plus 9 (the suspend point)
play.states.load(0);
await play.destroy();          // saves flushed, loop stopped, audio closed
```

| payload | keys |
| --- | --- |
| `config` | `renderFilter` (`pixelated` \| `smooth`, live), `jsUrl`, `wasmUrl` |
| `options` | `driver` (FBNeo short name), `romFileName` (its stem is the driver when `driver` is empty), `neogeo` (`mvs` \| `aes`) |
| `assets` | `rom` (`.zip`/`.7z`, required), `bios` (`.zip`, e.g. `neogeo.zip`) |
| `storage` | `namespace` (default `default`), `persist` (`'opfs'` \| `null`) |

FBNeo boots a game by its ROM-set short name (the *driver*, `mslug`) and finds `<driver>.zip`
in its ROM path; the SDK writes the bytes there under that name, so the player's file name
never matters once the driver is known.

Events: the contract's `start`, `error`, `exit`, `pause`, `resume`, plus `saves`.

## Neo Geo as the AES

FBNeo boots Neo Geo sets as the **MVS** (the arcade board: coins, credits). `options({ neogeo: 'aes' })`
boots them as the **AES**, the home console: once the set runs, the SDK picks the BIOS from the
`bios` zip — the real AES World BIOS (`neo-epo.bin`) when it is there, else Universe BIOS 4.0 in its
AES mode (MAME's `neogeo.zip` has it) — sets FBNeo's BIOS settings, inserts the game's **memory
card** (`<driver>.card` in the save folder, so in OPFS) and resets. `play.neogeo` says what was used
(`{ mode: 'aes', bios: 'aes' | 'unibios', card }`). The app takes the option from `host.options`.

## The engine's own app

A host that would rather not draw menus mounts the app shipped next to the SDK
(engine-specs `EngineApp`, `UX.md`):

```js
const app = await import('@wasm-gaming/fbneo-wasm/app'); // dist/fbneo/app/app.js
const handle = await app.mount(element, { game, storage, assets, input, exit });
await handle.unmount();
```

The same app as blastem-wasm's: suspend points the way the Nintendo Classic Mini does them
(leaving keeps an unsaved point with its frame; coming back offers it, four slots and "from
the beginning"), and a pause menu on Select + Start or Escape (*Continuar*, *Puntos de
suspensión*, *Reiniciar*, *Volver al lanzador*). The host hands over bytes, not a driver
name, so the app identifies the set by its contents (the datasets below, Neo Geo and Capcom
first), rebuilds a `.neo` image, and falls back to `game.slug`.

## Saves live in the engine's own folder

FBNeo's NVRAM/EEPROM (`<driver>.fs`), hiscores (`<driver>.hi`) and save states
(`slot_N.fs`, with an optional `slot_N.png` frame and `slot_N.lock`) are written to MEMFS
`/save`, which the SDK seeds from OPFS `fbneo/<namespace>/` before boot and mirrors back
every 10 s, on pause, when the page is hidden and on destroy. `persist: null` keeps nothing.

## Identifying a ROM set from its contents

When the filename is unreliable (a browser-mangled `mslug (1).zip`) but the ROM
files inside must keep their canonical names, recover the driver from the zip's
**contents** with the opt-in `@wasm-gaming/fbneo-wasm/romset` helper. It matches
the CRC-32s stored in the zip's central directory against a dataset of every
FBNeo ROM set — the same identity FBNeo uses internally — so it is unaffected by
re-compression, entry reordering, or split/merged packaging.

```js
import { RomsetIndex, resolveDriver } from '@wasm-gaming/fbneo-wasm/romset';

// Load the dataset for the system(s) you support (per-system JSON, loaded on demand).
const neogeo = await fetch('/romsets/neogeo.json').then((r) => r.json());
const index = new RomsetIndex([neogeo]);

const match = resolveDriver(romZipBytes, index); // { driver: 'mslug', coverage: 1, ... } | null
const play = await new FbneoSDK()
  .options({ driver: match?.driver ?? '' })   // fall back to your own logic when null
  .assets({ rom: romZipBytes })
  .mount(stage)
  .start();
```

The dataset is `data/romsets/<system>.json` in the repo and ships next to the SDK as
`fbneo/romsets/<system>.json` (package export `./romsets/*`); `index.json` lists the
systems and game counts. Regenerate it from a pinned FBNeo checkout with `make romsets`.

Each ROM entry carries its internal name (`n`) and CRC-32 (`c`). `neogeo.json`
additionally carries each chip's size (`s`) and hardware region (`r`) — the chip
*layout* — which is what lets the `neo` helper below rebuild a ROM set from a
flash-cart image.

Because the match is by CRC-32 — and FBNeo itself looks ROM chips up by CRC
before falling back to their names — a set is usually accepted as downloaded:
extra files, subdirectories, and non-canonical chip filenames inside the zip do
not matter. Only the zip's *name* has to resolve to a driver, which is exactly
what this helper supplies.

## Neo Geo `.neo` files (NeoSD / Terraonion)

FBNeo reads `.zip` and `.7z` ROM sets only. A `.neo` — the single-file format for
NeoSD/Terraonion flash carts, and how most Neo Geo homebrew is distributed — is a
4 KiB header followed by each ROM region as one contiguous blob (with the sprite
region byte-interleaved as the cartridge wires it), so it cannot be handed to the
engine as-is. The opt-in `@wasm-gaming/fbneo-wasm/neo` helper rebuilds the chip
split FBNeo expects, in the browser and with no dependencies:

```js
import { isNeoFile, neoToRomset } from '@wasm-gaming/fbneo-wasm/neo';

const neogeo = await fetch('/romsets/neogeo.json').then((r) => r.json());

if (isNeoFile(bytes)) {
  const { driver, zip } = neoToRomset(bytes, neogeo); // throws if it cannot be rebuilt
  await new FbneoSDK().options({ driver }).assets({ rom: zip }).mount(stage).start();
}
```

It identifies the driver by matching the `.neo`'s region sizes against the chip
layouts in `data/romsets/neogeo.json`, rebuilds the individual chip dumps
(de-interleaving sprites, undoing the `HARDWARE_SNK_SWAPP` program-ROM swap), and
CRC-32 verifies every chip before returning — so it throws loudly rather than
handing the engine a broken set. The zip it returns is *stored*, not deflated:
FBNeo decompresses each chip immediately, so compressing would only be undone.

The same conversion is available offline, which is handy for preparing a set once
rather than on every page load:

```sh
node scripts/neo2romset.mjs mygame.neo --out ./roms   # needs `make build-lib`
```

Sets whose program ROM lives inside the SMA custom chip cannot be reproduced by a
straight carve; those fail CRC verification and are reported rather than written.

## Build

```sh
make build-sdk    # TypeScript → dist/fbneo/ (no WASM), with the app and the datasets
make build-wasm   # FBNeo → WebAssembly in the pinned emscripten/emsdk:6.0.2 (Docker)
make demo         # the no-build demo page → dist/index.html
make test         # type-check, then the tests against the built package
make preview      # serve dist/ with COOP/COEP
make romsets      # regenerate data/romsets/*.json from the pinned FBNeo checkout
```

`scripts/build-fbneo.sh` fetches FBNeo at a pinned commit and ports its SDL2 burner to
Emscripten: every source patch checks it applied, so a moved upstream fails the build
instead of producing a broken engine. FBNeo's own blocking loop runs under ASYNCIFY and
paces itself to the driver's frame rate on the real-time clock (not the monitor's refresh);
`scripts/web_bridge.cpp` adds the SDK's handles (pause, reset, NVRAM flush, save states).

## Project Specs

- Contract: engine-specs 1.0 (`FbneoSDK` / `FbneoPlay`), self-contained ESM.
- Engine: FBNeo pinned (see `FBNEO_REV` in `scripts/build-fbneo.sh`), Emscripten 6.0.2, ASYNCIFY.
- Storage: OPFS `fbneo/<namespace>/` (NVRAM, hiscores, save states).
- App: `dist/fbneo/app/app.js` (EngineApp), driver identified by content.
- Records: [RECORD/](RECORD/).

## Todos

- Verify game-level behaviour with real ROM sets (pause, reset, states, NVRAM round trip).
- Move the FBNeo pin forward (later upstream changed the audio code the build patches).

## License

MIT for this wrapper. FBNeo has its own non-commercial license; ROM sets and BIOS images
belong to their owners and are never shipped.
