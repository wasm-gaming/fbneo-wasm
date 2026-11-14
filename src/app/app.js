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
// - In game, Select+Start or Escape opens the pause menu.
//
// Which game: FBNeo boots a ROM set by its driver name (`mslug`), and the host hands
// over bytes, not a name. The app recovers the driver from the CRC-32s inside the zip
// (the `romset` helper and the datasets in ../romsets/), rebuilds a `.neo` image into
// a ROM set, and falls back to the host's game slug.
//
// Plain JS and DOM: it ships next to the SDK and imports nothing else.

import FbneoSDK, { AUTO_STATE_SLOT, STATE_SLOTS } from '../fbneo.sdk.js';
import { RomsetIndex, resolveDriver } from '../romset.js';
import { isNeoFile, neoToRomset } from '../neo.js';

const OWNER = 'app';

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

const when = (date) => {
  if (!date) return '';
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `Hoy · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Ayer · ${time}`;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${time}`;
};

const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm1.6 0h3.8V5a1.9 1.9 0 0 0-3.8 0z"/></svg>';
const RESTART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/></svg>';

export async function mount(target, host) {
  await loadCss();

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
    status: 'Arrancando el motor…',
    error: null,
    cards: [], // [{ kind: 'start' | 'auto' | 'slot', slot, info }]
    focus: 0,
    from: 'boot',
    picking: false,
    pause: { items: [], focus: 0 },
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

  const hints = (pairs) =>
    `<footer class="fbn-hints">${pairs.map(([k, t]) => `<span><kbd>${k}</kbd>${t}</span>`).join('')}</footer>`;

  const pointCard = (card, i) => {
    const focused = state.focus === i ? ' is-focused' : '';
    const target = state.picking && card.kind === 'slot' && !card.info.locked ? ' is-target' : '';
    const dim = state.picking && !(card.kind === 'slot' && !card.info.locked) ? ' is-dim' : '';
    if (card.kind === 'start') {
      return `<button class="point is-start${focused}${dim}" data-card="${i}">
        <span class="point-frame">${RESTART}</span>
        <span class="point-label">Desde el principio</span>
        <span class="point-date">&nbsp;</span>
      </button>`;
    }
    const { info } = card;
    const empty = !info.savedAt;
    const label = card.kind === 'auto' ? 'Sin guardar' : `${card.slot + 1}`;
    return `<button class="point${card.kind === 'auto' ? ' is-auto' : ''}${empty ? ' is-empty' : ''}${info.locked ? ' is-locked' : ''}${focused}${target}${dim}" data-card="${i}">
      <span class="point-frame">${card.img ? `<img src="${card.img}" alt="">` : ''}${info.locked ? `<i class="point-lock">${LOCK}</i>` : ''}</span>
      <span class="point-label">${esc(label)}</span>
      <span class="point-date">${empty ? 'Vacío' : esc(when(info.savedAt))}</span>
    </button>`;
  };

  const pointsHints = () => {
    if (state.picking) return hints([['←→', 'hueco'], ['A', 'guardar aquí'], ['B', 'cancelar']]);
    const card = cardAt(state.focus);
    const pairs = [['←→', 'elegir']];
    if (card?.kind === 'start' || card?.info?.savedAt) pairs.push(['A', 'jugar']);
    if (card?.kind === 'auto') pairs.push(['Y', 'guardar en un hueco']);
    if (card?.kind === 'slot' && card.info.savedAt) pairs.push(['Y', 'opciones']);
    pairs.push(['B', state.from === 'pause' ? 'volver' : 'salir']);
    return hints(pairs);
  };

  const render = () => {
    if (destroyed) return;
    const s = state.screen;
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
        <h2>No se pudo arrancar</h2>
        <p class="text">${esc(state.error)}</p>
        <button class="item is-focused" data-exit>Volver</button>
      </section>`;
      return;
    }
    let html = '';
    if (base === 'points') {
      html += `<section class="fbn-points">
        <header>
          <p class="kicker">${esc(host.game?.title ?? '')}</p>
          <h2>${state.picking ? '¿En qué hueco lo guardas?' : 'Puntos de suspensión'}</h2>
        </header>
        <div class="points">${state.cards.map(pointCard).join('')}</div>
        ${pointsHints()}
      </section>`;
    } else if (base === 'pause') {
      html += `<section class="fbn-panel">
        <p class="kicker">${esc(host.game?.title ?? '')}</p>
        <h2>Pausa</h2>
        ${state.pause.items.map((item, i) => `<button class="item${i === state.pause.focus && s === 'pause' ? ' is-focused' : ''}" data-item="${i}">${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`).join('')}
        ${hints([['A', 'elegir'], ['B', 'continuar']])}
      </section>`;
    }
    if (s === 'sheet') {
      const sh = state.sheet;
      html += `<div class="fbn-layer"><section class="fbn-panel is-small">
        <h2>Punto ${sh.slot + 1}</h2>
        ${sh.items.map((item, i) => `<button class="item${item.danger ? ' is-danger' : ''}${i === sh.focus ? ' is-focused' : ''}" data-sheet="${i}" ${item.disabled ? 'disabled' : ''}>${esc(item.label)}${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</button>`).join('')}
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
      focus: 0,
      items: [
        { label: 'Continuar', run: enterGame },
        {
          label: 'Puntos de suspensión',
          hint: 'guarda este momento y elige dónde dejarlo',
          run: async () => {
            await suspend();
            showPoints('pause');
          },
        },
        { label: 'Reiniciar', hint: 'reset de la máquina', run: restart },
        { label: 'Volver al lanzador', hint: 'se queda un punto de suspensión', run: leave },
      ],
    };
    state.screen = 'pause';
    host.input.resume();
    render();
  };

  const restart = async () => {
    enterGame();
    await play.restart();
  };

  const playCard = async (card) => {
    if (card.kind === 'start') {
      if (state.started) return restart();
      return enterGame();
    }
    if (!card.info.savedAt) return;
    if (!play.states.load(card.slot)) return toast('No se pudo cargar ese punto');
    enterGame();
  };

  const freeSlot = () => state.cards.findIndex((c) => c.kind === 'slot' && !c.info.savedAt && !c.info.locked);

  const saveAutoInto = async (i) => {
    const card = cardAt(i);
    await play.states.copy(AUTO_STATE_SLOT, card.slot);
    readPoints();
    state.picking = false;
    state.focus = state.cards.findIndex((c) => c.kind === 'slot' && c.slot === card.slot);
    toast(`Guardado en el hueco ${card.slot + 1}`);
  };

  const saveAuto = async () => {
    const free = freeSlot();
    if (free >= 0) return saveAutoInto(free);
    const target = state.cards.findIndex((c) => c.kind === 'slot' && !c.info.locked);
    if (target < 0) return toast('Los cuatro huecos están bloqueados');
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
          label: locked ? 'Desbloquear' : 'Bloquear',
          hint: locked ? 'se podrá sobrescribir y borrar' : 'que no se sobrescriba ni se borre',
          run: async () => {
            await play.states.lock(card.slot, !locked);
            closeSheet();
            readPoints();
            render();
          },
        },
        {
          label: 'Borrar',
          danger: true,
          disabled: locked,
          hint: locked ? 'desbloquéalo antes' : null,
          run: () => {
            closeSheet();
            ask({
              title: `¿Borrar el punto ${card.slot + 1}?`,
              text: 'No se puede deshacer.',
              yes: 'Borrar',
              no: 'Cancelar',
              onYes: async () => {
                await play.states.remove(card.slot);
                readPoints();
                render();
              },
            });
          },
        },
        { label: 'Cancelar', run: () => closeSheet() },
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
    state.status = 'Guardando el punto de suspensión…';
    state.screen = 'boot';
    render();
    await suspend();
    await exit();
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
        title: `¿Sobrescribir el punto ${card.slot + 1}?`,
        text: when(card.info.savedAt),
        yes: 'Sobrescribir',
        no: 'Cancelar',
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
        return ask({ title: '¿Volver al lanzador?', yes: 'Salir', no: 'Seguir', onYes: exit });
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
  const off = host.input.on(async (action) => {
    if (leaving || busy) return;
    busy = true;
    try {
      const s = state.screen;
      if (s === 'game') {
        if (action === 'menu') await openPause({ capture: true });
      } else if (s === 'points') await onPoints(action);
      else if (s === 'pause') await onList(state.pause, action, enterGame);
      else if (s === 'sheet') await onList(state.sheet, action, closeSheet);
      else if (s === 'confirm') await onConfirm(action);
      else if (s === 'error' && (action === 'accept' || action === 'back')) await exit();
    } catch (error) {
      console.error('[fbneo app]', error);
      toast(error?.message ?? String(error));
    } finally {
      busy = false;
    }
  });

  // Pointer: hover (real movement only — a render replaces what is under a resting
  // cursor) focuses, click activates; the same paths as the pad.
  let lastPointer = '';
  const onPointer = async (event) => {
    const el = event.target.closest('[data-card],[data-item],[data-sheet],[data-confirm],[data-exit]');
    if (!el || leaving || busy) return;
    if (event.type === 'pointermove') {
      const at = `${event.clientX},${event.clientY}`;
      if (at === lastPointer) return;
      lastPointer = at;
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

  const handle = {
    async unmount() {
      destroyed = true;
      leaving = true;
      off();
      clearTimeout(toastTimer);
      overlay.removeEventListener('click', onPointer);
      overlay.removeEventListener('pointermove', onPointer);
      try {
        await play?.destroy();
      } catch {
        /* already gone */
      }
      play = null;
      dropUrls();
      root.remove();
    },
  };

  // ---- boot -----------------------------------------------------------------------

  render();
  host.input.resume();
  try {
    state.status = 'Identificando el juego…';
    render();
    const bytes = await host.assets.rom?.();
    if (!bytes) throw new Error('No hay ROM para este juego.');
    const { rom, driver, how } = await identifyDriver(bytes, { slug: host.game?.slug });
    if (!driver) throw new Error('No se reconoce el juego: falta el nombre del driver de FBNeo.');
    console.info(`[fbneo app] driver ${driver} (${how})`);
    state.status = 'Arrancando el motor…';
    render();
    play = await new FbneoSDK()
      .mount(stage)
      .options({ driver, ...(host.options?.neogeo ? { neogeo: host.options.neogeo } : {}) })
      .assets({ ...host.assets, rom })
      .storage(host.storage)
      .on('error', ({ detail }) => console.error('[fbneo app]', detail))
      .on('exit', () => exit())
      .start();
    if (destroyed) {
      await play.destroy().catch(() => {});
      play = null;
      return handle;
    }
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
