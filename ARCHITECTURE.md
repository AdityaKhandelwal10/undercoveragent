# Undercover — Technical Architecture

This document explains how the game is built, especially the online multiplayer
system, so you can navigate and extend the codebase.

## Overview

Undercover ("Mr. White") is a social-deduction word game. It supports two modes
from the same app:

- **Local (pass-and-play):** everyone shares one device. 100% in-browser, no
  server, works offline. This is the original mode, unchanged in behavior.
- **Online:** each player joins from their own device via a room code. State is
  held authoritatively on a Cloudflare Worker. Players talk over an external
  voice/video call (no in-app chat by design).

The key design constraint: this is a **hidden-role game**, so the server must be
**authoritative**. Clients are never trusted to know other players' roles or
words — each client only ever receives its own secret.

## Components

```
                         ┌─────────────────────────────┐
   Browser (Netlify)     │   Cloudflare Worker          │
 ┌─────────────────┐     │  ┌────────────────────────┐  │
 │ index.html      │     │  │ Registry DO (1 global) │  │
 │  ├ gameEngine.js│◄────┼──┤  - enforces MAX_ROOMS  │  │
 │  ├ online.js    │ WS  │  │  - hands out codes     │  │
 │  └ (local mode) │◄───►│  └────────────────────────┘  │
 └─────────────────┘     │  ┌────────────────────────┐  │
                         │  │ Room DO (1 per code)   │  │
                         │  │  - authoritative state │  │
                         │  │  - reuses gameEngine.js│  │
                         │  └────────────────────────┘  │
                         └─────────────────────────────┘
```

### File map

| File | Role |
|------|------|
| `index.html` | All UI + local-mode controller + online-mode screens. |
| `gameEngine.js` | **Pure** game rules. No DOM, no network. Shared by browser and Worker. |
| `online.js` | Online client: WebSocket connection + render-from-server-state. Holds no game logic. |
| `words.json` | Word-pair dictionary. Used by local mode (fetched) and copied into the server for online mode. |
| `server/src/index.js` | Worker router + `Room` and `Registry` Durable Objects. |
| `server/src/words.json` | Server-side copy of the dictionary (online mode never sends the full pair to clients). |
| `server/wrangler.toml` | Worker config: DO bindings, migrations, and tunable caps. |
| `server/test-flow.mjs` | Scripted 5-player end-to-end test over real WebSockets. |
| `.github/workflows/deploy.yml` | Frontend deploy: copies the 4 static files to the personal-website repo → Netlify. |

## The shared game engine (`gameEngine.js`)

This is the single source of truth for the rules, so local and online modes can
never diverge. It is a **UMD module**: in the browser it attaches to
`window.GameEngine`; in the Worker (bundled by esbuild) it is imported as a
default export.

Pure functions (no side effects beyond mutating the arrays you pass in):

- `shuffleArray(arr)` — Fisher-Yates.
- `validateSetup(playerCount, undercoverCount, mrwhiteCount)` → `{ valid, error }`.
- `assignRoles(players, undercoverCount, mrwhiteCount)` — sets `player.role`.
- `pickWordPair(dict)` → `{ civilian, undercover }` (throws on empty/invalid dict).
- `assignWords(players, wordPair)` — sets `player.word` by role (Mr. White → `null`).
- `tallyVotes(votes)` / `resolveEliminationName(votes)` — vote counting, ties broken randomly.
- `isMrWhiteGuessCorrect(guess, wordPair)` — case/space-insensitive compare.
- `checkWinCondition(players)` → `'civilians' | 'infiltrators' | null`.

## Local mode (in `index.html`)

The original state machine, lightly refactored. `gameState` lives in memory;
player names persist to `localStorage`. The screen functions
(`startGame`, `processElimination`, `continueGame`, etc.) now delegate all
rule computation to `GameEngine.*` and keep only DOM work. Behavior is identical
to before the refactor.

## Online mode

### Backend: Durable Objects

A **Durable Object (DO)** is a single-threaded, stateful object that lives on
Cloudflare's edge. We use two classes:

**`Registry`** (one global instance, addressed by name `"global"`):
- Tracks the set of active room codes in DO storage.
- `POST /reserve` — refuses if `count >= MAX_ROOMS` (returns 409), else generates
  a unique 4-char code (no ambiguous letters) and returns it.
