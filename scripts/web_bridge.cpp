// The SDK's handles on FBNeo, appended to src/burner/sdl/main.cpp by build-fbneo.sh.
//
// FBNeo runs its own blocking loop (RunMessageLoop, yielding through ASYNCIFY), not an
// emscripten main loop, so pausing has to happen inside it: the loop is patched to
// skip RunIdle() while bWebPaused is set. These are called from JS while that loop
// sleeps between frames, so the machine is never mid-frame.
//
// Saves live in /save (the build points szAppEEPROMPath and szAppHiscorePath there):
// <driver>.fs is the NVRAM/EEPROM StatedAuto() writes, <driver>.hi the hiscores,
// slot_N.fs the save states. The SDK mirrors the folder to OPFS.

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

extern bool do_reset_game; // inp_sdl2.cpp: read as a pressed F3, the burner's reset

// Read by RunMessageLoop() (patched): set, the loop ends and FBNeo exits the game the
// way it does on desktop (driver exit, NVRAM written), so nothing keeps running.
int bWebQuit = 0;
// Read by RunMessageLoop() (patched): set, the loop skips RunIdle() — nothing is
// emulated. The burner's own bRunPause can't be used: RunIdle() still emulates with it.
int bWebPaused = 0;

extern "C" {

// 1 while a game is loaded and running. Right after callMain() it tells the SDK
// whether FBNeo could load the set at all (missing ROMs or BIOS end main() at once).
EMSCRIPTEN_KEEPALIVE int web_running(void)
{
	return bDrvOkay && !bWebQuit;
}

// End the game: the loop returns at its next turn. For destroy().
EMSCRIPTEN_KEEPALIVE void web_quit(void)
{
	bWebQuit = 1;
}

// 1: freeze the machine and its sound; 0: run again.
EMSCRIPTEN_KEEPALIVE void web_set_paused(int paused)
{
	if (paused && !bWebPaused) {
		bWebPaused = 1;
		AudSoundStop();
	} else if (!paused && bWebPaused) {
		bWebPaused = 0;
		AudSoundPlay();
	}
}

// Soft reset on the next frame the machine runs.
EMSCRIPTEN_KEEPALIVE void web_reset(void)
{
	do_reset_game = true;
}

// ---- Memory card (Neo Geo) --------------------------------------------------
// The core exposes its card through BurnAreaScan(ACB_MEMCARD); only FBNeo's Windows
// front end drives it, so the SDL build never inserted one. One raw card file per
// game in /save (the core's whole card buffer), so it lands in OPFS with the saves.

static int bWebCard = 0;
static char szWebCardPath[MAX_PATH];

static INT32 __cdecl WebCardRead(struct BurnArea* pba)
{
	memset(pba->Data, 0, pba->nLen); // no file yet: a blank card, as FBNeo creates them
	FILE* fp = fopen(szWebCardPath, "rb");
	if (fp) {
		fread(pba->Data, 1, pba->nLen, fp);
		fclose(fp);
	}
	return 0;
}

static INT32 __cdecl WebCardWrite(struct BurnArea* pba)
{
	FILE* fp = fopen(szWebCardPath, "wb");
	if (!fp) return 1;
	fwrite(pba->Data, 1, pba->nLen, fp);
	fclose(fp);
	return 0;
}

// Insert the game's card (/save/<driver>.card, or a blank one). 1 when the driver has
// a card slot and it was inserted.
EMSCRIPTEN_KEEPALIVE int web_memcard_insert(void)
{
	if (!bDrvOkay) return 0;
	snprintf(szWebCardPath, MAX_PATH, "/save/%s.card", BurnDrvGetText(DRV_NAME));
	INT32 nMin = 0;
	BurnAcb = WebCardRead;
	BurnAreaScan(ACB_WRITE | ACB_MEMCARD | ACB_MEMCARD_ACTION, &nMin);
	bWebCard = 1;
	return 1;
}

// Set a DIP setting by the names the driver gives them ("BIOS" → "AES World") — the
// write FBNeo's own DIP menu does (burner/sdl/inpdipsw.cpp). It reaches the driver
// on the next frame; settings read at reset (the Neo Geo BIOS) need web_reset().
// 1 when the group and the option were found.
EMSCRIPTEN_KEEPALIVE int web_set_dip(const char* group, const char* option)
{
	if (!bDrvOkay || !group || !option) return 0;
	struct BurnDIPInfo bdi;
	INT32 nOffset = 0;
	for (INT32 i = 0; BurnDrvGetDIPInfo(&bdi, i) == 0; i++) {
		if (bdi.nFlags == 0xF0) { nOffset = bdi.nInput; break; }
	}
	for (INT32 i = 0; BurnDrvGetDIPInfo(&bdi, i) == 0; i++) {
		if (!(bdi.nFlags & 0x40) || !bdi.szText || strcmp(bdi.szText, group) != 0) continue;
		for (INT32 j = 1; j <= bdi.nSetting; j++) {
			struct BurnDIPInfo opt;
			if (BurnDrvGetDIPInfo(&opt, i + j) != 0) break;
			if (!opt.szText || strcmp(opt.szText, option) != 0) continue;
			struct GameInp* pgi = GameInp + opt.nInput + nOffset;
			pgi->Input.Constant.nConst = (pgi->Input.Constant.nConst & ~opt.nMask) | (opt.nSetting & opt.nMask);
			return 1;
		}
		return 0;
	}
	return 0;
}

// Write NVRAM/EEPROM — and the memory card, when one is inserted — now (upstream only
// does it at exit). 0 when no game is running.
EMSCRIPTEN_KEEPALIVE int web_persist(void)
{
	if (!bDrvOkay) return 0;
	StatedAuto(1);
	if (bWebCard) {
		BurnAcb = WebCardWrite;
		BurnAreaScan(ACB_READ | ACB_MEMCARD, NULL);
	}
	return 1;
}

static void web_state_name(char *out, int slot)
{
	snprintf(out, MAX_PATH, "/save/slot_%d.fs", slot);
}

// Save the whole machine to /save/slot_<slot>.fs. 1 on success.
EMSCRIPTEN_KEEPALIVE int web_save_state(int slot)
{
	if (!bDrvOkay) return 0;
	char name[MAX_PATH];
	web_state_name(name, slot);
	return BurnStateSave(name, 1) == 0;
}

// Load /save/slot_<slot>.fs into the running game. 1 on success.
EMSCRIPTEN_KEEPALIVE int web_load_state(int slot)
{
	if (!bDrvOkay) return 0;
	char name[MAX_PATH];
	web_state_name(name, slot);
	return BurnStateLoad(name, 1, NULL) == 0;
}

} // extern "C"
#endif
