import type { JSONSchema } from '@wasm-gaming/engine-specs';

export interface FbneoOptions {
  /**
   * Filename used when writing the ROM zip bytes to Emscripten MEMFS.
   * FBNeo identifies a game by the zip filename (without extension), so this
   * should match the driver's expected ROM set name (e.g. "mslug" for Metal Slug).
   */
  romFileName?: string;
  /**
   * The FBNeo driver/game name to load (e.g. "mslug", "sf2", "kof98").
   * If omitted, the driver is inferred from `romFileName` (without extension).
   */
  driver?: string;
  /** Canvas scaling filter: `pixelated` for crisp pixels, `smooth` for linear filtering. */
  renderFilter?: 'pixelated' | 'smooth';
  /** Target audio sample rate in Hz. FBNeo defaults to 44100. */
  audioSampleRate?: number;
  /** Enable vertical sync. Defaults to true. */
  vsync?: boolean;
  /** Use integer scaling (no fractional stretching). Defaults to false. */
  integerScale?: boolean;
  /** Window scale multiplier for the internal render resolution. Defaults to 2. */
  windowScale?: number;
}

export const DEFAULT_FBNEO_OPTIONS: Required<FbneoOptions> = {
  romFileName: 'game.zip',
  driver: '',
  renderFilter: 'pixelated',
  audioSampleRate: 44100,
  vsync: true,
  integerScale: false,
  windowScale: 2,
};

export const FBNEO_OPTIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    romFileName: {
      type: 'string',
      default: 'game.zip',
      description: 'ROM zip filename written to Emscripten MEMFS when loading a game.',
    },
    driver: {
      type: 'string',
      default: '',
      description:
        'FBNeo driver/game name to load (e.g. "mslug"). If empty, inferred from romFileName without extension.',
    },
    renderFilter: {
      type: 'string',
      enum: ['pixelated', 'smooth'],
      default: 'pixelated',
      description: 'Canvas scaling filter: pixelated for crisp pixels, smooth for linear filtering.',
    },
    audioSampleRate: {
      type: 'integer',
      default: 44100,
      minimum: 11025,
      maximum: 96000,
      description: 'Target audio sample rate in Hz.',
    },
    vsync: {
      type: 'boolean',
      default: true,
      description: 'Enable vertical sync.',
    },
    integerScale: {
      type: 'boolean',
      default: false,
      description: 'Use integer scaling (no fractional stretching).',
    },
    windowScale: {
      type: 'integer',
      default: 2,
      minimum: 1,
      maximum: 8,
      description: 'Window scale multiplier for the internal render resolution.',
    },
  },
};