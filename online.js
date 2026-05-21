// Online multiplayer client for Undercover.
// Connects to the Cloudflare Worker, holds no game logic — the server is
// authoritative. This file only sends intents and renders server state.
(function () {
    'use strict';

    const cfg = window.UNDERCOVER_CONFIG || { serverBase: '' };
    const root = () => document.getElementById('online-root');

    const state = {
        ws: null,
        code: null,
        you: null,        // { id, name, isHost }
        token: null,
        last: null,       // last server state
        reconnectTimer: null,
        intentionalClose: false
    };

    // --- small helpers ---
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function toast(message, isError) {
        const el = document.getElementById('online-toast');
        el.innerHTML = `<div class="alert ${isError ? 'alert-warning' : 'alert-info'}" style="margin:0;box-shadow:0 4px 16px rgba(0,0,0,.3);">${esc(message)}</div>`;
        el.style.display = 'block';
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
    }

    function wsUrl(code) {
        const base = cfg.serverBase.replace(/^http/, 'ws');
        return `${base}/api/room/${code}/ws`;
    }

    function send(obj) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify(obj));
        }
    }

    // --- connection lifecycle ---
    function connect(code, joinPayload) {
        state.code = code;
        state.intentionalClose = false;
        const ws = new WebSocket(wsUrl(code));
        state.ws = ws;

        ws.addEventListener('open', () => { send(joinPayload); });
        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            onMessage(msg);
        });
        ws.addEventListener('close', () => {
            if (state.intentionalClose) return;
            if (state.token) {
                renderConnecting();
                scheduleReconnect();
            }
        });
        ws.addEventListener('error', () => { /* close handler deals with retry */ });
    }

    function scheduleReconnect() {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => {
            connect(state.code, { type: 'join', name: state.you ? state.you.name : '', token: state.token });
        }, 1500);
    }

    function onMessage(msg) {
        if (msg.type === 'joined') {
            state.you = msg.you;
            state.token = msg.token;
            saveSession();
        } else if (msg.type === 'state') {
            state.last = msg;
            render(msg);
        } else if (msg.type === 'error') {
            toast(msg.message || 'Something went wrong.', true);
            if (['roomFull', 'alreadyStarted', 'nameTaken', 'badName'].includes(msg.code)) {
                // Failed to enter a room — drop back to home.
                if (!state.last) { clearSession(); renderHome(); }
            }
        }
    }

    // --- session persistence (reconnect) ---
    function saveSession() {
        localStorage.setItem('undercoverOnline', JSON.stringify({ code: state.code, token: state.token, name: state.you.name }));
    }
    function clearSession() {
        localStorage.removeItem('undercoverOnline');
        state.token = null;
    }
    function loadSession() {
        try { return JSON.parse(localStorage.getItem('undercoverOnline')); } catch { return null; }
    }

    // --- public entry ---
    function open() {
        showScreen('online-screen');
        renderHome();
    }

    async function createRoom() {
        const name = getName();
        if (!name) return;
        try {
            const res = await fetch(cfg.serverBase + '/api/create', { method: 'POST' });
            if (res.status === 409) { toast('Too many games running right now. Try again shortly.', true); return; }
            const { code, error } = await res.json();
            if (error || !code) { toast('Could not create room.', true); return; }
            connect(code, { type: 'join', name });
        } catch (e) {
            toast('Cannot reach server. Is the backend running?', true);
        }
    }

    function joinRoom() {
        const name = getName();
        const code = (document.getElementById('join-code').value || '').trim().toUpperCase();
        if (!name) return;
        if (!/^[A-Z0-9]{4}$/.test(code)) { toast('Enter a valid 4-character room code.', true); return; }
        connect(code, { type: 'join', name });
    }

    function getName() {
        const name = (document.getElementById('online-name') || {}).value;
        const trimmed = (name || '').trim();
        if (!trimmed) { toast('Please enter your name first.', true); return null; }
        return trimmed;
    }

    function leave() {
        state.intentionalClose = true;
        if (state.ws) state.ws.close();
        clearSession();
        state.last = null; state.you = null; state.code = null;
        showScreen('setup-screen');
    }

    // --- intents ---
    const actions = {
        start() {
            const uc = parseInt(document.getElementById('online-uc').value, 10) || 0;
            const mw = parseInt(document.getElementById('online-mw').value, 10) || 0;
            send({ type: 'start', undercoverCount: uc, mrwhiteCount: mw });
        },
        nextDescriber() { send({ type: 'nextDescriber' }); },
        toVoting() { send({ type: 'toVoting' }); },
        vote(target) { send({ type: 'castVote', target }); },
        skipDisconnected() {
            const s = state.last;
            s.players.filter(p => !p.isEliminated && !p.connected && !p.hasVoted)
                .forEach(p => send({ type: 'skipVoter', voterId: p.id }));
        },
        guess() {
            const g = document.getElementById('mrwhite-online-guess').value;
            send({ type: 'mrWhiteGuess', guess: g });
        },
        cont() { send({ type: 'continue' }); },
        playAgain() { send({ type: 'playAgain' }); }
    };

    // --- rendering ---
    function renderConnecting() {
        root().innerHTML = `<div class="card"><div class="alert alert-warning">Reconnecting…</div></div>`;
    }

    function renderHome() {
        const prior = loadSession();
        const resume = prior && prior.token
            ? `<div class="alert alert-info" style="margin-bottom:1rem;">
                   You were in room <strong>${esc(prior.code)}</strong> as <strong>${esc(prior.name)}</strong>.
                   <button class="primary small" style="margin-top:.5rem;" onclick="OnlineUI._resume()">Rejoin</button>
                   <button class="secondary small" style="margin-top:.5rem;" onclick="OnlineUI._forget()">Forget</button>
               </div>` : '';
        root().innerHTML = `
            ${resume}
            <div class="card">
                <div class="input-group">
                    <label for="online-name">Your Name</label>
                    <input type="text" id="online-name" placeholder="Enter your name" value="${esc(prior ? prior.name : '')}">
                </div>
                <button class="primary" onclick="OnlineUI.createRoom()">Create Room</button>
                <div style="text-align:center;color:var(--text-secondary);margin:1rem 0;">— or —</div>
                <div class="input-group">
                    <label for="join-code">Room Code</label>
                    <input type="text" id="join-code" placeholder="ABCD" maxlength="4" style="text-transform:uppercase;">
                </div>
                <button class="secondary" onclick="OnlineUI.joinRoom()">Join Room</button>
                <button class="secondary" style="margin-top:1rem;" onclick="OnlineUI.leave()">Back</button>
            </div>`;
    }

    function wordBanner(you) {
        if (!you) return '';
        const txt = you.word
            ? `Your word: <strong>${esc(you.word)}</strong>`
            : `You're <strong>Mr. White</strong> — you have no word. Blend in!`;
        const elim = you.isEliminated ? ' <span style="opacity:.6">(eliminated)</span>' : '';
        return `<div class="alert alert-info" style="margin-bottom:1rem;">${txt}${elim}</div>`;
    }

    function playerRow(p, s) {
        const tags = [];
        if (p.isHost) tags.push('👑 host');
        if (!p.connected) tags.push('⚠️ offline');
        if (s.phase === 'vote' && !p.isEliminated && p.hasVoted) tags.push('✓ voted');
        const tag = tags.length ? ` <span style="color:var(--text-secondary);font-size:.85rem;">${tags.join(' · ')}</span>` : '';
        return `<div class="player-item ${p.isEliminated ? 'eliminated' : ''}"><span>${esc(p.name)}${tag}</span></div>`;
    }

    function shareLink(code) {
        return `${location.origin}${location.pathname}?room=${code}`;
    }

    function render(s) {
        const isHost = s.you && s.you.isHost;
        let html = '';

        if (s.phase === 'lobby') {
            const link = shareLink(s.roomCode);
            html = `
                <div class="card">
                    <h2 style="text-align:center;">Room <span style="letter-spacing:3px;">${esc(s.roomCode)}</span></h2>
                    <div class="alert alert-info">Share this code or link so friends can join:</div>
                    <div style="display:flex;gap:.5rem;">
                        <input type="text" readonly value="${esc(link)}" id="share-link" onclick="this.select()">
                        <button class="primary small" onclick="OnlineUI._copy()">Copy</button>
                    </div>
                    <h3 style="margin-top:1rem;">Players (${s.players.length})</h3>
                    <div class="player-list">${s.players.map(p => playerRow(p, s)).join('')}</div>
                    ${isHost ? `
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem;">
                            <div class="input-group"><label for="online-uc">Undercovers</label><input type="number" id="online-uc" value="${s.settings.undercoverCount}" min="0"></div>
                            <div class="input-group"><label for="online-mw">Mr. Whites</label><input type="number" id="online-mw" value="${s.settings.mrwhiteCount}" min="0"></div>
                        </div>
                        <button class="primary" onclick="OnlineUI.actions.start()">Start Game</button>`
                      : `<div class="alert alert-info" style="margin-top:1rem;">Waiting for the host to start…</div>`}
                    <button class="secondary" style="margin-top:1rem;" onclick="OnlineUI.leave()">Leave Room</button>
                </div>`;
        } else if (s.phase === 'describe') {
            const describer = s.players.find(p => p.id === s.describerId);
            const order = s.players.filter(p => !p.isEliminated);
            const youAreUp = describer && s.you && describer.id === s.you.id;
            html = `
                ${wordBanner(s.you)}
                <div class="card">
                    <h2 style="text-align:center;">${describer ? esc(describer.name) + ' is describing' : 'Describing'}</h2>
                    ${youAreUp ? '<div class="alert alert-success">It is your turn — describe your word without saying it!</div>' : ''}
                    <div class="player-list">
                        ${order.map(p => `<div class="player-item ${p.id === s.describerId ? '' : ''}" style="${p.id === s.describerId ? 'outline:2px solid var(--accent-primary);' : ''}"><span>${esc(p.name)}${p.id === s.describerId ? ' 🎤' : ''}</span></div>`).join('')}
                    </div>
                    ${isHost ? `<button class="primary" onclick="OnlineUI.actions.nextDescriber()">Next ▶</button>` : `<div class="alert alert-info">Talk on your call. Host advances turns.</div>`}
                    <button class="secondary" onclick="OnlineUI.leave()">Leave</button>
                </div>`;
        } else if (s.phase === 'discuss') {
            html = `
                ${wordBanner(s.you)}
                <div class="card">
                    <h2 style="text-align:center;">Discussion</h2>
                    <div class="alert alert-info">Discuss who seems suspicious (use your voice call). When ready, the host starts voting.</div>
                    <div class="player-list">${s.players.map(p => playerRow(p, s)).join('')}</div>
                    ${isHost ? `<button class="primary" onclick="OnlineUI.actions.toVoting()">Start Voting</button>` : ''}
                    <button class="secondary" onclick="OnlineUI.leave()">Leave</button>
                </div>`;
        } else if (s.phase === 'vote') {
            const me = s.players.find(p => s.you && p.id === s.you.id);
            const iVoted = me && me.hasVoted;
            const iAmOut = me && me.isEliminated;
            const active = s.players.filter(p => !p.isEliminated);
            const voted = active.filter(p => p.hasVoted).length;
            const pendingOffline = active.some(p => !p.connected && !p.hasVoted);
            html = `
                ${wordBanner(s.you)}
                <div class="card">
                    <h2 style="text-align:center;">Vote to Eliminate</h2>
                    <div class="alert alert-info">${voted}/${active.length} votes in.</div>
                    ${iAmOut ? `<div class="alert alert-warning">You're eliminated — watch the vote.</div>`
                       : iVoted ? `<div class="alert alert-success">Vote cast. Waiting for others…</div>`
                       : `<div class="vote-buttons">${active.filter(p => !me || p.id !== me.id).map(p => `<button class="vote-btn" onclick="OnlineUI.actions.vote('${p.id}')">${esc(p.name)}</button>`).join('')}</div>`}
                    ${isHost && pendingOffline ? `<button class="secondary" onclick="OnlineUI.actions.skipDisconnected()">Skip offline voters</button>` : ''}
                    <button class="secondary" onclick="OnlineUI.leave()">Leave</button>
                </div>`;
        } else if (s.phase === 'elimination') {
            const e = s.elimination || {};
            const roleLabel = e.role === 'civilian' ? 'Civilian' : e.role === 'undercover' ? 'Undercover' : 'Mr. White';
            const iAmMrWhite = s.you && e.id === s.you.id && e.role === 'mrwhite';
            const guessing = e.role === 'mrwhite' && !s.mrWhiteResolved;
            html = `
                <div class="card">
                    <h2 style="text-align:center;">${esc(e.name)} was eliminated</h2>
                    <div style="text-align:center;margin:1rem 0;"><span class="role-badge role-${e.role}">${roleLabel}</span></div>
                    ${guessing ? (iAmMrWhite ? `
                        <div class="alert alert-warning">You're caught! Guess the Civilian word to steal the win:</div>
                        <div class="input-group"><input type="text" id="mrwhite-online-guess" placeholder="Your guess"></div>
                        <button class="primary" onclick="OnlineUI.actions.guess()">Submit Guess</button>`
                      : `<div class="alert alert-info">Mr. White is making a final guess…</div>`)
                      : ''}
                    ${e.mrWhiteFailed ? `<div class="alert alert-info">Mr. White guessed wrong.</div>` : ''}
                    ${isHost && !guessing ? `<button class="primary" onclick="OnlineUI.actions.cont()">Continue</button>` : ''}
                    ${!isHost && !guessing ? `<div class="alert alert-info">Waiting for host to continue…</div>` : ''}
                    <button class="secondary" onclick="OnlineUI.leave()">Leave</button>
                </div>`;
        } else if (s.phase === 'gameover') {
            const r = s.reveal || {};
            const winnerText = s.winner === 'civilians' ? 'Civilians Win! All infiltrators eliminated.'
                : s.winner === 'infiltrators' ? 'Infiltrators Win! They took over.'
                : 'Mr. White Wins! Correct guess.';
            const winnerClass = s.winner === 'civilians' ? 'alert-success' : s.winner === 'infiltrators' ? 'alert-warning' : 'alert-info';
            html = `
                <div class="card">
                    <div class="alert ${winnerClass}">${winnerText}</div>
                    <h3>All Players & Roles</h3>
                    <div class="player-list">${(r.roles || []).map(p => `
                        <div class="player-item"><span>${esc(p.name)}</span>
                        <span class="role-badge role-${p.role}">${p.role === 'civilian' ? 'Civilian' : p.role === 'undercover' ? 'Undercover' : 'Mr. White'}</span></div>`).join('')}
                    </div>
                    ${r.wordPair ? `<div style="text-align:center;margin:1rem 0;"><strong>Words:</strong><br>
                        Civilian: <span style="color:#6ee7b7;">${esc(r.wordPair.civilian)}</span><br>
                        Undercover: <span style="color:#fdba74;">${esc(r.wordPair.undercover)}</span></div>` : ''}
                    ${isHost ? `<button class="primary" onclick="OnlineUI.actions.playAgain()">Play Again (Same Group)</button>` : `<div class="alert alert-info">Waiting for host to start a new round…</div>`}
                    <button class="secondary" onclick="OnlineUI.leave()">Leave</button>
                </div>`;
        }

        root().innerHTML = html;
    }

    // --- misc UI handlers exposed for inline onclick ---
    function _copy() {
        const el = document.getElementById('share-link');
        el.select();
        navigator.clipboard?.writeText(el.value).then(() => toast('Link copied!'), () => {});
    }
    function _resume() {
        const prior = loadSession();
        if (!prior) { renderHome(); return; }
        showScreen('online-screen');
        renderConnecting();
        connect(prior.code, { type: 'join', name: prior.name, token: prior.token });
    }
    function _forget() { clearSession(); renderHome(); }

    // Auto-join via ?room=CODE shared link.
    function maybeAutoJoin() {
        const params = new URLSearchParams(location.search);
        const code = (params.get('room') || '').toUpperCase();
        if (/^[A-Z0-9]{4}$/.test(code)) {
            open();
            const input = document.getElementById('join-code');
            if (input) input.value = code;
        }
    }

    window.OnlineUI = {
        open, createRoom, joinRoom, leave, actions,
        _copy, _resume, _forget
    };

    document.addEventListener('DOMContentLoaded', maybeAutoJoin);
})();