- `GET /release?code=…` — frees a slot when a room tears down.

**`Room`** (one instance per room code, via `idFromName(code)`):
- Holds the authoritative `game` object (players with secret roles/words, phase,
  votes, host, etc.), persisted to DO storage so it survives restarts.
- Keeps an in-memory `Map` of `playerId → WebSocket`.
- Single-threaded message handling → no vote/state races even with 12 players.
- Sets an **alarm** (`ROOM_IDLE_TIMEOUT_MS`) to self-destruct when idle and
  release its Registry slot — this is the cleanup that keeps the room count
  honest.

### Worker router (`fetch`)

- `POST /api/create` → asks the Registry to reserve a code; returns `{ code }` or
  `{ error: 'serverFull' }`.
- `GET /api/room/:code/ws` (WebSocket upgrade) → forwards the socket to the Room
  DO `idFromName(code)`.

### Message protocol (over WebSocket)

Client → server (`{ type, ... }`):
`join {name, token?}`, `start {undercoverCount, mrwhiteCount}`, `nextDescriber`,
`toVoting`, `castVote {target}`, `skipVoter {voterId}`, `mrWhiteGuess {guess}`,
`continue`, `playAgain`, `leave`.

Server → client:
- `joined {you:{id,name,isHost}, token}` — issued once on join; the **token** is
  stored in `localStorage` for secure reconnect.
- `state {...}` — broadcast after every change, **filtered per socket**: the
  shared fields (phase, player list with `connected`/`hasVoted`/`isEliminated`,
  whose turn, vote progress) plus a private `you {role, word}`. Full roles and the
  word pair appear only in a `reveal` block at `gameover`.
- `error {code, message}`.

### Game phases (server-driven)

`lobby → describe → discuss → vote → elimination → (continue ↺) → gameover`
then `playAgain → lobby`. Per the design, the **describe** phase is just a turn
indicator (host advances; players talk on their call). Voting is one ballot per
active player on their own device; the round resolves once all active players
have voted (host can skip offline voters).

### Security model (why clients can't cheat)

- Roles/words live only on the server; the per-socket `state` payload strips
  every other player's secret.
- Reconnect matches the private `token`, not the name — so a player can't claim
  someone else's seat to read their word.
- All host-only actions (`start`, `nextDescriber`, `toVoting`, `continue`,
  `playAgain`, `skipVoter`) are enforced server-side against `hostId`.

### Resilience

- **Disconnect:** the player is marked `connected: false` but keeps their seat and
  role; mid-game they are not removed (that would unbalance roles).
- **Host migration:** if the host's socket closes, the Room auto-promotes the next
  connected player so host-only controls never get stuck.
- **Reconnect:** the client auto-retries with its stored token and is re-seated.

## Cost & abuse controls

Tunable in `server/wrangler.toml`:

- `MAX_ROOMS` (default 20) — global cap enforced by the Registry.
- `MAX_PLAYERS_PER_ROOM` (default 12).
- `ROOM_IDLE_TIMEOUT_MS` (default 30 min) — idle rooms self-destruct and free slots.

Hard ceiling: run the Worker on Cloudflare's **free plan with no payment method**.
Usage beyond free limits is throttled, never billed — cost cannot exceed $0.

## Deploy

- **Frontend:** unchanged pipeline. `git push main` → GitHub Actions copies
  `index.html`, `words.json`, `gameEngine.js`, `online.js` into the personal-website
  repo → Netlify serves them. The only online-specific bit is the
  `window.UNDERCOVER_CONFIG.serverBase` constant in `index.html`, which points at
  the deployed Worker in production and at `localhost:8787` during local dev.
- **Backend:** `cd server && npx wrangler deploy` (separate from Netlify, needs a
  Cloudflare account). Prints the `*.workers.dev` URL to put in `serverBase`.

## Local development

1. `nvm use 20` (Node 18+ required for wrangler).
2. Backend: `cd server && npx wrangler dev` → `http://localhost:8787`.
3. Frontend: from repo root, `python3 -m http.server 8080`.
4. Open `http://localhost:8080/index.html` in multiple windows (normal + incognito
   for separate sessions). `online.js` auto-targets `localhost:8787`.
5. Automated backend test (with wrangler dev running): `cd server && node test-flow.mjs`.
