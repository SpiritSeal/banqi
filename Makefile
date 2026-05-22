# Banqi P2P — native test build + WebAssembly build
#
# Targets:
#   make test       — build & run native doctest suite
#   make wasm       — produce web/banqi.js + web/banqi.wasm via Emscripten
#   make wasm-test  — node-based smoke run of the WASM module
#   make serve      — host web/ on http://localhost:8080
#   make clean

BUILD_DIR        := build
SRC_DIR          := src
TEST_DIR         := tests
THIRD_PARTY      := third_party
WEB_DIR          := web

CXX              ?= g++
CXXFLAGS_COMMON  := -std=c++17 -Wall -Wextra -O2 \
                    -I$(SRC_DIR) -I$(THIRD_PARTY) \
                    -I$(THIRD_PARTY)/doctest -I$(THIRD_PARTY)/json \
                    -I$(THIRD_PARTY)/monocypher

CC               ?= gcc
CFLAGS_COMMON    := -Wall -Wextra -O2 -I$(THIRD_PARTY)/monocypher

# --- sources ---
CPP_SOURCES := \
  $(SRC_DIR)/hash.cpp \
  $(SRC_DIR)/prng.cpp \
  $(SRC_DIR)/piece.cpp \
  $(SRC_DIR)/banqi_rules.cpp \
  $(SRC_DIR)/game.cpp

C_SOURCES := \
  $(THIRD_PARTY)/monocypher/monocypher.c \
  $(THIRD_PARTY)/monocypher/monocypher-ed25519.c

TEST_SOURCES := \
  $(TEST_DIR)/test_main.cpp \
  $(TEST_DIR)/test_hash.cpp \
  $(TEST_DIR)/test_prng.cpp \
  $(TEST_DIR)/test_banqi_rules.cpp \
  $(TEST_DIR)/test_game.cpp

# --- native build ---
NATIVE_OBJ_DIR := $(BUILD_DIR)/native
CPP_OBJS_NATIVE  := $(patsubst %.cpp,$(NATIVE_OBJ_DIR)/%.o,$(CPP_SOURCES))
C_OBJS_NATIVE    := $(patsubst %.c,$(NATIVE_OBJ_DIR)/%.o,$(C_SOURCES))
TEST_OBJS_NATIVE := $(patsubst %.cpp,$(NATIVE_OBJ_DIR)/%.o,$(TEST_SOURCES))

NATIVE_TEST_BIN := $(BUILD_DIR)/run_tests

.PHONY: test
test: $(NATIVE_TEST_BIN)
	$(NATIVE_TEST_BIN)

$(NATIVE_TEST_BIN): $(CPP_OBJS_NATIVE) $(C_OBJS_NATIVE) $(TEST_OBJS_NATIVE)
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS_COMMON) $^ -o $@

$(NATIVE_OBJ_DIR)/%.o: %.cpp
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS_COMMON) -c $< -o $@

$(NATIVE_OBJ_DIR)/%.o: %.c
	@mkdir -p $(@D)
	$(CC) $(CFLAGS_COMMON) -c $< -o $@

# --- WASM build ---
EMCC ?= emcc
WASM_BUILD_DIR := $(BUILD_DIR)/wasm
WASM_C_OBJS    := $(patsubst $(THIRD_PARTY)/%.c,$(WASM_BUILD_DIR)/%.o,$(C_SOURCES))

EMCC_CXXFLAGS := -std=c++17 -O3 \
                 -I$(SRC_DIR) -I$(THIRD_PARTY) \
                 -I$(THIRD_PARTY)/json -I$(THIRD_PARTY)/monocypher
EMCC_LDFLAGS  := -sMODULARIZE=1 -sEXPORT_NAME=createBanqiModule \
                 -sEXPORT_ES6=1 \
                 -sENVIRONMENT=web,node \
                 -sALLOW_MEMORY_GROWTH=1 \
                 -sEXPORTED_RUNTIME_METHODS=ccall,cwrap \
                 -lembind

WASM_OUT := $(WEB_DIR)/banqi.js

.PHONY: wasm
wasm: $(WASM_OUT)

$(WASM_OUT): $(CPP_SOURCES) $(SRC_DIR)/wasm_bindings.cpp $(WASM_C_OBJS)
	@mkdir -p $(WEB_DIR)
	$(EMCC) $(EMCC_CXXFLAGS) $(CPP_SOURCES) $(SRC_DIR)/wasm_bindings.cpp $(WASM_C_OBJS) $(EMCC_LDFLAGS) -o $(WASM_OUT)

