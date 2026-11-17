/**
 * Remapping the arcade controls, in front of FBNeo.
 *
 * FBNeo reads player 1 through Emscripten's SDL2: the keyboard when no pad is there at start,
 * else the first pad through SDL's game-controller layer (`-joy`). Its bindings are compiled
 * in, so a player's bindings are applied before SDL sees anything:
 *
 * - **Keys**: a physical key bound to a control is swallowed and replayed as the key FBNeo binds
 *   that control to by default; a default key no control has any more is swallowed.
 * - **Pads**: `navigator.getGamepads()` is wrapped while the game runs, and each pad's buttons
 *   are reordered so that the button a player chose sits where FBNeo's default looks for it.
 *
 * Fire 5 and 6 have no default key, so they are pad-only.
 */

/** A control a player can rebind: its default key (`KeyboardEvent.code` / `.key`), if any, and pad button. */
export interface FbneoControlSpec {
  id: string;
  label: string;
  code?: string;
  key?: string;
  /** Its button by default (standard mapping), as SDL's game-controller layer gives it to FBNeo. */
  button: number;
}

/** FBNeo's default bindings for player 1 (README: keyboard and `-joy`). */
export const FBNEO_CONTROLS: readonly FbneoControlSpec[] = Object.freeze([
  { id: 'fire1', label: 'Fire 1', code: 'KeyZ', key: 'z', button: 0 },
  { id: 'fire2', label: 'Fire 2', code: 'KeyX', key: 'x', button: 1 },
  { id: 'fire3', label: 'Fire 3', code: 'KeyC', key: 'c', button: 2 },
  { id: 'fire4', label: 'Fire 4', code: 'KeyV', key: 'v', button: 3 },
  { id: 'fire5', label: 'Fire 5', button: 4 },
  { id: 'fire6', label: 'Fire 6', button: 5 },
  { id: 'coin', label: 'Coin', code: 'Digit5', key: '5', button: 8 },
  { id: 'start', label: 'Start', code: 'Digit1', key: '1', button: 9 },
  { id: 'up', label: 'Up', code: 'ArrowUp', key: 'ArrowUp', button: 12 },
  { id: 'down', label: 'Down', code: 'ArrowDown', key: 'ArrowDown', button: 13 },
  { id: 'left', label: 'Left', code: 'ArrowLeft', key: 'ArrowLeft', button: 14 },
  { id: 'right', label: 'Right', code: 'ArrowRight', key: 'ArrowRight', button: 15 },
]);

/** The player's bindings, by control id: physical keys and pad buttons. */
export interface FbneoControls {
  keys?: Record<string, string>;
  buttons?: Record<string, number>;
}

export interface FbneoControlTables {
  /** Physical key → the control's default key, for the keys that moved. */
  keys: Map<string, FbneoControlSpec>;
  /** Default keys no control has any more. */
  blocked: Set<string>;
  /** Default button → the button the player chose for that control, where they differ. */
  pad: Map<number, number>;
}

export function controlTables(controls: FbneoControls = {}): FbneoControlTables {
  const keys = new Map<string, FbneoControlSpec>();
  const bound = new Set<string>();
  const pad = new Map<number, number>();
  for (const control of FBNEO_CONTROLS) {
    if (control.code !== undefined) {
      const physical = controls.keys?.[control.id] ?? control.code;
      bound.add(physical);
      if (physical !== control.code) keys.set(physical, control);
    }
    const button = controls.buttons?.[control.id] ?? control.button;
    if (button !== control.button) pad.set(control.button, button);
  }
  const blocked = new Set(
    FBNEO_CONTROLS.flatMap((control) => (control.code === undefined || bound.has(control.code) ? [] : [control.code])),
  );
  return { keys, blocked, pad };
}

type PadLike = {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly timestamp: number;
  readonly axes: readonly number[];
  readonly buttons: ReadonlyArray<{ pressed: boolean; touched?: boolean; value: number }>;
};

/** A pad with its buttons reordered by `pad` (default button → chosen button). */
export function remapPad<T extends PadLike>(source: T, table: ReadonlyMap<number, number>): PadLike {
  if (table.size === 0) return source;
  const buttons = [...source.buttons];
  for (const [target, from] of table) {
    const button = source.buttons[from];
    buttons[target] = button ? { pressed: button.pressed, touched: button.touched ?? button.pressed, value: button.value } : { pressed: false, touched: false, value: 0 };
  }
  // A button taken for a control does only that: where it was not itself a control's
  // default slot, what the engine would read there by default is released.
  const targets = new Set(table.keys());
  for (const from of table.values()) {
    if (!targets.has(from)) buttons[from] = { pressed: false, touched: false, value: 0 };
  }
  return {
    id: source.id,
    index: source.index,
    connected: source.connected,
    mapping: source.mapping,
    timestamp: source.timestamp,
    axes: source.axes,
    buttons,
  };
}

/** `KeyboardEvent.keyCode` of the default keys, which SDL's Emscripten port also reads. */
const KEY_CODES: Readonly<Record<string, number>> = {
  Enter: 13,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};
export const keyCodeOf = (control: FbneoControlSpec): number =>
  KEY_CODES[control.code ?? ''] ?? (control.key ?? '').toUpperCase().charCodeAt(0);
