// FBNeo's own app: the game plus suspend points the way the Nintendo Classic Mini
// does them, on the wasm-gaming usability scheme (engine-specs UX.md). The same app
// as blastem-wasm's, on FBNeo's SDK.
//
//   import * as app from '<engines>/fbneo/app/app.js'
//   const handle = await app.mount(target, host)   // EngineApp.mount
//
// - Leaving writes the *unsaved* suspend point (with its frame): nothing is lost.
// - Coming back with any suspend point shows them: the unsaved one, four slots, and
//   "from the beginning". Y saves the unsaved point into a slot; Y on a saved one
//   locks / unlocks or deletes it.
// - In game, Select+Start or Escape opens the pause menu, with the four slots in it: an
//   empty one saves the moment at once; a saved one opens Cargar (focused) · Guardar aquí ·
//   Bloquear · Borrar.
// - By touch: the hints are buttons (A, B, Y), and a long press on a card is Y.
//
// Which game: FBNeo boots a ROM set by its driver name (`mslug`), and the host hands
// over bytes, not a name. The app recovers the driver from the CRC-32s inside the zip
// (the `romset` helper and the datasets in ../romsets/), rebuilds a `.neo` image into
// a ROM set, and falls back to the host's game slug.
//
// Plain JS and DOM: it ships next to the SDK and imports nothing else.

import FbneoSDK, { AUTO_STATE_SLOT, FBNEO_CONTROLS, STATE_SLOTS } from '../fbneo.sdk.js';
import {
  SHARED_SETTINGS,
  controlsModel,
  createFullscreenToggle,
  createPerfCounter,
  createSettingsScreen,
  createWakeLock,
  loadSettings,
  resolveLocale,
  saveSettings,
  settingsDefaults,
  settingsModel,
} from '../engine-specs.js';

import { RomsetIndex, resolveDriver } from '../romset.js';
import { isNeoFile, neoToRomset } from '../neo.js';

/** The systems searched first: most arcade sets a player brings are one of these. */
export const FIRST_SYSTEMS = ['neogeo', 'capcom', 'cps3', 'cave', 'konami', 'sega'];

const romsetsUrl = new URL('../romsets/', import.meta.url);
const fetchSystem = async (system) => {
  const response = await fetch(new URL(`${system}.json`, romsetsUrl));
  if (!response.ok) throw new Error(`fbneo app: no dataset for ${system}`);
  return response.json();
};
const fetchSystems = async () => {
  const response = await fetch(new URL('index.json', romsetsUrl));
  if (!response.ok) return FIRST_SYSTEMS;
  const { systems } = await response.json();
  const all = systems.map((entry) => entry.system);
  return [...FIRST_SYSTEMS.filter((s) => all.includes(s)), ...all.filter((s) => !FIRST_SYSTEMS.includes(s))];
};

/**
 * The driver for a ROM the host handed over, and the bytes to boot.
 *
 * `.neo` images are rebuilt into a ROM set (Neo Geo dataset). Zips are matched by
 * content, system by system, stopping at the first match; nothing matching leaves
 * the host's slug. `load(system)` and `systems()` are injectable for tests.
 */
export async function identifyDriver(bytes, { slug = '', load = fetchSystem, systems = fetchSystems } = {}) {
  if (isNeoFile(bytes)) {
    const { driver, zip } = neoToRomset(bytes, await load('neogeo'));
    return { rom: zip, driver, how: 'neo' };
  }
  let names = FIRST_SYSTEMS;
  try {
    names = await systems();
  } catch {
    /* the first ones, then */
  }
  for (const system of names) {
    let data;
    try {
      data = await load(system);
    } catch {
      continue;
    }
    const match = resolveDriver(bytes, new RomsetIndex([data]));
    if (match) return { rom: bytes, driver: match.driver, how: 'content' };
  }
  return { rom: bytes, driver: String(slug).trim(), how: 'slug' };
}

const OWNER = 'app';
const ENGINE_ID = 'fbneo';

