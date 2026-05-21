// Cloudflare Workers backend for online Undercover.
// - Worker router: creates rooms (via Registry) and upgrades WebSockets into Room DOs.
// - Registry DO: enforces MAX_ROOMS globally and hands out unique room codes.
// - Room DO: authoritative game state for one room; reuses the shared gameEngine.
import GameEngine from '../../gameEngine.js';
import words from './words.json';

const WORD_DICTIONARY = words.data || {};

// Parse the comma-separated allowlist from wrangler.toml's ALLOWED_ORIGINS var.
// Empty/unset = allow any origin (useful for quick local testing).
function allowedOrigins(env) {
    return (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function isOriginAllowed(origin, env) {
    const list = allowedOrigins(env);
    if (list.length === 0) return true; // no allowlist configured -> open
    return origin && list.includes(origin);
}

// CORS headers that reflect the caller's origin only when it's allowed.
function corsHeaders(request, env) {
    const origin = request.headers.get('Origin');
    const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin'
    };
    if (isOriginAllowed(origin, env) && origin) {
        headers['Access-Control-Allow-Origin'] = origin;
    } else if (allowedOrigins(env).length === 0) {
        headers['Access-Control-Allow-Origin'] = '*';
    }
    return headers;
}

function json(body, status, request, env) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) }
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin');

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders(request, env) });
        }

        // Reject anything not coming from an allowed origin.
        if (!isOriginAllowed(origin, env)) {
            return json({ error: 'forbidden', message: 'Origin not allowed.' }, 403, request, env);
        }

        // Create a room: reserve a global slot + unique code.
        if (url.pathname === '/api/create' && request.method === 'POST') {
            const registry = env.REGISTRY.get(env.REGISTRY.idFromName('global'));
            const res = await registry.fetch('https://do/reserve', { method: 'POST' });
            if (res.status === 409) {
                return json({ error: 'serverFull', message: 'Too many active games right now. Try again shortly.' }, 409, request, env);
            }
            const { code } = await res.json();
            return json({ code }, 200, request, env);
        }

        // WebSocket upgrade into a room: /api/room/:code/ws
        const wsMatch = url.pathname.match(/^\/api\/room\/([A-Z0-9]{4})\/ws$/i);
        if (wsMatch) {
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket', { status: 426 });
            }
            const code = wsMatch[1].toUpperCase();
            const room = env.ROOM.get(env.ROOM.idFromName(code));
            // Pass the code along so the Room can release its registry slot on teardown.
            const fwd = new URL(request.url);
            fwd.searchParams.set('code', code);
            return room.fetch(new Request(fwd.toString(), request));
        }

        return json({ error: 'notFound' }, 404, request, env);
    }
};

// ---------------------------------------------------------------------------
// Registry: one global instance tracking active room codes.
// ---------------------------------------------------------------------------
export class Registry {
    constructor(state, env) {
        this.state = state;
        this.maxRooms = parseInt(env.MAX_ROOMS || '20', 10);
    }

