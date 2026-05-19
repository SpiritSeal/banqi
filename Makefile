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
VERIFY_DIR       := verify
THIRD_PARTY      := third_party
WEB_DIR          := web

CXX              ?= g++
CXXFLAGS_COMMON  := -std=c++17 -Wall -Wextra -O2 \
                    -I$(SRC_DIR) -I$(THIRD_PARTY) -I$(VERIFY_DIR) \
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
  $(THIRD_PARTY)/monocypher/monocypher-ed25519.c \
  $(VERIFY_DIR)/banqi_model.c

TEST_SOURCES := \
  $(TEST_DIR)/test_main.cpp \
  $(TEST_DIR)/test_hash.cpp \
  $(TEST_DIR)/test_prng.cpp \
  $(TEST_DIR)/test_banqi_rules.cpp \
  $(TEST_DIR)/test_banqi_model_parity.cpp \
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

# PWA validation. The manifest check is fast and dependency-free. The smoke
# test boots a static server + Chromium and exercises the service worker, so
# it needs the WASM build (the SW precaches banqi.wasm).
.PHONY: pwa-test
pwa-test:
	node tests/pwa_manifest.mjs

.PHONY: pwa-smoke
pwa-smoke: wasm
	node tests/pwa_smoke.mjs

# Regenerate web/icons/*.png from web/favicon.svg. Run after editing the
# favicon. Requires fonts-noto-cjk installed system-wide (for the 將 glyph)
# and the @resvg/resvg-js dev dependency (already pinned in package.json).
.PHONY: icons
icons:
	node scripts/gen-icons.mjs

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

# --- CBMC bounded model checking of the rule engine ---
# Verifies a C port of the engine (verify/banqi_model.c) against rule
# invariants. The C port is held to behavioural parity with the C++
# engine by tests/test_banqi_model_parity.cpp, so a CBMC proof on the
# model transfers to the engine.
#
# Each harness gets its own invocation so failures pinpoint the
# offending property. Loops are bounded: the largest engine loop is
# 32-cell board traversal; the cannon scan is capped at the board edge
# (8 cells), so --unwind 33 with an unwindset of 9 on the cannon loop
# is tight without truncating reachable behaviour.
VERIFY_DIR     ?= verify
CBMC           ?= cbmc
CBMC_FLAGS     := --slice-formula --unwinding-assertions \
                  -I$(VERIFY_DIR) --unwind 33 \
                  --unwindset bq_is_legal_cannon_jump.0:9
VERIFY_HARNESSES := \
  capture_rule \
  flip_legality \
  first_flip \
  off_turn_empty \
  terminal \
  apply_move_invariants \
  conservation \
  normal_move_predicate \
  cannon_predicate

.PHONY: verify verify-harness verify-extended
verify:
	@command -v $(CBMC) >/dev/null || { \
	  echo "cbmc not found; install with 'apt-get install cbmc' or set CBMC=path"; \
	  exit 1; }
	@set -e; for h in $(VERIFY_HARNESSES); do \
	  printf '\n===== verify %s =====\n' "$$h"; \
	  $(CBMC) $(CBMC_FLAGS) $(VERIFY_DIR)/banqi_model.c \
	          $(VERIFY_DIR)/harness_$$h.c | \
	    grep -E '(SUCCESS|FAILURE|VERIFICATION)'; \
	done

# Extended harnesses: full-board nondeterministic generator soundness /
# completeness. These exercise bq_legal_moves under a maximally havoced
# 32-cell board; the resulting SAT formula is large enough that CBMC's
# default solver may take many minutes or fail to converge. Behavioural
# coverage of these properties is already supplied by the parity test
# (5000+ random is_legal comparisons and 2000+ random legal_moves
# comparisons against the C++ engine), so this target is opt-in.
VERIFY_EXTENDED_HARNESSES := \
  generator_soundness \
  generator_completeness

verify-extended:
	@command -v $(CBMC) >/dev/null || { \
	  echo "cbmc not found; install with 'apt-get install cbmc' or set CBMC=path"; \
	  exit 1; }
	@set -e; for h in $(VERIFY_EXTENDED_HARNESSES); do \
	  printf '\n===== verify-extended %s =====\n' "$$h"; \
	  $(CBMC) $(CBMC_FLAGS) $(VERIFY_DIR)/banqi_model.c \
	          $(VERIFY_DIR)/harness_$$h.c | \
	    grep -E '(SUCCESS|FAILURE|VERIFICATION)'; \
	done

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR) $(WEB_DIR)/banqi.js $(WEB_DIR)/banqi.wasm
