# Banqi (半棋)

Two-player Banqi (Chinese Dark Chess, Taiwanese rules) in the browser.
C++17 game core compiled to WebAssembly. Three ways to play:

1. **Online with a friend** — sign in (GitHub, Google, or one-click guest),
   click "Start a game", copy the link, send it to your friend. They click
   it; you play. Games persist on the server, so you can leave and come back
   later. The server keeps an Elo leaderboard (guests are excluded).
2. **Over the board** — two players, one device, no network, no sign-in.
3. **vs AI** — single-player against a local AI (Easy/Medium/Hard).

## Architecture

```
browser  ── WebSocket ──┐
                        │
browser  ── WebSocket ──┴──►  Node.js server
                                ├─ Express (REST + OAuth + guest sessions)
                                ├─ ws       (state pushes, intent dispatch)
                                ├─ Banqi WASM (validates moves, runs shuffle,
                                │              decides winners — authoritative)
                                └─ PostgreSQL (users, games, game_state,
                                               game_events, Elo history)
```

The server is server-authoritative: it owns the deck, validates every
intent against the rule engine, and pushes filtered state to each viewer.
The browser never runs the rule engine for online play — it sends intents
(`{kind:"flip", cell}` / `{kind:"move", from, to}` / `{kind:"resign"}`)
and renders whatever state the server pushes back. OTB and vs-AI use the
same WASM engine locally with full visibility.

Reconnect is trivial: `GET /api/games/:id` returns the current viewer
state plus the full event log, which the replay UI consumes directly.

## Layout

```
src/                C++17 game core (rules engine + sealed-deck Game)
src/wasm_bindings   embind exports for both Node and browser
web/                static client (HTML/CSS/JS + compiled WASM)
server/             Node.js server (REST + WS + Postgres + engine)
server/README.md    deploy instructions
tests/              C++ doctest suite + node WASM/replay smokes
```

## Build

```bash
make test           # C++ doctest suite
make wasm           # compile WASM (requires emsdk; see "WASM build" below)
make wasm-test      # node-driven full-game + replay smoke
make serve          # serve web/ as static files on :8080

make server-install # install server deps
make server-dev     # run server with AUTH_DEV=1 on :8080
make server-test    # server integration tests
make server-docker  # build the docker image
```

### Running locally (online play)

```bash
make wasm          # one-time
make server-dev    # serves web/ + server on :8080
```

Open <http://localhost:8080> in two browsers, sign in (dev mode) as two
different names, start a game in one, follow the room link in the other.
Or click "Continue as guest" in the second browser to test the guest flow.

### WASM build

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh
cd .. && make wasm
```

### Deploying your own server

See [`server/README.md`](server/README.md). The server serves both the
API and the static client, so one process is enough.

## Banqi rules (Taiwanese)

- 4×8 board, 32 pieces, 16 per side. Per side: 1 General, 2 Advisors,
  2 Elephants, 2 Chariots, 2 Horses, 2 Cannons, 5 Soldiers.
- Rank: General(7) > Advisor(6) > Elephant(5) > Chariot(4) > Horse(3) >
  Cannon(2) > Soldier(1). **Soldier captures General**; General cannot
  capture Soldier.
- On your turn, flip a face-down piece OR move one of your face-up
  pieces one orthogonal step. Capture an adjacent face-up enemy of
  equal-or-lower rank (with the Soldier/General exception above).
- **Cannon**: never captures adjacently. Jumps along a row or column
  over exactly one screen piece (any color, face-up or face-down) onto
  the target. Ignores rank, but the target must be a face-up enemy piece.
- The very first flip determines that player's color. You lose if you
  have no legal move.

## Threat model

The server is authoritative; clients render state and submit intents.
This collapses every prior question about move forgery, transcript
replay, and reconnect drift into a single one: do you trust the server?
If yes, online play is correct; if not, run your own.

| Concern                                          | Online | OTB / vs-AI |
| ---                                              | ---    | ---         |
| Peer cannot see unflipped piece identities       | n/a*   | n/a*        |
| Move history is authoritative                    | ✓      | local-only  |
| Clients cannot fabricate illegal moves           | ✓      | n/a         |

\* Face-down piece identities live in the server's sealed deck for online
games, and in the local WASM Game for OTB / vs-AI. Neither is exposed to
the renderer until a flip happens.

## Testing

- `make test` — pure C++ unit + integration tests (incl. C-model parity)
- `make wasm-test` — full WASM game through node + replay smoke
- `make server-test` — server integration tests (requires Postgres)
- `make verify` — CBMC bounded model checking of the rule engine
  (see [`verify/README.md`](verify/README.md))

## License

Source: MIT. Vendored third-party headers retain their own licenses
(see `third_party/`).
