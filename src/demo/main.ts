import { load } from '@wasm-gaming/fbneo-wasm';
import type { EngineEvent, EngineInstance } from '@wasm-gaming/engine-specs';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const romPicker = document.getElementById('rom-picker') as HTMLInputElement;
const biosPicker = document.getElementById('bios-picker') as HTMLInputElement;
const driverInput = document.getElementById('driver') as HTMLInputElement;
const btnLoad = document.getElementById('btn-load') as HTMLButtonElement;

let engine: EngineInstance | null = null;

async function fileBytes(input: HTMLInputElement): Promise<Uint8Array | null> {
  const file = input.files?.[0];
  if (!file) return null;
  return new Uint8Array(await file.arrayBuffer());
}

// Convenience: prefill the romset name from the picked file (minus extension).
// The user can still override it — FBNeo needs the exact short name (e.g. "mslug").
romPicker.addEventListener('change', () => {
  if (driverInput.value) return;
  const name = romPicker.files?.[0]?.name;
  if (name) driverInput.value = name.replace(/\.(zip|7z)$/i, '');
});

btnLoad.addEventListener('click', async () => {
  const rom = await fileBytes(romPicker);
  if (!rom) {
    alert('Pick an arcade ROM zip first.');
    return;
  }
  const driver = driverInput.value.trim();
  if (!driver) {
    alert('Enter the FBNeo romset name (e.g. "mslug").');
    return;
  }
  const bios = await fileBytes(biosPicker);

  if (engine) engine.destroy();

  const assets: Record<string, Uint8Array> = { rom };
  if (bios) assets.bios = bios;

  engine = await load({
    canvas,
    assets,
    options: { driver, renderFilter: 'pixelated' },
    onEvent: (e: EngineEvent) => console.log('[fbneo]', e),
  });
  engine.start();
});
