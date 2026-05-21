import WebSocket from 'ws';

const BASE = 'http://localhost:8787';
const log = (...a) => console.log(...a);

function mkClient(code, name, token) {
    const ws = new WebSocket(`ws://localhost:8787/api/room/${code}/ws`);
    const c = { ws, name, you: null, token, last: null, queue: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, token })));
    ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'joined') { c.you = m.you; c.token = m.token; }
        if (m.type === 'state') c.last = m;
        if (m.type === 'error') log(`  [${name}] ERROR`, m.code, m.message);
        c.queue.push(m);
    });
    return c;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, t = 3000) {
    const start = Date.now();
    while (Date.now() - start < t) { if (fn()) return true; await wait(50); }
    throw new Error('timeout waiting for condition');
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
let failures = 0;
function check(cond, msg) { if (!cond) { failures++; log('  ❌', msg); } else log('  ✓', msg); }

const run = async () => {
    // Create room
    const res = await fetch(BASE + '/api/create', { method: 'POST' });
    const { code } = await res.json();
    log('Room created:', code);

    const a = mkClient(code, 'Alice');
    await wait(150);
    const b = mkClient(code, 'Bob');
    const cc = mkClient(code, 'Carol');
    const d = mkClient(code, 'Dave');
    const e = mkClient(code, 'Eve');
    await until(() => a.last && a.last.players.length === 5);
    check(a.last.players.length === 5, '5 players in lobby');
    check(a.you.isHost && !b.you.isHost, 'Alice is host, Bob is not');

    // Start with 1 undercover, 1 mr white
    send(a, { type: 'start', undercoverCount: 1, mrwhiteCount: 1 });
    await until(() => a.last.phase === 'describe');
    check(a.last.phase === 'describe', 'game started -> describe');

    // Each client should only see its own word; verify words are role-consistent
    const all = [a, b, cc, d, e];
    const words = all.map(c => c.last.you.word);
    const roles = all.map(c => c.last.you.role);
    log('  roles:', roles, 'words:', words);
    check(roles.filter(r => r === 'undercover').length === 1, 'exactly 1 undercover');
    check(roles.filter(r => r === 'mrwhite').length === 1, 'exactly 1 mr white');
    check(roles.filter(r => r === 'civilian').length === 3, 'exactly 3 civilians');
    // Security: no client's state leaks others' roles/words during play
    const leaked = a.last.players.some(p => p.role !== undefined || p.word !== undefined);
    check(!leaked, 'player list does NOT leak roles/words during play');
    check(a.last.reveal === null, 'no reveal block during play');

    // Helper: run a full vote round eliminating a chosen target id.
    async function eliminate(targetId) {
        // advance through remaining describers to discuss
        await until(() => a.last.phase === 'describe');
        const activeCount = a.last.players.filter(p => !p.isEliminated).length;
        for (let i = 0; i < activeCount; i++) { send(a, { type: 'nextDescriber' }); await wait(60); }
        await until(() => a.last.phase === 'discuss');
        send(a, { type: 'toVoting' });
        await until(() => a.last.phase === 'vote');
        // every active, non-target player votes the target; target votes someone else
        const active = all.filter(c => !c.last.you.isEliminated);
        const other = active.find(c => c.you.id !== targetId);
        active.forEach(c => send(c, { type: 'castVote', target: c.you.id === targetId ? other.you.id : targetId }));
        await until(() => a.last.phase === 'elimination');
    }

    // Round 1: eliminate Mr. White to test the guess flow.
    const mwClient = all.find(c => c.last.you.role === 'mrwhite');
    await eliminate(mwClient.you.id);
    check(a.last.elimination.role === 'mrwhite', 'mr white was eliminated');
    check(a.last.mrWhiteResolved === false, 'mr white gets to guess (unresolved)');
    send(mwClient, { type: 'mrWhiteGuess', guess: 'definitely-wrong-xyz' });
    await until(() => a.last.mrWhiteResolved === true);
    check(a.last.elimination.mrWhiteFailed === true, 'wrong guess recorded');
    send(a, { type: 'continue' });
    await until(() => a.last.phase === 'describe');
    check(a.last.phase === 'describe', 'game continues after mr white (civilians still majority)');

    // Round 2: eliminate the Undercover -> all infiltrators gone -> civilians win.
    const ucClient = all.find(c => c.last.you.role === 'undercover');
    await eliminate(ucClient.you.id);
    check(a.last.elimination.role === 'undercover', 'undercover eliminated round 2');
    send(a, { type: 'continue' });
    await until(() => a.last.phase === 'gameover');
    check(a.last.phase === 'gameover', 'continue -> gameover');
    check(a.last.winner === 'civilians', 'civilians win: ' + a.last.winner);
    check(!!a.last.reveal && !!a.last.reveal.wordPair, 'reveal block present at gameover');
    check(a.last.reveal.roles.length === 5, 'all 5 roles revealed at gameover');

    // Reconnect test: Bob drops and rejoins by token
    const bToken = b.token;
    b.ws.close();
    await wait(200);
    const b2 = mkClient(code, 'Bob', bToken);
    await until(() => b2.last && b2.last.you);
    check(b2.you.id === b.you.id, 'Bob reconnected to same seat via token');

    // Play again (host)
    send(a, { type: 'playAgain' });
    await until(() => a.last.phase === 'lobby');
    check(a.last.phase === 'lobby', 'playAgain -> back to lobby');

    log(failures === 0 ? '\\nALL FLOW TESTS PASSED ✅' : `\\n${failures} CHECK(S) FAILED ❌`);
    [a, cc, b2].forEach(c => c.ws.close());
    process.exit(failures === 0 ? 0 : 1);
};
run().catch(e => { console.error('FATAL', e); process.exit(1); });
