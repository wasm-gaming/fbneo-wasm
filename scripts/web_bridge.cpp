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

// Write NVRAM/EEPROM now (upstream only does it at exit). 0 when no game is running.
EMSCRIPTEN_KEEPALIVE int web_persist(void)
{
	if (!bDrvOkay) return 0;
	StatedAuto(1);
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
