BIN := node_modules/.bin

PORT ?= 8027

.PHONY: build build-sdk build-lib build-manifest build-demo build-wasm build-wasm-ci build-wasm-docker \
	romsets preview typecheck test release-check i install clean help

i: install
install: ## Install dev dependencies
	npm install

node_modules: package.json
	npm install
	@touch node_modules

build: build-wasm build-sdk ## Full build → dist/ (WASM first, then SDK/demo)

build-sdk: build-lib build-manifest build-demo ## TypeScript + manifest + demo shell

# The FBNeo checkout the WASM build clones into (see scripts/build-fbneo.sh).
FBNEO_DRV ?= .tmp/fbneo-build/src/burn/drv

romsets: ## Regenerate data/romsets/*.json from the FBNeo driver source ($(FBNEO_DRV))
	@test -d "$(FBNEO_DRV)" || { echo "error: $(FBNEO_DRV) not found — run 'make build-wasm-ci' first, or set FBNEO_DRV=<fbneo>/src/burn/drv"; exit 1; }
	node scripts/gen-romset-index.mjs --src "$(FBNEO_DRV)" --out data/romsets

build-lib: node_modules ## Compile SDK/options/manifest → dist/fbneo/
	$(BIN)/tsc -p tsconfig.json

build-manifest: build-lib ## Serialize typed manifest → dist/manifest.json
	node scripts/emit-manifest.mjs

DEMO_SRC := node_modules/@wasm-gaming/engine-specs/demo

build-demo: build-lib ## Assemble the themable engine-specs demo shell + NEOGEO skin
	@rm -f dist/index.html dist/main.js
	cp -R $(DEMO_SRC)/. dist/
	rm -f dist/README.md
	cp src/demo/index.html dist/index.html
	cp src/demo/fbneo.css dist/fbneo.css
	@# Ship the romset-identity dataset so hosts can fetch /romsets/<system>.json.
	rm -rf dist/romsets && cp -R data/romsets dist/romsets

build-wasm: ## Build FBNeo WASM artifacts via local Docker wrapper
	bash scripts/build-fbneo-docker.sh

build-wasm-ci: ## Build FBNeo WASM artifacts directly (for CI containers)
	bash scripts/build-fbneo.sh

build-wasm-docker: build-wasm ## Alias: local Docker wrapper

typecheck: build-lib
	$(BIN)/tsc -p tsconfig.json --noEmit

test: typecheck

release-check: test
	npm config get registry
	npm pack --dry-run

preview: ## Serve dist/ with COOP/COEP headers
	@echo "Serving dist/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 scripts/preview-server.py --port $(PORT) --directory dist

clean: ## Remove build outputs
	@if [ -d dist ]; then find dist -mindepth 1 -delete; fi

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'
