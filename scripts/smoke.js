// End-to-end API check against a running `wrangler dev` (local D1).
// Usage: node scripts/smoke.js [http://localhost:8787]
//
// Besides the permission and edge-case checks, it makes random edits, deletes
// and restores (old and new rounds, uneven teams, concurrent saves) and then
// compares every stored rating with a from-scratch replay of the history.
import assert from 'node:assert/strict';
import { replay } from '../public/rating.js';

const BASE = process.argv[2] || 'http://localhost:8787';
async function call(method, path, token, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ...(await res.json()) };
}

let seed = Number(process.env.SEED) || 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// ---- groups, joining, everyone-admin default --------------------------------
const created = await call('POST', '/api/groups', null, { name: 'Office', playerName: 'Ada', gameName: 'Rocket League' });
assert.equal(created.status, 201);
assert.ok(created.recoveryToken && created.gameId);
const admin = created.token;
const gid = created.groupId;
const game = created.gameId;
const G = `/api/g/${gid}`;
let g = await call('GET', G, admin);
const code = g.group.inviteCode;
assert.equal(g.group.everyoneAdmin, true);

const member = (await call('POST', '/api/join', null, { code: code.toLowerCase().replace('-', ' ') })).token;
const devices = [admin, member];
for (let i = 0; i < 3; i++) devices.push((await call('POST', '/api/join', null, { code })).token);
assert.equal((await call('GET', G, member)).me.admin, true, 'everyone is admin by default');
assert.equal((await call('GET', G, 'nope')).status, 401);
assert.equal((await call('POST', '/api/join', null, { code: 'AAAA-AAAA' })).status, 404);

// ---- players and names -------------------------------------------------------
const names = ['Bob', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus'];
for (const name of names) assert.equal((await call('POST', `${G}/players`, member, { name })).status, 201);
const clash = await call('POST', `${G}/players`, member, { name: ' bob​ ' });
assert.equal(clash.status, 409, 'invisible characters and case do not make a new name');
assert.equal(clash.player.name, 'Bob');
g = await call('GET', G, member);
const ids = g.players.map((p) => p.id);
assert.equal(ids.length, 7);

// ---- rounds: random creates, edits, deletes, restores ------------------------
const live = [];
const deleted = [];
const ops = {};
const randomTeams = () => {
    const shuffled = [...ids].sort(() => rnd() - 0.5);
    const [a, b] = pick([[1, 1], [2, 2], [2, 2], [3, 3], [2, 1], [1, 2], [3, 2]]);
    return [shuffled.slice(0, a), shuffled.slice(a, a + b)];
};
for (let i = 0; i < 90; i++) {
    const token = devices[i % devices.length];
    const op = live.length < 5 ? 'create' : pick(['create', 'create', 'create', 'winner', 'teams', 'delete', 'restore', 'score']);
    ops[op] = (ops[op] || 0) + 1;
    if (op === 'create') {
        const r = await call('POST', `${G}/games/${game}/rounds`, token, { teams: randomTeams(), winner: rnd() < 0.5 ? 0 : 1, scoreA: 3, scoreB: 1 });
        assert.equal(r.status, 201, JSON.stringify(r));
        live.push(r.id);
    } else if (op === 'winner' || op === 'teams' || op === 'score') {
        const id = rnd() < 0.5 ? live[live.length - 1] : pick(live);
        const body = op === 'winner' ? { winner: rnd() < 0.5 ? 0 : 1 } : op === 'teams' ? { teams: randomTeams() } : { scoreA: 1, scoreB: 2 };
        assert.equal((await call('PATCH', `${G}/rounds/${id}`, token, body)).status, 200);
    } else if (op === 'delete') {
        const id = rnd() < 0.5 ? live.pop() : live.splice(Math.floor(rnd() * live.length), 1)[0];
        assert.equal((await call('DELETE', `${G}/rounds/${id}`, token)).status, 200);
        deleted.push(id);
    } else if (op === 'restore' && deleted.length) {
        const id = deleted.splice(Math.floor(rnd() * deleted.length), 1)[0];
        assert.equal((await call('POST', `${G}/rounds/${id}/restore`, token)).status, 200);
        live.push(id);
    }
}
// Concurrent saves sharing players must not lose updates.
const burst = await Promise.all(devices.map((token) => call('POST', `${G}/games/${game}/rounds`, token,
    { teams: [[ids[0], ids[1]], [ids[2], ids[3]]], winner: 0 })));
for (const r of burst) assert.equal(r.status, 201, JSON.stringify(r));

// ---- compare with a full replay ----------------------------------------------
async function history() {
    const all = [];
    let next = '';
    do {
        const page = await call('GET', `${G}/games/${game}/rounds?limit=200&before=${next}`, member);
        all.push(...page.rounds);
        next = page.next || '';
    } while (next);
    return all.reverse();
}
const rounds = await history();
assert.equal(rounds.length, new Set(rounds.map((r) => r.id)).size, 'paging returns each round once');
const view = await call('GET', `${G}/games/${game}?since=0`, member);
const full = replay(rounds.map((r) => ({
    id: r.id,
    teams: [0, 1].map((t) => r.players.filter((p) => p.team === t).map((p) => p.id)),
    winner: r.winner,
})));
const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-7, `${what}: ${a} != ${b}`);
assert.equal(view.ratings.length, full.ratings.size);
for (const r of view.ratings) {
    const want = full.ratings.get(r.playerId);
    close(r.mu, want.mu, 'mu');
    close(r.sigma, want.sigma, 'sigma');
    const played = rounds.filter((x) => x.players.some((p) => p.id === r.playerId));
    assert.equal(r.rounds, played.length, 'rounds');
    assert.equal(r.wins, played.filter((x) => x.players.find((p) => p.id === r.playerId).team === x.winner).length, 'wins');
}
for (const h of view.handicaps) close(h.mu, full.handicaps.get(h.format).mu, `handicap ${h.format}`);
for (const r of rounds) {
    for (const p of r.players) {
        const want = full.results.get(r.id).players.get(p.id);
        close(p.before.mu, want.before.mu, 'stored before');
        close(p.after.mu, want.after.mu, 'stored after');
    }
}
console.log(`replay matches: ${rounds.length} rounds, ops ${JSON.stringify(ops)}, formats ${view.handicaps.map((h) => h.format).join(' ') || '-'}`);

