# Banqi P2P (半棋)

Two-player Banqi (Chinese Dark Chess, Taiwanese rules) playable in the browser,
end-to-end peer-to-peer. C++17 game core compiled to WebAssembly; PeerJS handles
WebRTC signaling. No game server. No persistent backend.

Two interchangeable shuffle protocols, selectable per game:

* **Casual** — commit-reveal seed exchange + deterministic Fisher–Yates +
  Ed25519-signed move transcript. Both clients learn the layout once seeds are
  revealed and rely on each other not to peek; the signed transcript prevents
  history forgery.
* **Crypto** — SRA mental poker. Each square stays cryptographically hidden
  until both players publish their per-square decryption keys. No client ever
  sees an unflipped piece's identity.

## Live demo

A pre-built copy is deployed automatically to GitHub Pages on every push to
`main`.  Open the URL shown in the repo's **Pages** settings — no install
needed.

## CI / CD

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | every push / PR | runs the native doctest suite (83 tests) |
| `deploy.yml` | push to `main` or `claude/…` branch, or manual | installs emsdk, runs `make wasm`, deploys `web/` to GitHub Pages |

To enable GitHub Pages in a fork:  
*Settings → Pages → Source → GitHub Actions.*

## Build

Native test suite (no Emscripten needed):

    make test          # runs the doctest suite

WebAssembly build for the browser:

    # Install emsdk once:
    git clone https://github.com/emscripten-core/emsdk.git
    cd emsdk && ./emsdk install latest && ./emsdk activate latest
    source ./emsdk_env.sh

    # Then:
    make wasm          # produces web/banqi.js + web/banqi.wasm
    make wasm-test     # node-based end-to-end smoke run, both modes

Serve the static page locally:

    make serve         # http://localhost:8080

## Play

1. Open `index.html` in two browser tabs (or share the URL with a friend).
2. In one tab, choose a mode and click **Create game**. Copy the peer ID shown.
3. In the other tab, paste the peer ID and click **Join game**.
4. Setup completes in under a second; click any face-down cell to flip it. The
   color of the flipped piece becomes yours.

### Networking notes

Connection setup uses PeerJS's free WebRTC signalling broker; gameplay flows
end-to-end over a WebRTC DataChannel.  Because no TURN relay is configured by
default, **two peers behind the same router won't connect unless that router
supports NAT hairpinning** — a common failure mode in home-network testing.
Workarounds:

* Put one peer on a different network (e.g. cellular) for testing, or
* Pass your own TURN server in the URL:
  `https://…/?turn=turn:host:port&user=U&pass=P`.
  The credentials get supplied to `RTCPeerConnection`'s `iceServers` config.

If the connection cannot be established, the lobby panel surfaces the ICE
state and times out after 20 seconds with a diagnostic message.

## Architecture

```
src/bigint.{hpp,cpp}        Fixed-width 256-bit modular arithmetic.
src/hash.{hpp,cpp}          SHA-512 + deterministic PRF (Monocypher).
src/prng.{hpp,cpp}          CSPRNG abstraction (System / Mock).
src/signer.{hpp,cpp}        Ed25519 keypair sign/verify (Monocypher).
src/transcript.{hpp,cpp}    Append-only signed move log.
src/sra.{hpp,cpp}           SRA commutative encryption primitive.
src/piece.hpp               32-piece encoding (codes ↔ Color/PieceType).
src/banqi_rules.{hpp,cpp}   Board, move generation, captures, terminal.
src/shuffle_protocol.hpp    IShuffleProtocol interface.
src/casual_shuffle.{hpp,cpp}     Casual implementation.
src/mental_poker.{hpp,cpp}       Crypto implementation.
src/messages.{hpp,cpp}      JSON envelope helpers.
src/game.{hpp,cpp}          Game facade / state machine.
src/wasm_bindings.cpp       embind exports for JS.
web/                        UI (HTML/CSS/JS + PeerJS).
tests/                      doctest suite + node WASM smoke harness.
```

Both shuffle protocols implement `IShuffleProtocol`, and the `Game` facade
holds one via `std::unique_ptr`. Switching the mode at construction is the
only difference between the two flows; everything downstream — the rule
engine, the signed transcript, the move handlers — is mode-agnostic.

## Banqi rules (Taiwanese)

* 4×8 board, 32 pieces, 16 per side. Per side: 1 General, 2 Advisors,
  2 Elephants, 2 Chariots, 2 Horses, 2 Cannons, 5 Soldiers.
* Rank: General(7) > Advisor(6) > Elephant(5) > Chariot(4) > Horse(3) >
  Cannon(2) > Soldier(1).
* On your turn, flip a face-down piece OR move/capture with one of your
  face-up pieces. The first flipper plays the revealed color.
* Non-cannon piece: 1 step orthogonal to empty, or capture an adjacent
  face-up enemy of equal-or-lower rank. **Soldier captures General; General
  cannot capture Soldier.**
* Cannon: 1 step orthogonal to empty (no adjacent capture), or jump any
  distance along a row/column over **exactly one** screen piece (any color,
  face-up or face-down) onto the target. Cannons ignore rank and may capture
  face-down pieces (which are then revealed).
* You lose if you have no legal move (no face-down cells and no movable
  face-up pieces) or no remaining pieces.

Out of v1 scope: draw rules (50-move, repetition), time controls, takeback,
chat, persistent identity / matchmaking.

## Threat model

| Concern                                       | Casual | Crypto |
| ---                                           | ---    | ---    |
| Peer cannot see unflipped piece identities    | ✗      | ✓      |
| Move history is non-repudiable                | ✓      | ✓      |
| Game state is fair (random + auditable)       | ✓      | ✓      |
| Cheat-resistant against malicious peers       | partial| partial — no zk shuffle proof |

The crypto mode uses a 256-bit safe prime `p = 2q+1` and SRA commutative
encryption. Confidentiality of the unflipped layout reduces to the discrete
log problem mod p. Integrity checks reject any malformed ciphertext or
plaintext that decrypts outside the 1..32 range.

A full tournament-grade implementation would add Wikström-style zero-knowledge
proofs of correct shuffle so that neither peer can rig the layout to favour
themselves. That is out of scope here.

## Test coverage

`make test` runs the doctest suite — 83 test cases / ~25 000 assertions:

* BigInt: round-trips, comparisons, modexp via Fermat's little theorem on
  secp256k1's field prime, modular inverse round-trip, multiplicative
  commutativity (the mental-poker base property).
* SHA-512: NIST test vectors.
* Ed25519: RFC 8032 test vector 1 (empty message), tampered-message and
  wrong-pubkey rejection, deterministic from seed.
* PRNG: deterministic-from-seed, uniform-below correctness, coprime sampling.
* Transcript: chain hashing, signature verification, rejected forgeries.
* SRA: encrypt-decrypt round-trip, commutativity, master-to-per-position
  rekey identity.
* Banqi rules: every piece type's move set, every capture rule (incl. the
  Soldier/General exception), cannon mechanics on face-up and face-down
  screens, terminal detection.
* Casual shuffle: end-to-end commit-reveal, determinism, tampered-seed
  rejection.
* Mental poker: 32-cell shuffle correctness, single-cell reveal does not
  disclose other cells, tampered-ciphertext rejection.
* Game facade: handshake, full game in both modes with per-step
  cross-side board synchronization and identical signed-transcript tip
  hash.

`make wasm-test` runs both modes end-to-end through the WASM module under
node (~50 moves each).

## License

Source code: MIT. Vendored third-party headers retain their own licenses
(see `third_party/`).
