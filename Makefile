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
  $(SRC_DIR)/bigint.cpp \
  $(SRC_DIR)/hash.cpp \
  $(SRC_DIR)/prng.cpp \
  $(SRC_DIR)/signer.cpp \
  $(SRC_DIR)/transcript.cpp \
  $(SRC_DIR)/sra.cpp \
  $(SRC_DIR)/piece.cpp \
  $(SRC_DIR)/banqi_rules.cpp \
  $(SRC_DIR)/casual_shuffle.cpp \
  $(SRC_DIR)/mental_poker.cpp \
  $(SRC_DIR)/messages.cpp \
  $(SRC_DIR)/game.cpp

C_SOURCES := \
  $(THIRD_PARTY)/monocypher/monocypher.c \
  $(THIRD_PARTY)/monocypher/monocypher-ed25519.c

TEST_SOURCES := \
  $(TEST_DIR)/test_main.cpp \
  $(TEST_DIR)/test_bigint.cpp \
  $(TEST_DIR)/test_hash.cpp \
  $(TEST_DIR)/test_prng.cpp \
  $(TEST_DIR)/test_signer.cpp \
  $(TEST_DIR)/test_transcript.cpp \
  $(TEST_DIR)/test_sra.cpp \
  $(TEST_DIR)/test_banqi_rules.cpp \
  $(TEST_DIR)/test_casual_shuffle.cpp \
  $(TEST_DIR)/test_mental_poker.cpp \
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

# Real-browser end-to-end test. Spawns a static server, a local PeerServer,
# and two Chromium pages, then drives a full game through PeerJS / WebRTC.
# Requires: npm install && npx playwright install chromium
.PHONY: e2e
e2e:
	node tests/e2e_browser.mjs casual
	node tests/e2e_browser.mjs crypto

.PHONY: serve
serve:
	cd $(WEB_DIR) && python3 -m http.server 8080

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR) $(WEB_DIR)/banqi.js $(WEB_DIR)/banqi.wasm