// ---- paging and player stats -------------------------------------------------
assert.equal((await call('GET', `${G}/games/${game}/rounds?limit=-2`, member)).rounds.length, 1);
assert.equal((await call('GET', `${G}/games/${game}/rounds?limit=100000`, member)).rounds.length, Math.min(200, rounds.length));
const stats = await call('GET', `${G}/games/${game}/players/${ids[0]}`, member);
assert.equal(stats.history.length, view.ratings.find((r) => r.playerId === ids[0]).rounds);

// ---- admins and recovery -----------------------------------------------------
await call('PATCH', G, admin, { everyoneAdmin: false });
assert.equal((await call('GET', G, member)).me.admin, false);
assert.equal((await call('PATCH', G, member, { name: 'x' })).status, 403);
const myDevice = (await call('GET', G, admin)).me.deviceId;
assert.equal((await call('PATCH', `${G}/devices/${myDevice}`, admin, { admin: false })).status, 409, 'last admin cannot step down');
assert.equal((await call('DELETE', `${G}/devices/${myDevice}`, admin)).status, 409, 'last admin cannot leave');
// Recovery link: an existing member's device becomes admin...
const rec = await call('POST', '/api/recover', null, { token: created.recoveryToken, tokens: [member] });
assert.equal(rec.groupId, gid);
assert.equal(rec.token, null);
assert.equal((await call('GET', G, member)).me.admin, true);
// ...and a browser that isn't in the group gets a new admin device.
const fresh = await call('POST', '/api/recover', null, { token: created.recoveryToken, tokens: [] });
assert.ok(fresh.token);
assert.equal((await call('GET', G, fresh.token)).me.admin, true);
const newLink = await call('POST', `${G}/recovery`, admin);
assert.equal((await call('POST', '/api/recover', null, { token: created.recoveryToken })).status, 404, 'old link stops working');
assert.equal((await call('POST', '/api/recover', null, { token: newLink.recoveryToken, tokens: [admin] })).status, 200);
// With another admin, the first may step down.
assert.equal((await call('PATCH', `${G}/devices/${myDevice}`, admin, { admin: false })).status, 200);

// ---- invite code and deletion ------------------------------------------------
const rot = await call('POST', `${G}/invite`, member);
assert.notEqual(rot.inviteCode, code);
assert.equal((await call('POST', '/api/join', null, { code })).status, 404);
assert.equal((await call('DELETE', G, member)).status, 200);
assert.equal((await call('GET', G, admin)).status, 401);
console.log('smoke ok');
