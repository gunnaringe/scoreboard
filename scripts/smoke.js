// End-to-end check of a running server, speaking Connect's JSON encoding like
// the web app does. Independent of the Go code: ratings are compared with the
// JavaScript reference model in test/reference/rating.js.
//
//   go run ./cmd/scoreboard serve --db /tmp/smoke.db --listen :8791 --join-limit 0 --write-limit 0 &
//   node scripts/smoke.js http://localhost:8791        (SEED=3 for another random run)
//
// Besides permissions and edge cases it makes random edits, deletes and
// restores (old and new rounds, uneven teams, concurrent saves), then compares
// every stored rating, handicap and win probability with a from-scratch replay.
import assert from 'node:assert/strict';
import { replay, winProbability } from '../test/reference/rating.js';

const BASE = process.argv[2] || 'http://localhost:8787';

// One Connect call. Resolves to { status, code, message, ...response fields }.
async function call(method, msg = {}, token) {
    const res = await fetch(`${BASE}/scoreboard.v1.ScoreboardService/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(msg),
    });
    const data = await res.json();
    return { status: res.status, ...data };
}
const ok = async (method, msg, token) => {
    const r = await call(method, msg, token);
    assert.equal(r.status, 200, `${method}: ${r.status} ${r.code} ${r.message}`);
    return r;
};
const fails = async (method, msg, token, code) => {
    const r = await call(method, msg, token);
    assert.equal(r.code, code, `${method}: expected ${code}, got ${r.status} ${r.code} ${r.message}`);
    return r;
};

let seed = Number(process.env.SEED) || 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// ---- groups, joining ------------------------------------------------------------
const created = await ok('CreateGroup', { name: 'Office', gameName: 'Rocket League' });
assert.ok(created.ownerToken && created.gameId && created.deviceToken);
const owner = created.deviceToken;
const game = created.gameId;
let g = await ok('GetGroup', {}, owner);
assert.equal(g.me.owner, true, 'the creator is an owner');
const code = g.group.officeCode;
assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

const member = (await ok('Join', { code: code.toLowerCase().replace('-', ' ') })).deviceToken;
const devices = [owner, member];
for (let i = 0; i < 3; i++) devices.push((await ok('Join', { code })).deviceToken);
assert.equal((await ok('GetGroup', {}, member)).me.owner, false);
await fails('GetGroup', {}, 'nope', 'unauthenticated');
await fails('GetGroup', {}, undefined, 'unauthenticated');
await fails('Join', { code: 'AAAA-AAAA' }, undefined, 'not_found');

// ---- players -----------------------------------------------------------------------
const names = ['Ada', 'Bob', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus'];
for (const name of names) assert.equal((await ok('CreatePlayer', { name }, member)).existed, false);
const dup = await ok('CreatePlayer', { name: ' bob​ ' }, member);
assert.equal(dup.existed, true, 'invisible characters and case do not make a new name');
assert.equal(dup.player.name, 'Bob');
g = await ok('GetGroup', {}, member);
const ids = g.players.map((p) => p.id);
assert.equal(ids.length, 7);

// ---- rounds: random creates, edits, deletes, restores ---------------------------------
const live = [];
const deleted = [];
const ops = {};
const randomTeams = () => {
    const shuffled = [...ids].sort(() => rnd() - 0.5);
    const [a, b] = pick([[1, 1], [2, 2], [2, 2], [3, 3], [2, 1], [1, 2], [3, 2]]);
    return { teamA: shuffled.slice(0, a), teamB: shuffled.slice(a, a + b) };
};
for (let i = 0; i < 90; i++) {
    const token = devices[i % devices.length];
    const op = live.length < 5 ? 'create' : pick(['create', 'create', 'create', 'winner', 'teams', 'delete', 'restore', 'score']);
    ops[op] = (ops[op] || 0) + 1;
    if (op === 'create') {
        const r = await ok('CreateRound', { gameId: game, ...randomTeams(), winner: rnd() < 0.5 ? 0 : 1, scoreA: 3, scoreB: 1 }, token);
        live.push(r.round.id);
    } else if (op === 'winner' || op === 'teams' || op === 'score') {
        const roundId = rnd() < 0.5 ? live[live.length - 1] : pick(live);
        const msg = op === 'winner' ? { winner: rnd() < 0.5 ? 0 : 1 } : op === 'teams' ? { teams: randomTeams() } : { score: { a: 1, b: 2 } };
        await ok('UpdateRound', { roundId, ...msg }, token);
    } else if (op === 'delete') {
        const roundId = rnd() < 0.5 ? live.pop() : live.splice(Math.floor(rnd() * live.length), 1)[0];
        await ok('DeleteRound', { roundId }, token);
        deleted.push(roundId);
    } else if (op === 'restore' && deleted.length) {
        const roundId = deleted.splice(Math.floor(rnd() * deleted.length), 1)[0];
        await ok('RestoreRound', { roundId }, token);
        live.push(roundId);
    }
}
// Concurrent saves sharing players must not lose updates.
const burst = await Promise.all(devices.map((token) => call('CreateRound', { gameId: game, teamA: [ids[0], ids[1]], teamB: [ids[2], ids[3]], winner: 0 }, token)));
for (const r of burst) assert.equal(r.status, 200, JSON.stringify(r));

// ---- compare with a from-scratch replay --------------------------------------------------
async function history() {
    const all = [];
    let before = '';
    do {
        const page = await ok('ListRounds', { gameId: game, limit: 200, before }, member);
        all.push(...page.rounds);
        before = page.nextCursor;
    } while (before);
    return all.reverse();
}
const rounds = await history();
assert.equal(rounds.length, new Set(rounds.map((r) => r.id)).size, 'paging returns each round once');
const view = (await ok('GetGame', { gameId: game, since: '1970-01-01T00:00:00.001Z' }, member)).view;
const full = replay(rounds.map((r) => ({
    id: r.id,
    teams: [0, 1].map((t) => r.players.filter((p) => p.team === t).map((p) => p.playerId)),
    winner: r.winner,
})));
const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-7, `${what}: ${a} != ${b}`);
assert.equal(view.ratings.length, full.ratings.size);
for (const r of view.ratings) {
    const want = full.ratings.get(r.playerId);
    close(r.mu, want.mu, 'mu');
    close(r.sigma, want.sigma, 'sigma');
    const played = rounds.filter((x) => x.players.some((p) => p.playerId === r.playerId));
    assert.equal(r.rounds, played.length, 'rounds');
    assert.equal(r.wins, played.filter((x) => x.players.find((p) => p.playerId === r.playerId).team === x.winner).length, 'wins');
    assert.equal(r.provisional, r.rounds < 10, 'provisional');
}
for (const h of view.handicaps) close(h.mu, full.handicaps.get(h.format).mu, `handicap ${h.format}`);
for (const r of rounds) {
    for (const p of r.players) {
        const want = full.results.get(r.id).players.get(p.playerId);
        close(p.before.mu, want.before.mu, 'stored before');
        close(p.after.mu, want.after.mu, 'stored after');
    }
}
// Win odds from the server agree with the reference model.
const rating = (id) => view.ratings.find((r) => r.playerId === id) || { mu: 25, sigma: 6 };
const handicaps = new Map(view.handicaps.map((h) => [h.format, h]));
for (const [a, b] of [[[ids[0]], [ids[1]]], [[ids[0], ids[1]], [ids[2]]], [[ids[3]], [ids[4], ids[5]]], [[ids[0], ids[1], ids[2]], [ids[4], ids[5]]]]) {
    const p = (await ok('PreviewRound', { gameId: game, teamA: a, teamB: b }, member)).winProbabilityA;
    close(p, winProbability(a.map(rating), b.map(rating), handicaps), `odds ${a.length}v${b.length}`);
}
const suggested = await ok('SuggestTeams', { gameId: game, playerIds: ids.slice(0, 5) }, member);
assert.equal(suggested.teamA.length + suggested.teamB.length, 5);
console.log(`replay matches: ${rounds.length} rounds, ops ${JSON.stringify(ops)}, formats ${view.handicaps.map((h) => h.format).join(' ') || '-'}`);

// ---- paging and player stats -----------------------------------------------------------------
assert.equal((await ok('ListRounds', { gameId: game, limit: -2 }, member)).rounds.length, 1);
assert.equal((await ok('ListRounds', { gameId: game, limit: 100000 }, member)).rounds.length, Math.min(200, rounds.length));
const stats = await ok('GetPlayerStats', { gameId: game, playerId: ids[0] }, member);
assert.equal(stats.history.length, view.ratings.find((r) => r.playerId === ids[0]).rounds);
assert.ok(stats.history.every((h) => !Number.isNaN(Date.parse(h.playedAt)) && Number.isInteger(h.display)));

// ---- polling version --------------------------------------------------------------------------
const v1 = Number((await ok('GetGameVersion', { gameId: game }, member)).version);
assert.equal(v1, Number(view.version));
await ok('CreateRound', { gameId: game, teamA: [ids[0]], teamB: [ids[1]], winner: 0 }, member);
assert.equal(Number((await ok('GetGameVersion', { gameId: game }, member)).version), v1 + 1, 'a rating write bumps the version');

// ---- owner, office and dashboard links ------------------------------------------------------------
// Members can do everything with rounds, players and games, but not links, group settings or devices.
await ok('UpdateGame', { gameId: game, teamA: 'Red' }, member);
await fails('UpdateGroup', { name: 'x' }, member, 'permission_denied');
await fails('DeleteGroup', {}, member, 'permission_denied');
for (const kind of ['LINK_KIND_OFFICE', 'LINK_KIND_DASHBOARD', 'LINK_KIND_OWNER']) await fails('RotateLink', { kind }, member, 'permission_denied');
await fails('ListDevices', {}, member, 'permission_denied');
// The dashboard link is read-only and needs no device.
const dash = g.group.dashboardToken;
const board = await ok('GetDashboard', { token: dash });
assert.equal(board.groupName, 'Office');
assert.equal((await ok('GetDashboardGame', { token: dash, gameId: game, since: '1970-01-01T00:00:00.001Z' })).view.ratings.length, view.ratings.length);
await fails('GetDashboard', { token: 'wrong' }, undefined, 'not_found');
// Owner link: an existing member's device becomes owner...
const own = await ok('ClaimOwner', { token: created.ownerToken, knownTokens: [member] });
assert.equal(own.groupId, created.groupId);
assert.equal(own.deviceToken, '');
assert.equal((await ok('GetGroup', {}, member)).me.owner, true);
// ...and a browser that isn't in the group gets a new owner device.
const fresh = await ok('ClaimOwner', { token: created.ownerToken });
assert.ok(fresh.deviceToken);
assert.equal((await ok('GetGroup', {}, fresh.deviceToken)).me.owner, true);
// New links replace the old ones.
const newOwner = await ok('RotateLink', { kind: 'LINK_KIND_OWNER' }, member);
await fails('ClaimOwner', { token: created.ownerToken }, undefined, 'not_found');
await ok('ClaimOwner', { token: newOwner.ownerToken, knownTokens: [owner] });
const newDash = await ok('RotateLink', { kind: 'LINK_KIND_DASHBOARD' }, member);
await fails('GetDashboard', { token: dash }, undefined, 'not_found');
assert.equal((await ok('GetDashboard', { token: newDash.dashboardToken })).groupName, 'Office');
const rot = await ok('RotateLink', { kind: 'LINK_KIND_OFFICE' }, member);
assert.notEqual(rot.officeCode, code);
await fails('Join', { code }, undefined, 'not_found');
const list = (await ok('ListDevices', {}, member)).devices;
assert.ok(list.length >= 6 && list.filter((d) => d.isMe).length === 1);
// Anyone can leave; owners can remove others.
await ok('RemoveDevice', { deviceId: list.at(-1).id }, member);
await ok('DeleteGroup', {}, member);
await fails('GetGroup', {}, owner, 'unauthenticated');
console.log('smoke ok');
