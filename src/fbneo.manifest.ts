import type { EngineManifest } from '@wasm-gaming/engine-specs';
import { FBNEO_OPTIONS_SCHEMA } from './fbneo.options.js';

export const manifest: EngineManifest = {
  id: 'fbneo',
  version: '0.1.0',
  name: 'FinalBurn Neo (WebAssembly)',
  description:
    'FBNeo arcade emulator (Capcom CPS-1/2/3, SNK Neo Geo, Sega System 16, and more) compiled to WebAssembly.',
  artifacts: {
    wasm: 'fbneo/fbneo.wasm',
    js: 'fbneo/fbneo.js',
  },
  assets: [
    {
      key: 'rom',
      mountPath: '/roms/game.zip',
      required: true,
      accept: ['.zip', '.7z'],
      description:
        'Arcade ROM set (zip) written to Emscripten MEMFS. FBNeo identifies the game by the zip filename.',
    },
    {
      key: 'bios',
      mountPath: '/roms/neogeo.zip',
      required: false,
      accept: ['.zip'],
      description:
        'Optional system BIOS set (e.g. neogeo.zip for Neo Geo, or a CPS-3 BIOS). Required only by ROM sets that depend on it.',
    },
  ],
  input: 'fbneo',
  video: { baseWidth: 384, baseHeight: 224, aspect: '4:3' },
  options: FBNEO_OPTIONS_SCHEMA,
  capabilities: { saveStates: false, sram: false, coreSelectable: false },
};

export default manifest;
