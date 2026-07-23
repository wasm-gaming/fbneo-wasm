import { load } from '@wasm-gaming/fbneo-wasm';
import type { EngineEvent, EngineInstance } from '@wasm-gaming/engine-specs';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const romPicker = document.getElementById('rom-picker') as HTMLInputElement;
const biosPicker = document.getElementById('bios-picker') as HTMLInputElement;
const btnLoad = document.getElementById('btn-load') as HTMLButtonElement;

let engine: EngineInstance | null = null;

async function fileBytes(input: HTMLInputElement): Promise<Uint8Array | null> {
  const file = input.files?.[0];
  if (!file) return null;
  return new Uint8Array(await file.arrayBuffer());
}

btnLoad.addEventListener('click', async () => {
  const rom = await fileBytes(romPicker);
  if (!rom) {
    alert('Pick an arcade ROM zip first.');
    return;
  }
  const bios = await fileBytes(biosPicker);
  const romFileName = romPicker.files?.[0]?.name;

  if (engine) engine.destroy();

  const assets: Record<string, Uint8Array> = { rom };
  if (bios) assets.bios = bios;

  engine = await load({
    canvas,
    assets,
    options: romFileName ? { romFileName, renderFilter: 'pixelated' } : { renderFilter: 'pixelated' },
    onEvent: (e: EngineEvent) => console.log('[fbneo]', e),
  });
  engine.start();
});