    async fetch(request) {
        const url = new URL(request.url);
        const codes = (await this.state.storage.get('codes')) || [];

        if (url.pathname === '/reserve') {
            if (codes.length >= this.maxRooms) {
                return new Response('full', { status: 409 });
            }
            let code;
            do {
                code = randomCode();
            } while (codes.includes(code));
            codes.push(code);
            await this.state.storage.put('codes', codes);
            return new Response(JSON.stringify({ code }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (url.pathname === '/release') {
            const code = url.searchParams.get('code');
            const next = codes.filter(c => c !== code);
            await this.state.storage.put('codes', next);
            return new Response('ok');
        }

        return new Response('not found', { status: 404 });
    }
}

function randomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
}

// ---------------------------------------------------------------------------
// Room: authoritative state for a single game.
// ---------------------------------------------------------------------------
export class Room {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.maxPlayers = parseInt(env.MAX_PLAYERS_PER_ROOM || '12', 10);
        this.idleTimeout = parseInt(env.ROOM_IDLE_TIMEOUT_MS || '1800000', 10);
        this.sockets = new Map(); // playerId -> WebSocket (in-memory only)
        this.game = null; // loaded lazily from storage
    }

    async loadGame(code) {
        if (this.game) return this.game;
        this.game = (await this.state.storage.get('game')) || {
            code,
            phase: 'lobby',
            players: [],
            hostId: null,
            describerIndex: 0,
            round: 1,
            votes: {},
            elimination: null,
            mrWhiteResolved: false,
            winner: null,
            wordPair: null,
            settings: { undercoverCount: 1, mrwhiteCount: 0 }
        };
        return this.game;
    }

    async save() {
        await this.state.storage.put('game', this.game);
    }

    async touch() {
        // Reset the idle self-destruct timer.
        await this.state.storage.setAlarm(Date.now() + this.idleTimeout);
    }

    async fetch(request) {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');
        await this.loadGame(code);

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        await this.touch();

        // Each socket gets a temporary id until the client identifies via "join".
        let playerId = null;

        server.addEventListener('message', async (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }
            try {
                playerId = await this.handle(server, playerId, msg);
            } catch (e) {
                this.sendError(server, 'internal', e.message || 'Unexpected error');
            }
        });

        server.addEventListener('close', () => this.onDisconnect(playerId));
        server.addEventListener('error', () => this.onDisconnect(playerId));

        return new Response(null, { status: 101, webSocket: client });
    }

