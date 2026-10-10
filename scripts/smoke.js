// End-to-end API check against a running `wrangler dev` (local D1).
// Usage: node scripts/smoke.js [http://localhost:8787]
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://localhost:8787';
async function call(method, path, token, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, ...data };
}

const created = await call('POST', '/api/groups', null, { name: 'Office', playerName: 'Ada', gameName: 'Rocket League' });
assert.equal(created.status, 201);
const admin = created.token;
const gid = created.groupId;
let g = await call('GET', `/api/g/${gid}`, admin);
assert.equal(g.me.admin, true);
const code = g.group.inviteCode;
const game = g.games[0].id;

const joined = await call('POST', '/api/join', null, { code: code.toLowerCase().replace('-', ' ') });
assert.equal(joined.groupId, gid);
const member = joined.token;
assert.equal((await call('GET', `/api/g/${gid}`, 'nope')).status, 401);
assert.equal((await call('POST', '/api/join', null, { code: 'AAAA-AAAA' })).status, 404);

const bob = await call('POST', `/api/g/${gid}/players`, member, { name: 'Bob', me: true });
const cy = await call('POST', `/api/g/${gid}/players`, member, { name: 'Cy' });
assert.equal((await call('POST', `/api/g/${gid}/players`, member, { name: 'cy' })).status, 409);
g = await call('GET', `/api/g/${gid}`, member);
const ada = g.players.find((p) => p.name === 'Ada').id;
assert.equal(g.me.playerId, bob.id);
assert.equal(g.me.admin, false);

const r1 = await call('POST', `/api/g/${gid}/games/${game}/rounds`, member, { teams: [[ada], [bob.id, cy.id]], winner: 0, scoreA: 3, scoreB: 1 });
assert.equal(r1.status, 201);
const r2 = await call('POST', `/api/g/${gid}/games/${game}/rounds`, admin, { teams: [[ada, cy.id], [bob.id]], winner: 1 });
const t = await call('POST', `/api/g/${gid}/games/${game}/tournaments`, member, { name: 'Friday cup' });
const r3 = await call('POST', `/api/g/${gid}/games/${game}/rounds`, member, { teams: [[ada], [bob.id]], winner: 0, tournamentId: t.id });
assert.equal(r3.tournamentId, t.id);
assert.equal((await call('POST', `/api/g/${gid}/games/${game}/rounds`, member, { teams: [[ada], [ada]], winner: 0 })).status, 400);

let view = await call('GET', `/api/g/${gid}/games/${game}?since=0`, member);
assert.equal(view.rounds.length, 3);
assert.equal(view.ratings.length, 3);
const before = Object.fromEntries(view.ratings.map((r) => [r.playerId, r.mu]));

// Default policy: anyone edits. Flip a result and check replay changed ratings.
const edited = await call('PATCH', `/api/g/${gid}/rounds/${r1.id}`, member, { winner: 1 });
assert.equal(edited.winner, 1);
view = await call('GET', `/api/g/${gid}/games/${game}`, member);
const after = Object.fromEntries(view.ratings.map((r) => [r.playerId, r.mu]));
assert.ok(after[ada] < before[ada]);

// Admin-only policy: member can't edit the admin's round, but can edit their own.
await call('PATCH', `/api/g/${gid}`, admin, { editPolicy: 'admin' });
assert.equal((await call('DELETE', `/api/g/${gid}/rounds/${r2.id}`, member)).status, 403);
assert.equal((await call('DELETE', `/api/g/${gid}/rounds/${r3.id}`, member)).status, 200);
assert.equal((await call('POST', `/api/g/${gid}/rounds/${r3.id}/restore`, member)).status, 200);
assert.equal((await call('PATCH', `/api/g/${gid}`, member, { name: 'x' })).status, 403);

// Everyone admin.
await call('PATCH', `/api/g/${gid}`, admin, { everyoneAdmin: true });
g = await call('GET', `/api/g/${gid}`, member);
assert.equal(g.me.admin, true);
assert.equal((await call('DELETE', `/api/g/${gid}/rounds/${r2.id}`, member)).status, 200);

const tr = await call('GET', `/api/g/${gid}/games/${game}/rounds?tournament=${t.id}`, member);
assert.equal(tr.rounds.length, 1);
const hist = await call('GET', `/api/g/${gid}/games/${game}/rounds?player=${cy.id}`, member);
assert.equal(hist.rounds.length, 1);

// Fast-path edits (latest round: flip winner, swap teams, delete, restore)
// must leave exactly what a full replay gives.
const r4 = await call('POST', `/api/g/${gid}/games/${game}/rounds`, member, { teams: [[ada, bob.id], [cy.id]], winner: 0 });
await call('PATCH', `/api/g/${gid}/rounds/${r4.id}`, member, { winner: 1 });
await call('PATCH', `/api/g/${gid}/rounds/${r4.id}`, member, { teams: [[ada], [cy.id, bob.id]] });
await call('DELETE', `/api/g/${gid}/rounds/${r4.id}`, member);
await call('POST', `/api/g/${gid}/rounds/${r4.id}/restore`, member);
const snapshot = async () => {
    const v = await call('GET', `/api/g/${gid}/games/${game}?since=0`, member);
    return {
        ratings: Object.fromEntries(v.ratings.map((r) => [r.playerId, [r.mu, r.sigma, r.rounds, r.wins]])),
        rounds: Object.fromEntries(v.rounds.map((r) => [r.id, r.players.map((p) => [p.id, p.before?.mu, p.after?.mu])])),
    };
};
const fast = await snapshot();
await call('PATCH', `/api/g/${gid}/games/${game}`, admin, { recalculate: true });
const full = await snapshot();
const near = (a, b) => JSON.stringify(a, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))
    === JSON.stringify(b, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
assert.ok(near(fast, full), `fast path differs from replay:\n${JSON.stringify(fast)}\n${JSON.stringify(full)}`);

// Rotating the code invalidates the old one.
const rot = await call('POST', `/api/g/${gid}/invite`, admin);
assert.notEqual(rot.inviteCode, code);
assert.equal((await call('POST', '/api/join', null, { code })).status, 404);

assert.equal((await call('DELETE', `/api/g/${gid}`, admin)).status, 200);
assert.equal((await call('GET', `/api/g/${gid}`, admin)).status, 401);
console.log('smoke ok');
