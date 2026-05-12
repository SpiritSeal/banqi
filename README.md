# Banqi (半棋)

Two-player Banqi (Chinese Dark Chess, Taiwanese rules) in the browser.
C++17 game core compiled to WebAssembly. Three ways to play:

1. **Online with a friend** — sign in (GitHub or Google), click "Start a
   game", copy the link, send it to your friend. They click it; you play.
   Games persist on the relay, so you can leave and come back later.
   Every relay keeps an Elo leaderboard.
2. **Over the board** — two players, one device, no network, no sign-in.
3. **Classic peer-to-peer** — pure WebRTC, no server, no account, no
   rating. Hidden behind an "Advanced" disclosure.

## Architecture

```
browser  ── WebSocket ──┐
                        │
browser  ── WebSocket ──┴──►  Node.js relay
                                ├─ Express (REST + OAuth)
                                ├─ ws       (live message relay)
                                └─ SQLite   (users, games, messages, Elo)

browser ◄── WebAssembly ─── C++ rules engine, signed transcript,
                              SRA mental-poker shuffle (optional)
```

The relay is a self-hostable Node.js process — anyone can run their own
"federation member" instance. Friends on the same relay play each other.

Authoritative game logic runs in the browser via the same `Game` class
the P2P mode uses; the relay is a persistent, authenticated message bus
and rating engine. It doesn't validate moves.

A single 32-byte identity seed, derived from the relay's `SERVER_SECRET`
plus the user's OAuth identity, is delivered to the browser at sign-in.
The C++ Game uses it to (a) build the local Ed25519 keypair and (b) seed
the shuffle PRNG. This makes the game deterministic in (id_seed,
game_id), so reconnecting clients reconstruct identical state by replaying
the relay's message log. Replay correctness is proven by
`tests/test_game.cpp` "Game: reconnect-by-replay".

## Layout

```
src/                C++17 game core (rules, transcript, signer, shuffle, …)
src/wasm_bindings   embind exports for the browser
web/                static client (HTML/CSS/JS + compiled WASM)
server/             Node.js federated relay (REST + WS + SQLite)
server/README.md    deploy instructions (Docker, Fly.io)
tests/              C++ doctest suite + node WASM smoke harness + Playwright E2E
tests/wasm_smoke    multi-Game pump pattern (also used by OTB and replay)
```

## Build

```bash
make test           # C++ doctest suite (85 cases incl. reconnect-replay)
make wasm           # compile WASM (requires emsdk; see "WASM build" below)
make wasm-test      # node-driven full-game smoke run
make e2e            # real-browser Playwright test (P2P-classic mode)
make serve          # serve web/ as static files on :8080

make server-install # install relay deps
make server-dev     # run relay with AUTH_DEV=1 on :8080
make server-test    # relay integration tests
make server-docker  # build the relay docker image
```

### Running locally (online play)

```bash
make wasm          # one-time
make server-dev    # serves web/ + relay on :8080
```

Open <http://localhost:8080> in two browsers, sign in (dev mode) as two
different names, start a game in one, follow the room link in the other.

### WASM build

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh
cd .. && make wasm
```

### Deploying your own relay

See [`server/README.md`](server/README.md) for Docker + Fly.io
instructions. The relay serves both the API and the static client, so
one process is enough.

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
  the target. Ignores rank, but the target itself must be a face-up
  enemy piece — a face-down piece can be the screen but is never a
  legal capture target; flip it first.
- The very first flip determines that player's color. You lose if you
  have no legal move.

## Shuffle modes

- **Casual** — commit-reveal seed exchange + deterministic Fisher–Yates +
  Ed25519-signed transcript. Both clients learn the layout once seeds
  are revealed; the signed transcript prevents history forgery.
- **Crypto** — SRA mental poker. Each square stays cryptographically
  hidden until both players publish their per-square decryption key. No
  client ever sees an unflipped piece's identity.

In federated play the relay observes the same messages either mode
produces; the crypto mode's hidden-piece property still holds between
the two clients.

## Threat model

| Concern                                       | Federated | P2P-classic / OTB |
| ---                                           | ---       | ---               |
| Peer cannot see unflipped piece identities    | Crypto: ✓ | Crypto: ✓; Casual: ✗ |
| Move history is non-repudiable                | ✓         | ✓                 |
| Relay cannot fabricate moves on your behalf   | ✓ (sig)   | n/a               |
| Relay sees plaintext game flow                | ✓ (yes)   | n/a               |
| Cheat-resistant against malicious clients     | partial   | partial           |

The federated relay knows every signed move because it forwards them;
the crypto shuffle still keeps unflipped piece identities secret between
clients.

## Testing

- `make test` — pure C++ unit + integration tests
- `make wasm-test` — full WASM game through node
- `make server-test` — relay integration tests (8 cases, end-to-end)
- `make e2e` — real-browser Playwright over the legacy P2P flow

## License

Source: MIT. Vendored third-party headers retain their own licenses
(see `third_party/`).
