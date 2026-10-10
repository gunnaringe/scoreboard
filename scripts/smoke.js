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
assert.ok(created.ownerToken && created.gameId);
const admin = created.token;
const gid = created.groupId;
const game = created.gameId;
const G = `/api/g/${gid}`;
let g = await call('GET', G, admin);
const code = g.group.inviteCode;
assert.equal(g.me.owner, true, 'the creator is an owner');

const member = (await call('POST', '/api/join', null, { code: code.toLowerCase().replace('-', ' ') })).token;
const devices = [admin, member];
for (let i = 0; i < 3; i++) devices.push((await call('POST', '/api/join', null, { code })).token);
assert.equal((await call('GET', G, member)).me.owner, false);
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

// ---- owner, office and dashboard links ---------------------------------------
// Members can do everything with rounds, players and games, but not links,
// group settings or devices.
assert.equal((await call('PATCH', `${G}/games/${game}`, member, { teamA: 'Red' })).status, 200);
for (const [method, path] of [['PATCH', G], ['DELETE', G], ['POST', `${G}/links/office`], ['POST', `${G}/links/dashboard`],
    ['POST', `${G}/links/owner`], ['GET', `${G}/devices`]]) {
    assert.equal((await call(method, path, member, method === 'PATCH' ? { name: 'x' } : undefined)).status, 403, `${method} ${path}`);
}
// The dashboard link is read-only and needs no device.
const dash = g.group.dashboardToken;
const board = await call('GET', `/api/d/${dash}`);
assert.equal(board.group.name, 'Office');
assert.equal((await call('GET', `/api/d/${dash}/games/${game}?since=0`)).ratings.length, view.ratings.length);
assert.equal((await call('POST', `/api/d/${dash}/games/${game}/rounds`, null, {})).status, 404, 'dashboard cannot write');
// Owner link: an existing member's device becomes owner...
const own = await call('POST', '/api/owner', null, { token: created.ownerToken, tokens: [member] });
assert.equal(own.groupId, gid);
assert.equal(own.token, null);
assert.equal((await call('GET', G, member)).me.owner, true);
// ...and a browser that isn't in the group gets a new owner device.
const fresh = await call('POST', '/api/owner', null, { token: created.ownerToken, tokens: [] });
assert.ok(fresh.token);
assert.equal((await call('GET', G, fresh.token)).me.owner, true);
// New links replace the old ones.
const newOwner = await call('POST', `${G}/links/owner`, member);
assert.equal((await call('POST', '/api/owner', null, { token: created.ownerToken })).status, 404, 'old owner link stops working');
assert.equal((await call('POST', '/api/owner', null, { token: newOwner.ownerToken, tokens: [admin] })).status, 200);
const newDash = await call('POST', `${G}/links/dashboard`, member);
assert.equal((await call('GET', `/api/d/${dash}`)).status, 404, 'old dashboard link stops working');
assert.equal((await call('GET', `/api/d/${newDash.dashboardToken}`)).group.name, 'Office');
const rot = await call('POST', `${G}/links/office`, member);
assert.notEqual(rot.inviteCode, code);
assert.equal((await call('POST', '/api/join', null, { code })).status, 404, 'old office link stops working');
const devs = await call('GET', `${G}/devices`, member);
assert.ok(devs.devices.length >= 6);
// Anyone can leave; owners can remove others.
assert.equal((await call('DELETE', `${G}/devices/${devs.devices.at(-1).id}`, member)).status, 200);
assert.equal((await call('DELETE', G, member)).status, 200);
assert.equal((await call('GET', G, admin)).status, 401);
console.log('smoke ok');