$(WASM_BUILD_DIR)/%.o: $(THIRD_PARTY)/%.c
	@mkdir -p $(@D)
	$(EMCC) -O3 -c $< -o $@

.PHONY: wasm-test
wasm-test: wasm
	node tests/wasm_smoke.mjs
	node tests/replay_smoke.mjs
	node tests/board_hints_smoke.mjs

# Content-hash the service worker. Must run after `wasm` so banqi.{js,wasm}
# are present and included in the precache list. Anything in web/ that
# changes — source, icons, the wasm output — will produce a fresh BUILD_ID
# and trigger the "Update available" banner on next client load.
.PHONY: stamp-sw
stamp-sw: wasm
	node scripts/stamp-sw.mjs

# CI-only: verify the stamper was run before commit (catches a forgotten
# `make stamp-sw` after a web/ change). Doesn't mutate anything.
.PHONY: stamp-sw-check
stamp-sw-check:
	node scripts/stamp-sw.mjs --check

# CI-only: catch the cross-commit case where someone edits web/ but leaves
# BUILD_ID alone (defeating the SW update banner). Stricter than
# stamp-sw-check, which only validates the current tree against itself.
.PHONY: buildid-check
buildid-check:
	node scripts/check-buildid.mjs

# PWA validation. The manifest check is fast and dependency-free; it asserts
# the BUILD_ID hash format and that sw.js + index.html agree, so it doubles
# as a stamper sanity check. The buildid + check-buildid tests exercise the
# stamper and the cross-commit CI guard themselves.
.PHONY: pwa-test
pwa-test: stamp-sw
	node tests/pwa_manifest.mjs
	node tests/sw_buildid.mjs
	node tests/check_buildid.mjs

# Real-browser smoke. Needs a stamped SW so the precache list reflects the
# files actually served (otherwise cache.addAll 404s on banqi.wasm).
.PHONY: pwa-smoke
pwa-smoke: stamp-sw
	node tests/pwa_smoke.mjs

# Touch / pointer input on the board. The unit test runs the pure gesture
# state machine and needs no build. The browser test drives a real Chromium
# against the OTB view and needs the WASM artefact + Playwright.
.PHONY: board-input-test
board-input-test:
	node tests/board_input_unit.mjs

.PHONY: board-input-smoke
board-input-smoke: wasm
	node tests/board_input_browser.mjs

# All Playwright end-to-end tests, including the ones that boot the real
# relay (e.g. online_game_teleport_smoke — requires Postgres at
# DATABASE_URL). Run after `npx playwright install chromium`.
.PHONY: playwright
playwright: stamp-sw
	node tests/online_game_teleport_smoke.mjs
	node tests/board_input_browser.mjs
	node tests/pwa_smoke.mjs

# Regenerate web/icons/*.png from web/favicon.svg. Run after editing the
# favicon. Requires fonts-noto-cjk installed system-wide (for the 將 glyph)
# and the @resvg/resvg-js dev dependency (already pinned in package.json).
.PHONY: icons
icons:
	node scripts/gen-icons.mjs

# Lightweight dev server. Deliberately does NOT depend on stamp-sw / wasm —
# someone iterating on CSS / HTML shouldn't need an Emscripten toolchain. The
# committed sw.js is good enough for visual dev; CI and the Dockerfile stamp
# for real before anything ships. Run `make stamp-sw` manually if you need
# the SW update banner to fire while testing locally.
#
# Limitation: the AI engine now lives at top-level ai/ (see #55) and is
# imported via `../ai/index.mjs`. python's http.server refuses to serve
# paths outside its document root, so the vs-AI mode won't load under
# `make serve`. Use `make server-dev` for that — its Express app mounts
# both web/ and /ai.
.PHONY: serve
serve:
	cd $(WEB_DIR) && python3 -m http.server 8080

# Federated relay server (Node.js + SQLite). For local dev, just run
# `make server-dev` and open http://localhost:8080. Set AUTH_DEV=1 in
# server/.env for the dev-only username sign-in route.
.PHONY: server-install server-dev server-test server-docker
server-install:
	cd server && npm install

server-dev: server-install
	cd server && AUTH_DEV=1 npm run dev

server-test: server-install
	cd server && npm test

server-docker:
	docker build -t banqi-relay -f server/Dockerfile .

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR) $(WEB_DIR)/banqi.js $(WEB_DIR)/banqi.wasm