/** The app's words, in English and Spanish (engine-specs UX.md, "Languages"). */
const STRINGS = {
  booting: { en: 'Starting the engine…', es: 'Arrancando el motor…' },
  today: { en: 'Today · {time}', es: 'Hoy · {time}' },
  yesterday: { en: 'Yesterday · {time}', es: 'Ayer · {time}' },
  slot: { en: 'slot', es: 'hueco' },
  saveHere: { en: 'save here', es: 'guardar aquí' },
  cancelHint: { en: 'cancel', es: 'cancelar' },
  choose: { en: 'choose', es: 'elegir' },
  playHint: { en: 'play', es: 'jugar' },
  saveToSlot: { en: 'save to a slot', es: 'guardar en un hueco' },
  options: { en: 'options', es: 'opciones' },
  backHint: { en: 'back', es: 'volver' },
  quitHint: { en: 'quit', es: 'salir' },
  saveHereOrOptions: { en: 'options', es: 'opciones' },
  continueHint: { en: 'continue', es: 'continuar' },
  fromStart: { en: 'From the beginning', es: 'Desde el principio' },
  unsaved: { en: 'Unsaved', es: 'Sin guardar' },
  empty: { en: 'Empty', es: 'Vacío' },
  bootFailed: { en: 'Could not start', es: 'No se pudo arrancar' },
  back: { en: 'Back', es: 'Volver' },
  whichSlot: { en: 'Which slot does it go in?', es: '¿En qué hueco lo guardas?' },
  points: { en: 'Suspend points', es: 'Puntos de suspensión' },
  paused: { en: 'Paused', es: 'Pausa' },
  point: { en: 'Point {n}', es: 'Punto {n}' },
  continue: { en: 'Continue', es: 'Continuar' },
  restart: { en: 'Restart', es: 'Reiniciar' },
  restartHint: { en: 'machine reset', es: 'reset de la máquina' },
  identifying: { en: 'Identifying the game…', es: 'Identificando el juego…' },
  noRom: { en: 'There is no ROM for this game.', es: 'No hay ROM para este juego.' },
  noDriver: { en: 'Game not recognized: the FBNeo driver name is missing.', es: 'No se reconoce el juego: falta el nombre del driver de FBNeo.' },
  settings: { en: 'Settings', es: 'Ajustes' },
  fullscreen: { en: 'Fullscreen', es: 'Pantalla completa' },
  fullscreenHint: { en: 'Alt+Enter · Select + Y', es: 'Alt+Enter · Select + Y' },
  fullscreenHintMac: { en: 'Cmd+Enter · Select + Y', es: 'Cmd+Enter · Select + Y' },
  exit: { en: 'Back to the launcher', es: 'Volver al lanzador' },
  exitHint: { en: 'a suspend point is kept', es: 'se queda un punto de suspensión' },
  savedIn: { en: 'Saved in slot {n}', es: 'Guardado en el hueco {n}' },
  loadFailed: { en: 'Could not load that point', es: 'No se pudo cargar ese punto' },
  slotLocked: { en: 'That slot is locked', es: 'Ese hueco está bloqueado' },
  allLocked: { en: 'The four slots are locked', es: 'Los cuatro huecos están bloqueados' },
  load: { en: 'Load', es: 'Cargar' },
  saveHereItem: { en: 'Save here', es: 'Guardar aquí' },
  unlockFirst: { en: 'unlock it first', es: 'desbloquéalo antes' },
  replaces: { en: 'replaces what is there', es: 'sustituye lo que hay' },
  overwriteAsk: { en: 'Overwrite point {n}?', es: '¿Sobrescribir el punto {n}?' },
  overwrite: { en: 'Overwrite', es: 'Sobrescribir' },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  unlock: { en: 'Unlock', es: 'Desbloquear' },
  lock: { en: 'Lock', es: 'Bloquear' },
  unlockHint: { en: 'it can be overwritten and deleted', es: 'se podrá sobrescribir y borrar' },
  lockHint: { en: 'so it is not overwritten or deleted', es: 'que no se sobrescriba ni se borre' },
  delete: { en: 'Delete', es: 'Borrar' },
  deleteAsk: { en: 'Delete point {n}?', es: '¿Borrar el punto {n}?' },
  noUndo: { en: 'This cannot be undone.', es: 'No se puede deshacer.' },
  saving: { en: 'Saving the suspend point…', es: 'Guardando el punto de suspensión…' },
  leaveAsk: { en: 'Back to the launcher?', es: '¿Volver al lanzador?' },
  leave: { en: 'Leave', es: 'Salir' },
  stay: { en: 'Stay', es: 'Seguir' },
};

const DIRECTIONS = {
  up: { en: 'Up', es: 'Arriba' },
  down: { en: 'Down', es: 'Abajo' },
  left: { en: 'Left', es: 'Izquierda' },
  right: { en: 'Right', es: 'Derecha' },
};
/** The arcade controls (player 1), for Ajustes → Controles. */
const FIRE = { en: 'Fire {n}', es: 'Disparo {n}' };
const CONTROL_LABELS = { coin: { en: 'Coin', es: 'Moneda' } };
const labelOf = (c) => {
  const fire = /^fire(\d)$/.exec(c.id);
  if (fire) return { en: FIRE.en.replace('{n}', fire[1]), es: FIRE.es.replace('{n}', fire[1]) };
  return DIRECTIONS[c.id] ?? CONTROL_LABELS[c.id] ?? c.label;
};
const BUTTONS = FBNEO_CONTROLS.map((c) => ({ id: c.id, label: labelOf(c) }));
const DEFAULT_CONTROLS = Object.fromEntries(FBNEO_CONTROLS.map((c) => [c.id, { code: c.code, button: c.button }]));
/** Bindings (engine-specs) → what `play.setControls()` takes. */
const toFbneoControls = (bindings) => ({
  keys: Object.fromEntries(Object.entries(bindings).filter(([, b]) => b.code).map(([id, b]) => [id, b.code])),
  buttons: Object.fromEntries(Object.entries(bindings).filter(([, b]) => Number.isInteger(b.button)).map(([id, b]) => [id, b.button])),
});
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let cssLoaded = null;
const loadCss = () =>
  (cssLoaded ??= new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./app.css', import.meta.url).href;
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  }));

const whenIn = (t, locale) => (date) => {
  if (!date) return '';
  const now = new Date();
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return t('today', { time });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t('yesterday', { time });
  return `${date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} · ${time}`;
};

const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm1.6 0h3.8V5a1.9 1.9 0 0 0-3.8 0z"/></svg>';
const RESTART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/></svg>';

