# @wasm-gaming/fbneo-wasm — build & preview
#
#   make build       The package: SDK + WASM → dist/
#   make build-sdk   TypeScript only (fast, no Docker) → dist/fbneo/
#   make build-wasm  FBNeo → WebAssembly, in the pinned emsdk image (Docker)
#   make demo        The no-build demo page → dist/index.html
#   make test        Type-check, then the tests against the built package
#   make preview     Serve dist/ with COOP/COEP
#   make romsets     Regenerate data/romsets/*.json from FBNeo's driver source
#
# All build logic lives here (package.json has no scripts).

BIN := node_modules/.bin
PORT ?= 8027
SPECS := node_modules/@wasm-gaming/engine-specs

.PHONY: build build-sdk build-app build-romsets build-lib build-specs build-wasm build-wasm-ci demo romsets \
	typecheck test release-check preview i install clean help

i: install
install: ## Install dependencies
	npm install

node_modules: package.json
	npm install
	@touch node_modules

build: build-wasm build-sdk demo ## The package and the demo: WASM + SDK → dist/

build-sdk: build-lib build-specs build-app build-romsets ## The published SDK: TypeScript → dist/fbneo/ (no WASM)

build-romsets: ## The ROM-set datasets beside the SDK (the app identifies sets with them) → dist/fbneo/romsets/
	rm -rf dist/fbneo/romsets
	mkdir -p dist/fbneo
	cp -R data/romsets dist/fbneo/romsets

build-app: ## The engine's own app (boot screen + pause menu) → dist/fbneo/app/
	# Plain JS + CSS, mounted by hosts as <engine>/app/app.js (EngineApp); it imports
	# the SDK next to it relatively.
	rm -rf dist/fbneo/app
	mkdir -p dist/fbneo/app
	cp src/app/app.js src/app/app.css dist/fbneo/app/

build-lib: node_modules ## Compile SDK + options + romset/neo helpers → dist/fbneo/
	$(BIN)/tsc -p tsconfig.json

build-specs: build-lib ## Ship the contract runtime beside the SDK and import it relatively
	# The SDK extends the contract's base classes, so engine-specs is a runtime
	# import. Copied into dist/fbneo/ (inside `files`) and the emitted imports
	# rewritten to it: the package loads from any static server, no import map.
	cp $(SPECS)/dist/engine-specs.js dist/fbneo/engine-specs.js
	node scripts/localize-specs.mjs dist/fbneo

build-wasm: ## FBNeo → WebAssembly via the pinned emsdk image (Docker) → dist/fbneo/
	bash scripts/build-fbneo-docker.sh

build-wasm-ci: ## Same build, run directly (CI runs inside the emsdk container)
	bash scripts/build-fbneo.sh

demo: ## The no-build demo page → dist/index.html
	cp src/demo/index.html dist/index.html

# The FBNeo checkout the WASM build fetches into (see scripts/build-fbneo.sh).
FBNEO_DRV ?= .tmp/fbneo-build/src/burn/drv

romsets: ## Regenerate data/romsets/*.json from the FBNeo driver source ($(FBNEO_DRV))
	@test -d "$(FBNEO_DRV)" || { echo "error: $(FBNEO_DRV) not found — run 'make build-wasm' first, or set FBNEO_DRV=<fbneo>/src/burn/drv"; exit 1; }
	node scripts/gen-romset-index.mjs --src "$(FBNEO_DRV)" --out data/romsets

typecheck: node_modules ## Type-check the SDK
	$(BIN)/tsc -p tsconfig.json --noEmit

test: typecheck build-sdk ## Type-check, then run tests/ against the built package
	node --test tests/*.test.mjs

release-check: build-sdk test ## npm pack preview
	npm config get registry
	npm pack --dry-run

preview: ## Serve dist/ with COOP/COEP headers
	@echo "Serving dist/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 scripts/preview-server.py --port $(PORT) --directory dist

clean: ## Remove build outputs
	@if [ -d dist ]; then find dist -mindepth 1 -delete; fi

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