    // Returns the (possibly newly assigned) playerId for this socket.
    async handle(ws, playerId, msg) {
        const g = this.game;
        await this.touch();

        switch (msg.type) {
            case 'join': {
                const name = (msg.name || '').trim();
                if (!name) {
                    this.sendError(ws, 'badName', 'Please enter a name.');
                    return playerId;
                }

                // Reconnect by token if provided.
                if (msg.token) {
                    const existing = g.players.find(p => p.token === msg.token);
                    if (existing) {
                        existing.connected = true;
                        this.sockets.set(existing.id, ws);
                        await this.save();
                        this.sendTo(ws, { type: 'joined', you: this.publicSelf(existing), token: existing.token });
                        this.broadcastState();
                        return existing.id;
                    }
                }

                if (g.phase !== 'lobby') {
                    this.sendError(ws, 'alreadyStarted', 'This game has already started.');
                    return playerId;
                }
                if (g.players.length >= this.maxPlayers) {
                    this.sendError(ws, 'roomFull', 'This room is full.');
                    return playerId;
                }
                if (g.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
                    this.sendError(ws, 'nameTaken', 'That name is taken in this room.');
                    return playerId;
                }

                const id = crypto.randomUUID();
                const token = crypto.randomUUID();
                const isHost = g.players.length === 0;
                const player = {
                    id, name, token, role: null, word: null,
                    isEliminated: false, isHost, connected: true
                };
                if (isHost) g.hostId = id;
                g.players.push(player);
                this.sockets.set(id, ws);
                await this.save();
                this.sendTo(ws, { type: 'joined', you: this.publicSelf(player), token });
                this.broadcastState();
                return id;
            }

            case 'start': {
                if (!this.isHost(playerId)) return playerId;
                const undercoverCount = parseInt(msg.undercoverCount, 10) || 0;
                const mrwhiteCount = parseInt(msg.mrwhiteCount, 10) || 0;
                const check = GameEngine.validateSetup(g.players.length, undercoverCount, mrwhiteCount);
                if (!check.valid) {
                    this.sendError(this.sockets.get(playerId), 'badSetup', check.error);
                    return playerId;
                }
                g.settings = { undercoverCount, mrwhiteCount };
                this.beginRound();
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'nextDescriber': {
                if (!this.isHost(playerId) || g.phase !== 'describe') return playerId;
                const active = this.activePlayers();
                g.describerIndex++;
                if (g.describerIndex >= active.length) {
                    g.phase = 'discuss';
                    g.describerIndex = 0;
                }
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'toVoting': {
                if (!this.isHost(playerId) || g.phase !== 'discuss') return playerId;
                g.phase = 'vote';
                g.votes = {};
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'castVote': {
                if (g.phase !== 'vote') return playerId;
                const voter = this.player(playerId);
                if (!voter || voter.isEliminated) return playerId;
                const target = g.players.find(p => p.id === msg.target && !p.isEliminated);
                if (!target) return playerId;
                g.votes[playerId] = msg.target;
                await this.maybeResolveVotes();
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'skipVoter': {
                // Host can drop a disconnected player's pending vote so the round resolves.
                if (!this.isHost(playerId) || g.phase !== 'vote') return playerId;
                g.votes[msg.voterId] = '__skip__';
                await this.maybeResolveVotes();
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'mrWhiteGuess': {
                if (g.phase !== 'elimination' || g.mrWhiteResolved) return playerId;
                const elim = g.players.find(p => p.id === g.elimination?.id);
                if (!elim || elim.role !== 'mrwhite' || elim.id !== playerId) return playerId;
                g.mrWhiteResolved = true;
                if (GameEngine.isMrWhiteGuessCorrect(msg.guess, g.wordPair)) {
                    this.endGame('mrwhite');
                } else {
                    g.elimination.mrWhiteFailed = true;
                }
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'continue': {
                if (!this.isHost(playerId) || g.phase !== 'elimination') return playerId;
                const winner = GameEngine.checkWinCondition(g.players);
                if (winner) {
                    this.endGame(winner);
                } else {
                    g.phase = 'describe';
                    g.describerIndex = 0;
                    g.elimination = null;
                }
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'playAgain': {
                if (!this.isHost(playerId) || g.phase !== 'gameover') return playerId;
                g.players.forEach(p => { p.role = null; p.word = null; p.isEliminated = false; });
                g.phase = 'lobby';
                g.round++;
                g.votes = {};
                g.elimination = null;
                g.winner = null;
                g.wordPair = null;
                await this.save();
                this.broadcastState();
                return playerId;
            }

            case 'leave': {
                this.removePlayer(playerId);
                await this.save();
                this.broadcastState();
                return null;
            }

            default:
                return playerId;
        }
    }

    beginRound() {
        const g = this.game;
        const { undercoverCount, mrwhiteCount } = g.settings;
        GameEngine.assignRoles(g.players, undercoverCount, mrwhiteCount);
        g.wordPair = GameEngine.pickWordPair(WORD_DICTIONARY);
        GameEngine.assignWords(g.players, g.wordPair);
        // Randomize describe order.
        GameEngine.shuffleArray(g.players);
        g.players.forEach(p => { p.isEliminated = false; });
        g.phase = 'describe';
        g.describerIndex = 0;
        g.votes = {};
        g.elimination = null;
        g.mrWhiteResolved = false;
        g.winner = null;
    }

    async maybeResolveVotes() {
        const g = this.game;
        const active = this.activePlayers();
        const allVoted = active.every(p => g.votes[p.id] !== undefined);
        if (!allVoted) return;
        // Online ballots are player ids; resolveEliminationName tallies whatever
        // tokens it's given and returns the winner (ties broken randomly).
        const ballots = Object.values(g.votes).filter(v => v !== '__skip__');
        const eliminatedId = GameEngine.resolveEliminationName(ballots);
        const elim = g.players.find(p => p.id === eliminatedId);
        if (elim) {
            elim.isEliminated = true;
            g.elimination = { id: elim.id, name: elim.name, role: elim.role, mrWhiteFailed: false };
        }
        g.mrWhiteResolved = elim && elim.role === 'mrwhite' ? false : true;
        g.phase = 'elimination';
    }

    endGame(winner) {
        this.game.winner = winner;
        this.game.phase = 'gameover';
    }

    // --- disconnect / host migration ---
    async onDisconnect(playerId) {
        if (!playerId) return;
        const p = this.player(playerId);
        if (!p) return;
        this.sockets.delete(playerId);

        if (this.game.phase === 'lobby') {
            // In the lobby a leaver is fully removed.
            this.removePlayer(playerId);
        } else {
            p.connected = false;
        }
        this.migrateHostIfNeeded();
        await this.save();
        this.broadcastState();
    }

    removePlayer(playerId) {
        this.game.players = this.game.players.filter(p => p.id !== playerId);
        this.sockets.delete(playerId);
        delete this.game.votes[playerId];
        this.migrateHostIfNeeded();
    }

    migrateHostIfNeeded() {
        const g = this.game;
        const host = g.players.find(p => p.id === g.hostId);
        if (host && (g.phase === 'lobby' ? this.sockets.has(host.id) : host.connected)) return;
        // Promote first eligible player.
        const next = g.players.find(p => (g.phase === 'lobby' ? this.sockets.has(p.id) : p.connected));
        g.players.forEach(p => { p.isHost = false; });
        if (next) {
            next.isHost = true;
            g.hostId = next.id;
        } else {
            g.hostId = null;
        }
    }

    // --- alarm: idle self-destruct ---
    async alarm() {
        await this.loadGame();
        const anyConnected = this.game && this.game.players.some(p => this.sockets.has(p.id));
        if (anyConnected) {
            await this.touch(); // still active, reschedule
            return;
        }
        // Idle: release registry slot and wipe.
        if (this.game?.code) {
            const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global'));
            await registry.fetch('https://do/release?code=' + this.game.code);
        }
        await this.state.storage.deleteAll();
        this.game = null;
    }

    // --- helpers ---
    player(id) { return this.game.players.find(p => p.id === id); }
    isHost(id) { return id && this.game.hostId === id; }
    activePlayers() { return this.game.players.filter(p => !p.isEliminated); }

    publicSelf(p) {
        return { id: p.id, name: p.name, isHost: p.isHost };
    }

    sendTo(ws, obj) {
        try { ws.send(JSON.stringify(obj)); } catch {}
    }
    sendError(ws, code, message) {
        if (ws) this.sendTo(ws, { type: 'error', code, message });
    }

    // Build the shared, non-secret part of the state.
    baseState() {
        const g = this.game;
        const active = this.activePlayers();
        const describer = g.phase === 'describe' ? active[g.describerIndex] : null;
        return {
            type: 'state',
            roomCode: g.code,
            phase: g.phase,
            round: g.round,
            hostId: g.hostId,
            describerId: describer ? describer.id : null,
            settings: g.settings,
            players: g.players.map(p => ({
                id: p.id,
                name: p.name,
                isHost: p.isHost,
                isEliminated: p.isEliminated,
                connected: g.phase === 'lobby' ? this.sockets.has(p.id) : p.connected,
                hasVoted: g.votes[p.id] !== undefined
            })),
            elimination: g.elimination,
            mrWhiteResolved: g.mrWhiteResolved,
            winner: g.winner,
            // Full reveal only at game over.
            reveal: g.phase === 'gameover'
                ? {
                    wordPair: g.wordPair,
                    roles: g.players.map(p => ({ id: p.id, name: p.name, role: p.role, word: p.word }))
                }
                : null
        };
    }

    // Send each connected socket a state filtered to its own secret word/role.
    broadcastState() {
        const base = this.baseState();
        for (const [pid, ws] of this.sockets) {
            const me = this.player(pid);
            const payload = {
                ...base,
                you: me ? { id: me.id, role: me.role, word: me.word, isHost: me.isHost, isEliminated: me.isEliminated } : null
            };
            this.sendTo(ws, payload);
        }
    }
}