export async function mount(target, host) {
  await loadCss();

  const locale = host.locale ?? resolveLocale();
  const t = (key, params = {}) =>
    (STRINGS[key]?.[locale] ?? STRINGS[key]?.en ?? key).replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  const when = whenIn(t, locale);

  const root = document.createElement('div');
  root.className = 'fbn-app';
  root.style.setProperty('--accent', host.game?.accent ?? '#9f1239');
  const stage = document.createElement('div');
  stage.className = 'fbn-stage';
  const overlay = document.createElement('div');
  overlay.className = 'fbn-overlay';
  root.append(stage, overlay);
  target.append(root);

  /**
   * screen: boot | points | game | pause | sheet | confirm | error
   * `points.picking`: choosing the slot the unsaved point goes to.
   * `points.from`: 'boot' (top level) or 'pause' (one level down).
   */
  const state = {
    screen: 'boot',
    status: t('booting'),
    error: null,
    cards: [], // [{ kind: 'start' | 'auto' | 'slot', slot, info }]
    focus: 0,
    from: 'boot',
    picking: false,
    // The pause menu: Continuar, the four slots (a row), Reiniciar, Ajustes, Pantalla completa,
    // Volver al lanzador.
    // focus: { kind: 'item' | 'slot', i }; col: the slot the row comes back to.
    pause: { items: [], slots: [], focus: { kind: 'item', i: 0 }, col: 0 },
    sheet: null, // { slot, items, focus }
    confirm: null, // { title, text, yes, no, onYes, under, focus }
    toast: null,
    started: false, // the game has run since boot (so "from the beginning" is a reset)
  };

  let play = null;
  let leaving = false;
  let destroyed = false;
  let frame = null; // the frame captured as the pause menu opened
  const urls = new Set();
  const blobUrl = (blob) => {
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
  };
  const dropUrls = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const canvasFocus = () => stage.querySelector('canvas')?.focus({ preventScroll: true });

  // ---- data -----------------------------------------------------------------------

  const readPoints = () => {
    dropUrls();
    const auto = play.states.get(AUTO_STATE_SLOT);
    const slots = play.states.list();
    state.cards = [
      { kind: 'start' },
      ...(auto.savedAt ? [{ kind: 'auto', slot: AUTO_STATE_SLOT, info: auto, img: blobUrl(auto.thumbnail) }] : []),
      ...slots.map((info) => ({ kind: 'slot', slot: info.slot, info, img: blobUrl(info.thumbnail) })),
    ];
  };
  const hasPoints = () => state.cards.some((card) => card.kind !== 'start' && card.info.savedAt);
  const cardAt = (i) => state.cards[i];

  // ---- render ---------------------------------------------------------------------

  // A hint with an action is also a button: tapping it does what the gamepad button
  // would (on a phone the menus are tapped). One without is the gamepad's only.
  const hints = (pairs) =>
    `<footer class="fbn-hints">${pairs
      .map(([k, t, act]) =>
        act
          ? `<button class="hint" data-act="${act}"><kbd>${k}</kbd>${t}</button>`
          : `<span class="is-pad"><kbd>${k}</kbd>${t}</span>`,
      )
      .join('')}</footer>`;

  const pointCard = (card, i) => {
    const focused = state.focus === i ? ' is-focused' : '';
    const target = state.picking && card.kind === 'slot' && !card.info.locked ? ' is-target' : '';
    const dim = state.picking && !(card.kind === 'slot' && !card.info.locked) ? ' is-dim' : '';
    if (card.kind === 'start') {
      return `<button class="point is-start${focused}${dim}" data-card="${i}">
        <span class="point-frame">${RESTART}</span>
        <span class="point-label">${esc(t('fromStart'))}</span>
        <span class="point-date">&nbsp;</span>
      </button>`;
    }
    const { info } = card;
    const empty = !info.savedAt;
    const label = card.kind === 'auto' ? t('unsaved') : `${card.slot + 1}`;
    return `<button class="point${card.kind === 'auto' ? ' is-auto' : ''}${empty ? ' is-empty' : ''}${info.locked ? ' is-locked' : ''}${focused}${target}${dim}" data-card="${i}">
      <span class="point-frame">${card.img ? `<img src="${card.img}" alt="">` : ''}${info.locked ? `<i class="point-lock">${LOCK}</i>` : ''}</span>
      <span class="point-label">${esc(label)}</span>
      <span class="point-date">${empty ? esc(t('empty')) : esc(when(info.savedAt))}</span>
    </button>`;
  };

  const pointsHints = () => {
    if (state.picking) return hints([['←→', t('slot')], ['A', t('saveHere'), 'accept'], ['B', t('cancelHint'), 'back']]);
    const card = cardAt(state.focus);
    const pairs = [['←→', t('choose')]];
    if (card?.kind === 'start' || card?.info?.savedAt) pairs.push(['A', t('playHint'), 'accept']);
    if (card?.kind === 'auto') pairs.push(['Y', t('saveToSlot'), 'more']);
    if (card?.kind === 'slot' && card.info.savedAt) pairs.push(['Y', t('options'), 'more']);
    pairs.push(['B', state.from === 'pause' ? t('backHint') : t('quitHint'), 'back']);
    return hints(pairs);
  };

  const slotCard = ({ info, img }, i, focused) => {
    const empty = !info.savedAt;
    return `<button class="slot${focused ? ' is-focused' : ''}${empty ? ' is-empty' : ''}${info.locked ? ' is-locked' : ''}" data-slot="${i}">
      <span class="point-frame">${img ? `<img src="${img}" alt="">` : ''}${info.locked ? `<i class="point-lock">${LOCK}</i>` : ''}</span>
      <span class="slot-label">${info.slot + 1}</span>
      <span class="slot-date">${empty ? esc(t('empty')) : esc(when(info.savedAt))}</span>
    </button>`;
  };

  const pauseHints = () => {
    const f = state.pause.focus;
    if (f.kind === 'slot') {
      const saved = !!state.pause.slots[f.i]?.info.savedAt;
      return hints([['←→', t('slot')], ['A', saved ? t('options') : t('saveHere')], ['B', t('continueHint')]]);
    }
    // Gamepad-only: by touch, "Continuar" is the first item already.
    return hints([['A', t('choose')], ['B', t('continueHint')]]);
  };

  const render = () => {
    if (destroyed) return;
    const s = state.screen;
    wake.setActive(s === 'game' && setting('keepScreenOn') !== false);
    if (s === 'settings') return;
    const base = s === 'confirm' || s === 'sheet' ? (state.confirm?.under ?? state.sheet?.under) : s;
    root.dataset.screen = base;
    if (s === 'game') {
      overlay.innerHTML = state.toast ? `<p class="fbn-toast">${esc(state.toast)}</p>` : '';
      return;
    }
    if (s === 'boot') {
      overlay.innerHTML = `<section class="fbn-boot">
        ${host.game?.art ? `<img src="${esc(host.game.art)}" alt="">` : ''}
        <p>${esc(state.status)}</p>
      </section>`;
      return;
    }
    if (s === 'error') {
      overlay.innerHTML = `<section class="fbn-panel">
        <p class="kicker">${esc(host.game?.title ?? 'FBNeo')}</p>
        <h2>${esc(t('bootFailed'))}</h2>
        <p class="text">${esc(state.error)}</p>
        <button class="item is-focused" data-exit>${esc(t('back'))}</button>
      </section>`;
      return;
    }
    let html = '';
    if (base === 'points') {
      html += `<section class="fbn-points">
        <header>
          <p class="kicker">${esc(host.game?.title ?? '')}</p>
          <h2>${esc(state.picking ? t('whichSlot') : t('points'))}</h2>
        </header>
        <div class="points">${state.cards.map(pointCard).join('')}</div>
        ${pointsHints()}
      </section>`;
    } else if (base === 'pause') {
      const P = state.pause;
      const on = (kind, i) => s === 'pause' && P.focus.kind === kind && P.focus.i === i;
      const item = (i) => {
        const it = P.items[i];
        return `<button class="item${on('item', i) ? ' is-focused' : ''}" data-item="${i}">${esc(it.label)}${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`;
      };
      html += `<section class="fbn-panel is-pause">
        <p class="kicker">${esc(host.game?.title ?? '')}</p>
        <h2>${esc(t('paused'))}</h2>
        ${item(0)}
        <p class="slots-label">${esc(t('points'))}</p>
        <div class="slots">${P.slots.map((slot, i) => slotCard(slot, i, on('slot', i))).join('')}</div>
        ${P.items.slice(1).map((_, i) => item(i + 1)).join('')}
        ${pauseHints()}
      </section>`;
    }
    if (s === 'sheet') {
      const sh = state.sheet;
      html += `<div class="fbn-layer"><section class="fbn-panel is-small">
        <h2>${esc(t('point', { n: sh.slot + 1 }))}</h2>
        ${sh.items.map((item, i) => `<button class="item${item.danger ? ' is-danger' : ''}${i === sh.focus ? ' is-focused' : ''}" data-sheet="${i}" ${item.disabled ? 'disabled' : ''}>${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`).join('')}
        ${hints([['B', t('backHint')]])}
      </section></div>`;
    }
    if (s === 'confirm') {
      const c = state.confirm;
      html += `<div class="fbn-layer"><section class="fbn-panel is-small">
        <h2>${esc(c.title)}</h2>
        ${c.text ? `<p class="text">${esc(c.text)}</p>` : ''}
        <div class="row">
          <button class="item${c.focus === 0 ? ' is-focused' : ''}" data-confirm="0">${esc(c.no)}</button>
          <button class="item is-danger${c.focus === 1 ? ' is-focused' : ''}" data-confirm="1">${esc(c.yes)}</button>
        </div>
      </section></div>`;
    }
    if (state.toast) html += `<p class="fbn-toast">${esc(state.toast)}</p>`;
    overlay.innerHTML = html;
    const row = overlay.querySelector('.points');
    const focused = row?.querySelector('.point.is-focused');
    if (row && focused && row.scrollWidth > row.clientWidth) {
      row.scrollLeft = focused.offsetLeft - (row.clientWidth - focused.offsetWidth) / 2;
    }
  };

  let toastTimer = null;
  const toast = (text) => {
    state.toast = text;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toast = null;
      render();
    }, 2600);
  };

  // ---- transitions ----------------------------------------------------------------

  const enterGame = () => {
    state.screen = 'game';
    state.picking = false;
    state.started = true;
    render();
    host.input.suspend();
    play.resume(OWNER);
    canvasFocus();
  };

  const showPoints = (from) => {
    readPoints();
    state.from = from;
    state.picking = false;
    // Focus the unsaved point, else the newest saved one, else "from the beginning".
    const auto = state.cards.findIndex((c) => c.kind === 'auto');
    let newest = -1;
    state.cards.forEach((c, i) => {
      if (c.kind === 'slot' && c.info.savedAt && (newest < 0 || c.info.savedAt > state.cards[newest].info.savedAt)) newest = i;
    });
    state.focus = auto >= 0 ? auto : newest >= 0 ? newest : 0;
    state.screen = 'points';
    play.pause(OWNER);
    host.input.resume();
    render();
  };

  /** Write the unsaved point with the frame taken when the game was last on screen. */
  const suspend = async () => {
    try {
      await play.states.save(AUTO_STATE_SLOT, { thumbnail: frame });
    } catch (error) {
      console.warn('[fbneo app] could not write the suspend point', error);
    }
  };

  const openPause = async ({ capture = false } = {}) => {
    // The frame first: once paused there is no picture left to read.
    if (capture) frame = await play.snapshot().catch(() => null);
    play.pause(OWNER);
    state.pause = {
      focus: { kind: 'item', i: 0 },
      col: state.pause.col ?? 0,
      slots: [],
      items: [
        { label: t('continue'), run: enterGame },
        { label: t('restart'), hint: t('restartHint'), run: restart },
        { label: t('settings'), run: openSettings },
        {
          label: t('fullscreen'),
          hint: /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? t('fullscreenHintMac') : t('fullscreenHint'),
          run: () => fullscreen.toggle(),
        },
        { label: t('exit'), hint: t('exitHint'), run: leave },
      ],
    };
    readPauseSlots();
    state.screen = 'pause';
    host.input.resume();
    render();
  };

  const restart = async () => {
    enterGame();
    await play.restart();
  };

  // ---- save states in the pause menu ---------------------------------------------

  const readPauseSlots = () => {
    dropUrls();
    state.pause.slots = play.states.list().map((info) => ({ info, img: blobUrl(info.thumbnail) }));
  };

  /** The moment the menu opened (its frame was taken then) into slot row position `i`. */
  const saveIntoSlot = async (i) => {
    const { info } = state.pause.slots[i];
    await play.states.save(info.slot, { thumbnail: frame });
    readPauseSlots();
    toast(t('savedIn', { n: info.slot + 1 }));
  };

  const loadSlot = (slot) => {
    state.sheet = null;
    if (!play.states.load(slot)) {
      state.screen = 'pause';
      return toast(t('loadFailed'));
    }
    enterGame();
  };

  /** A saved slot's sheet, from the pause menu: Cargar first and focused. */
  const openSlotSheet = (i) => {
    const { info } = state.pause.slots[i];
    const n = info.slot + 1;
    const locked = info.locked;
    state.sheet = {
      under: 'pause',
      slot: info.slot,
      focus: 0,
      items: [
        { label: t('load'), hint: when(info.savedAt), run: () => loadSlot(info.slot) },
        {
          label: t('saveHereItem'),
          disabled: locked,
          hint: locked ? t('unlockFirst') : t('replaces'),
          run: () => {
            closeSheet();
            ask({
              title: t('overwriteAsk', { n }),
              text: when(info.savedAt),
              yes: t('overwrite'),
              no: t('cancel'),
              onYes: () => saveIntoSlot(i),
            });
          },
        },
        {
          label: locked ? t('unlock') : t('lock'),
          hint: locked ? t('unlockHint') : t('lockHint'),
          run: async () => {
            await play.states.lock(info.slot, !locked);
            closeSheet();
            readPauseSlots();
            render();
          },
        },
        {
          label: t('delete'),
          danger: true,
          disabled: locked,
          hint: locked ? t('unlockFirst') : null,
          run: () => {
            closeSheet();
            ask({
              title: t('deleteAsk', { n }),
              text: t('noUndo'),
              yes: t('delete'),
              no: t('cancel'),
              onYes: async () => {
                await play.states.remove(info.slot);
                readPauseSlots();
                render();
              },
            });
          },
        },
        { label: t('cancel'), run: () => closeSheet() },
      ],
    };
    state.screen = 'sheet';
    render();
  };

  /** A slot chosen in the pause menu: an empty one saves at once, a saved one opens its sheet. */
  const onSlot = async (i) => {
    const slot = state.pause.slots[i];
    if (!slot) return;
    state.pause.focus = { kind: 'slot', i };
    state.pause.col = i;
    if (slot.info.savedAt) return openSlotSheet(i);
    if (slot.info.locked) return toast(t('slotLocked'));
    await saveIntoSlot(i);
  };

  /** Up / down between the rows, left / right along the slots. */
  const onPause = async (action) => {
    const P = state.pause;
    // Rows: the first item, the slots, then the other items.
    const PAUSE_ROWS = P.items.length + 1;
    const row = P.focus.kind === 'slot' ? 1 : P.focus.i === 0 ? 0 : P.focus.i + 1;
    const at = (r) => (r === 1 ? { kind: 'slot', i: P.col } : { kind: 'item', i: r === 0 ? 0 : r - 1 });
    if (action === 'up') P.focus = at((row + PAUSE_ROWS - 1) % PAUSE_ROWS);
    else if (action === 'down') P.focus = at((row + 1) % PAUSE_ROWS);
    else if ((action === 'left' || action === 'right') && P.focus.kind === 'slot') {
      P.col = Math.max(0, Math.min(P.slots.length - 1, P.focus.i + (action === 'left' ? -1 : 1)));
      P.focus = { kind: 'slot', i: P.col };
    } else if (action === 'accept') {
      if (P.focus.kind === 'slot') return onSlot(P.focus.i);
      return P.items[P.focus.i].run();
    } else if (action === 'more' && P.focus.kind === 'slot') {
      if (P.slots[P.focus.i]?.info.savedAt) return openSlotSheet(P.focus.i);
      return;
    } else if (action === 'back' || action === 'menu') return enterGame();
    else return;
    render();
  };

  const playCard = async (card) => {
    if (card.kind === 'start') {
      if (state.started) return restart();
      return enterGame();
    }
    if (!card.info.savedAt) return;
    if (!play.states.load(card.slot)) return toast(t('loadFailed'));
    enterGame();
  };

  const freeSlot = () => state.cards.findIndex((c) => c.kind === 'slot' && !c.info.savedAt && !c.info.locked);

  const saveAutoInto = async (i) => {
    const card = cardAt(i);
    await play.states.copy(AUTO_STATE_SLOT, card.slot);
    readPoints();
    state.picking = false;
    state.focus = state.cards.findIndex((c) => c.kind === 'slot' && c.slot === card.slot);
    toast(t('savedIn', { n: card.slot + 1 }));
  };

  const saveAuto = async () => {
    const free = freeSlot();
    if (free >= 0) return saveAutoInto(free);
    const target = state.cards.findIndex((c) => c.kind === 'slot' && !c.info.locked);
    if (target < 0) return toast(t('allLocked'));
    state.picking = true;
    state.focus = target;
    render();
  };

  const openSheet = (card) => {
    const locked = card.info.locked;
    state.sheet = {
      under: 'points',
      slot: card.slot,
      focus: 0,
      items: [
        {
          label: locked ? t('unlock') : t('lock'),
          hint: locked ? t('unlockHint') : t('lockHint'),
          run: async () => {
            await play.states.lock(card.slot, !locked);
            closeSheet();
            readPoints();
            render();
          },
        },
        {
          label: t('delete'),
          danger: true,
          disabled: locked,
          hint: locked ? t('unlockFirst') : null,
          run: () => {
            closeSheet();
            ask({
              title: t('deleteAsk', { n: card.slot + 1 }),
              text: t('noUndo'),
              yes: t('delete'),
              no: t('cancel'),
              onYes: async () => {
                await play.states.remove(card.slot);
                readPoints();
                render();
              },
            });
          },
        },
        { label: t('cancel'), run: () => closeSheet() },
      ],
    };
    state.screen = 'sheet';
    render();
  };
  const closeSheet = () => {
    state.screen = state.sheet.under;
    state.sheet = null;
    render();
  };

  const ask = (options) => {
    state.confirm = { focus: 0, under: state.screen, ...options };
    state.screen = 'confirm';
    render();
  };
  const answer = (yes) => {
    const c = state.confirm;
    state.screen = c.under;
    state.confirm = null;
    render();
    if (yes) c.onYes?.();
  };

  const exit = async () => {
    if (leaving) return;
    leaving = true;
    try {
      await play?.destroy();
    } catch (error) {
      console.warn('[fbneo app] destroy failed', error);
    }
    play = null;
    host.exit();
  };

  /** Leaving from a running game keeps it as the unsaved suspend point. */
  const leave = async () => {
    if (leaving) return;
    state.status = t('saving');
    state.screen = 'boot';
    render();
    await suspend();
    await exit();
  };

  // ---- settings, fullscreen, performance (engine-specs 0.6) -----------------------

  // The player's choices, per engine (OPFS settings/mgba.json): FBNeo's options, the shared
  // ones (keep the screen on, show performance) and the controls.
  let saved = { version: 1, values: {}, controls: {} };
  const setting = (key) => (key in saved.values ? saved.values[key] : SHARED_SETTINGS[key]?.default);
  const store = () => saveSettings(ENGINE_ID, saved).catch((error) => console.warn('[fbneo app] settings not saved', error));
  const engineValues = () =>
    Object.fromEntries(Object.entries(saved.values).filter(([key]) => !(key in SHARED_SETTINGS)));

  const fullscreen = createFullscreenToggle(root);
  const wake = createWakeLock();
  const perf = createPerfCounter(root, { locale });
  let offFrames = () => {};
  const applyShared = () => {
    if (setting('showPerformance')) perf.show();
    else perf.hide();
    wake.setActive(state.screen === 'game' && setting('keepScreenOn') !== false);
  };

  let screen = null;
  // FBNeo's player-facing settings are in its config (smoothing); its options say which game.
  let configKeys = new Set();
  const described = async () => {
    const config = await play.config();
    configKeys = new Set(Object.keys(config));
    return { ...config, ...(await play.options()), ...SHARED_SETTINGS };
  };
  const write = (values) => {
    const config = Object.fromEntries(Object.entries(values).filter(([key]) => configKeys.has(key)));
    const options = Object.fromEntries(Object.entries(values).filter(([key]) => !configKeys.has(key)));
    if (Object.keys(config).length) play.config(config);
    if (Object.keys(options).length) play.options(options);
  };
  const controlRows = () => controlsModel(BUTTONS, DEFAULT_CONTROLS, saved.controls, locale);

  const openSettings = async () => {
    const all = await described();
    const model = () => settingsModel(all, saved.values, locale);
    state.screen = 'settings';
    render();
    overlay.innerHTML = '';
    const layer = document.createElement('div');
    layer.className = 'fbn-layer fbn-settings';
    overlay.append(layer);
    screen = createSettingsScreen(layer, {
      sections: model(),
      controls: controlRows(),
      input: host.input,
      locale,
      onChange(key, value) {
        saved.values = { ...saved.values, [key]: value };
        // FBNeo's own options go to the engine: a live one applies now, the rest on Reiniciar.
        if (key in SHARED_SETTINGS) applyShared();
        else write({ [key]: value });
        void store();
      },
      onControl(_id, _binding, bindings) {
        saved.controls = bindings;
        play.setControls(toFbneoControls(bindings));
        void store();
      },
      onReset() {
        const defaults = settingsDefaults(all);
        saved = { version: 1, values: {}, controls: {} };
        write(Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in SHARED_SETTINGS))));
        play.setControls({});
        applyShared();
        void store();
        screen.update(settingsModel(all, defaults, locale), controlRows());
      },
      onClose: () => {
        screen?.destroy();
        screen = null;
        void openPause();
      },
    });
  };

  // ---- input ----------------------------------------------------------------------

  const onPoints = (action) => {
    const n = state.cards.length;
    const movable = (i) => !state.picking || (cardAt(i)?.kind === 'slot' && !cardAt(i).info.locked);
    const step = (dir) => {
      for (let i = state.focus + dir; i >= 0 && i < n; i += dir) {
        if (movable(i)) return (state.focus = i);
      }
    };
    const card = cardAt(state.focus);
    if (action === 'left' || action === 'prev' || action === 'up') step(-1);
    else if (action === 'right' || action === 'next' || action === 'down') step(1);
    else if (action === 'accept') {
      if (!state.picking) return playCard(card);
      if (!card.info.savedAt) return saveAutoInto(state.focus);
      return ask({
        title: t('overwriteAsk', { n: card.slot + 1 }),
        text: when(card.info.savedAt),
        yes: t('overwrite'),
        no: t('cancel'),
        onYes: () => saveAutoInto(state.focus),
      });
    } else if (action === 'more' && !state.picking) {
      if (card.kind === 'auto') return saveAuto();
      if (card.kind === 'slot' && card.info.savedAt) return openSheet(card);
      return;
    } else if (action === 'back' || action === 'menu') {
      if (state.picking) {
        state.picking = false;
        state.focus = state.cards.findIndex((c) => c.kind === 'auto');
      } else if (state.from === 'pause') return openPause();
      else
        return ask({ title: t('leaveAsk'), yes: t('leave'), no: t('stay'), onYes: exit });
    } else return;
    render();
  };

  const onList = (list, action, close) => {
    const n = list.items.length;
    if (action === 'up') list.focus = (list.focus + n - 1) % n;
    else if (action === 'down') list.focus = (list.focus + 1) % n;
    else if (action === 'accept') {
      const item = list.items[list.focus];
      if (!item.disabled) return item.run();
      return;
    } else if (action === 'back' || action === 'menu') return close();
    else return;
    render();
  };

  const onConfirm = (action) => {
    const c = state.confirm;
    if (action === 'left' || action === 'up') c.focus = 0;
    else if (action === 'right' || action === 'down') c.focus = 1;
    else if (action === 'accept') return answer(c.focus === 1);
    else if (action === 'back') return answer(false);
    else return;
    render();
  };

  let busy = false;
  const onAction = async (action) => {
    if (leaving || busy) return;
    busy = true;
    try {
      const s = state.screen;
      if (s === 'settings') return;
      if (s === 'game') {
        if (action === 'menu') await openPause({ capture: true });
      } else if (s === 'points') await onPoints(action);
      else if (s === 'pause') await onPause(action);
      else if (s === 'sheet') await onList(state.sheet, action, closeSheet);
      else if (s === 'confirm') await onConfirm(action);
      else if (s === 'error' && (action === 'accept' || action === 'back')) await exit();
    } catch (error) {
      console.error('[fbneo app]', error);
      toast(error?.message ?? String(error));
    } finally {
      busy = false;
    }
  };
  const off = host.input.on(onAction);

  // Pointer: hover (real movement only — a render replaces what is under a resting
  // cursor) focuses, click activates; the same paths as the pad.
  let lastPointer = '';
  const onPointer = async (event) => {
    if (event.type === 'click' && longPressed) {
      // The lift after a long press: the press already did its job.
      longPressed = false;
      return;
    }
    const el = event.target.closest('[data-card],[data-item],[data-slot],[data-sheet],[data-confirm],[data-exit],[data-act]');
    if (!el || leaving || busy) return;
    if (el.dataset.act != null) {
      if (event.type === 'click') await onAction(el.dataset.act);
      return;
    }
    if (event.type === 'pointermove') {
      const at = `${event.clientX},${event.clientY}`;
      if (at === lastPointer) return;
      lastPointer = at;
      if (state.screen === 'pause' && (el.dataset.item != null || el.dataset.slot != null)) {
        const focus = el.dataset.slot != null ? { kind: 'slot', i: +el.dataset.slot } : { kind: 'item', i: +el.dataset.item };
        const P = state.pause;
        if (P.focus.kind !== focus.kind || P.focus.i !== focus.i) {
          P.focus = focus;
          if (focus.kind === 'slot') P.col = focus.i;
          render();
        }
        return;
      }
      const key = el.dataset.card ?? el.dataset.item ?? el.dataset.sheet;
      if (key == null) return;
      const list = el.dataset.card != null ? state : el.dataset.item != null ? state.pause : state.sheet;
      if (list && list.focus !== +key) {
        list.focus = +key;
        render();
      }
      return;
    }
    busy = true;
    try {
      if (el.dataset.card != null) {
        state.focus = +el.dataset.card;
        busy = false;
        return onPoints('accept');
      }
      if (el.dataset.item != null) await state.pause.items[+el.dataset.item].run();
      else if (el.dataset.slot != null) await onSlot(+el.dataset.slot);
      else if (el.dataset.sheet != null) {
        const item = state.sheet.items[+el.dataset.sheet];
        if (!item.disabled) await item.run();
      } else if (el.dataset.confirm != null) answer(el.dataset.confirm === '1');
      else if (el.dataset.exit != null) await exit();
    } finally {
      busy = false;
    }
  };
  overlay.addEventListener('click', onPointer);
  overlay.addEventListener('pointermove', onPointer);

  // Touch: a long press on a card focuses it and does what Y does (save the unsaved point
  // into a slot; a saved point's options) — a tap would play it.
  const LONG_PRESS_MS = 500;
  let longPressed = false;
  let press = null;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const onPressDown = (event) => {
    cancelPress();
    longPressed = false;
    if (event.pointerType === 'mouse') return;
    const el = event.target.closest('[data-card]');
    if (!el || state.screen !== 'points') return;
    const index = +el.dataset.card;
    press = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(async () => {
        press = null;
        longPressed = true;
        if (leaving || busy || state.screen !== 'points') return;
        state.focus = index;
        render();
        await onAction('more');
      }, LONG_PRESS_MS),
    };
  };
  const onPressMove = (event) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) cancelPress();
  };
  const noMenu = (event) => event.preventDefault();
  overlay.addEventListener('pointerdown', onPressDown);
  overlay.addEventListener('pointermove', onPressMove);
  overlay.addEventListener('pointerup', cancelPress);
  overlay.addEventListener('pointercancel', cancelPress);
  overlay.addEventListener('contextmenu', noMenu);

  const handle = {
    async unmount() {
      destroyed = true;
      leaving = true;
      off();
      clearTimeout(toastTimer);
      overlay.removeEventListener('click', onPointer);
      overlay.removeEventListener('pointermove', onPointer);
      cancelPress();
      overlay.removeEventListener('pointerdown', onPressDown);
      overlay.removeEventListener('pointermove', onPressMove);
      overlay.removeEventListener('pointerup', cancelPress);
      overlay.removeEventListener('pointercancel', cancelPress);
      overlay.removeEventListener('contextmenu', noMenu);
      try {
        await play?.destroy();
      } catch {
        /* already gone */
      }
      play = null;
      dropUrls();
      screen?.destroy();
      offFrames();
      fullscreen.destroy();
      wake.destroy();
      perf.destroy();
      root.remove();
    },
  };

  // ---- boot -----------------------------------------------------------------------

  render();
  host.input.resume();
  try {
    saved = await loadSettings(ENGINE_ID);
    state.status = t('identifying');
    render();
    const bytes = await host.assets.rom?.();
    if (!bytes) throw new Error(t('noRom'));
    const { rom, driver, how } = await identifyDriver(bytes, { slug: host.game?.slug });
    if (!driver) throw new Error(t('noDriver'));
    console.info(`[fbneo app] driver ${driver} (${how})`);
    state.status = t('booting');
    render();
    play = await new FbneoSDK()
      .mount(stage)
      .options({ driver, ...(host.options?.neogeo ? { neogeo: host.options.neogeo } : {}) })
      .assets({ ...host.assets, rom })
      .storage(host.storage)
      // The saved smoothing: FBNeo's config.
      .config(engineValues())
      .on('error', ({ detail }) => console.error('[fbneo app]', detail))
      .on('exit', () => exit())
      .start();
    if (destroyed) {
      await play.destroy().catch(() => {});
      play = null;
      return handle;
    }
    play.setControls(toFbneoControls({ ...DEFAULT_CONTROLS, ...saved.controls }));
    // FBNeo's loop runs inside the WASM and reports no frames: the counter counts the display's.
    applyShared();
    readPoints();
    if (hasPoints()) showPoints('boot');
    else enterGame();
  } catch (error) {
    console.error('[fbneo app]', error);
    state.error = error?.message ?? String(error);
    state.screen = 'error';
    render();
  }

  return handle;
}

export { STATE_SLOTS };
