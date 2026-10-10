// JSON API for the scoreboard. Only /api/* reaches this Worker; everything else
// is served as static assets from public/ (free, not counted as requests).
//
// Auth: no accounts. Joining a group with its invite code gives the browser a
// device token (sent as "Authorization: Bearer <token>"); only its SHA-256 is
// stored. A token belongs to exactly one group. Office trust: every member may
// log, edit and delete any round and manage players and games.
//
// Three links per group: the office link (/j/<code>) to join, the read-only
// dashboard link (/d/<token>), and the owner link (/o/<token>) whose devices
// may replace links, rename or delete the group and remove devices.
//
// D1 free plan: 50 queries per request and 100 bound parameters per query, so
// bulk writes go through a single JSON parameter and json_each(). Daily row
// quotas are shared by the whole account, hence the rate limits and caps.

import { applyRound, newRating } from '../public/rating.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_NAME = 40;
const MAX_TEAM = 8;
const PAGE = 50;
const MAX_PAGE = 200;
// Recalculating more rounds than this in one request risks the 10 ms CPU limit.
const MAX_RERATE = 800;
const CAPS = { players: 200, games: 50, devices: 500, tournaments: 200, roundsPerDay: 500 };

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// A concurrent rating write got in first; the request is retried.
class Stale extends Error {}

const bad = (msg) => new HttpError(400, msg);
const forbidden = () => new HttpError(403, 'forbidden');
const notFound = () => new HttpError(404, 'not found');

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}

// Rejection sampling, so every character is equally likely.
function randomString(alphabet, length) {
    const max = 256 - (256 % alphabet.length);
    let out = '';
    while (out.length < length) {
        for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
            if (b < max && out.length < length) out += alphabet[b % alphabet.length];
        }
    }
    return out;
}

const newId = () => randomString('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const newCode = () => randomString(CODE_ALPHABET, 8);

function newToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// "abcd-efgh", "ABCDEFGH", " abcd efgh " all mean ABCDEFGH.
export function normalizeCode(input) {
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

// NFKC, no invisible/bidi control characters, single spaces.
export function cleanName(value, field = 'name') {
    const name = String(value ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    if (!name) throw bad(`${field} required`);
    if (name.length > MAX_NAME) throw bad(`${field} too long`);
    return name;
}

const nameKey = (name) => name.toLowerCase();

function optionalName(value, field) {
    return value === null || value === undefined || String(value).trim() === '' ? null : cleanName(value, field);
}

function optionalScore(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw bad('invalid score');
    return n;
}

// "iPhone · Safari" from a User-Agent, to tell devices apart in settings.
export function deviceLabel(ua = '') {
    const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
        : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : '';
    return [device, browser].filter(Boolean).join(' · ') || null;
}

async function body(request) {
    try {
        return await request.json();
    } catch {
        throw bad('invalid JSON');
    }
}

async function limit(binding, key) {
    if (!binding) return;
    const { success } = await binding.limit({ key });
    if (!success) throw new HttpError(429, 'too many requests, wait a minute');
}

const ipKey = (request) => request.headers.get('cf-connecting-ip') || 'local';

async function count(env, sql, ...args) {
    const row = await env.DB.prepare(sql).bind(...args).first();
    return Object.values(row)[0];
}

async function cap(env, max, sql, ...args) {
    if (await count(env, sql, ...args) >= max) throw new HttpError(409, 'limit reached');
}

// ---- auth -------------------------------------------------------------------

async function authenticate(env, ctx, request, groupId) {
    const header = request.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'not joined');
    const row = await env.DB.prepare('SELECT id, group_id, player_id, is_owner, last_seen FROM devices WHERE token_hash = ?')
        .bind(await sha256(token)).first();
    if (!row || row.group_id !== groupId) throw new HttpError(401, 'not joined');
    const now = Date.now();
    if (!row.last_seen || now - row.last_seen > 86400000) {
        ctx.waitUntil(env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(now, row.id).run());
    }
    return { id: row.id, groupId, playerId: row.player_id, owner: !!row.is_owner };
}

function requireOwner(me) {
    if (!me.owner) throw forbidden();
}

// ---- loading ----------------------------------------------------------------

async function loadGame(env, me, gameId) {
    const game = await env.DB.prepare('SELECT * FROM games WHERE id = ? AND group_id = ?').bind(gameId, me.groupId).first();
    if (!game) throw notFound();
    return game;
}

async function loadRound(env, me, roundId) {
    const round = await env.DB.prepare(
        'SELECT r.* FROM rounds r JOIN games g ON g.id = r.game_id WHERE r.id = ? AND g.group_id = ?',
    ).bind(roundId, me.groupId).first();
    if (!round) throw notFound();
    return round;
}

async function roundPlayerRows(env, roundId) {
    const { results } = await env.DB.prepare('SELECT * FROM round_players WHERE round_id = ?').bind(roundId).all();
    return results;
}

const teamsOf = (rows) => [0, 1].map((t) => rows.filter((p) => p.team === t).map((p) => p.player_id));

function gameOut(g) {
    return { id: g.id, name: g.name, teamA: g.team_a, teamB: g.team_b, archived: !!g.archived, createdAt: g.created_at };
}

function tournamentOut(t) {
    return { id: t.id, gameId: t.game_id, name: t.name, createdAt: t.created_at, endedAt: t.ended_at };
}

// rounds: rows from `rounds`; fills in players from round_players.
async function roundsOut(env, rounds) {
    if (!rounds.length) return [];
    const { results } = await env.DB.prepare(
        'SELECT * FROM round_players WHERE round_id IN (SELECT value FROM json_each(?))',
    ).bind(JSON.stringify(rounds.map((r) => r.id))).all();
    const byRound = new Map();
    for (const p of results) {
        if (!byRound.has(p.round_id)) byRound.set(p.round_id, []);
        byRound.get(p.round_id).push({
            id: p.player_id,
            team: p.team,
            before: p.mu_before === null ? null : { mu: p.mu_before, sigma: p.sigma_before },
            after: p.mu_after === null ? null : { mu: p.mu_after, sigma: p.sigma_after },
        });
    }
    return rounds.map((r) => ({
        id: r.id,
        gameId: r.game_id,
        tournamentId: r.tournament_id,
        playedAt: r.played_at,
        winner: r.winner,
        scoreA: r.score_a,
        scoreB: r.score_b,
        createdBy: r.created_by,
        deleted: !!r.deleted_at,
        players: byRound.get(r.id) || [],
    }));
}

// ---- ratings ----------------------------------------------------------------

// Validates a teams payload against the group's players; returns [[ids], [ids]].
async function checkTeams(env, me, teams) {
    if (!Array.isArray(teams) || teams.length !== 2) throw bad('two teams required');
    const seen = new Set();
    for (const team of teams) {
        if (!Array.isArray(team) || team.length < 1) throw bad('each team needs a player');
        if (team.length > MAX_TEAM) throw bad('team too large');
        for (const id of team) {
            if (typeof id !== 'string' || seen.has(id)) throw bad('invalid players');
            seen.add(id);
        }
    }
    const n = await count(env, 'SELECT COUNT(*) FROM players WHERE group_id = ? AND id IN (SELECT value FROM json_each(?))',
        me.groupId, JSON.stringify([...seen]));
    if (n !== seen.size) throw bad('unknown player');
    return teams.map((t) => [...t]);
}

async function checkTournament(env, gameId, tournamentId) {
    if (!tournamentId) return null;
    const t = await env.DB.prepare('SELECT id FROM tournaments WHERE id = ? AND game_id = ?').bind(tournamentId, gameId).first();
    if (!t) throw bad('unknown tournament');
    return t.id;
}

const J = (i) => `json_extract(j.value, '$[${i}]')`;

const upsertRoundPlayers = `INSERT INTO round_players (round_id, player_id, team, mu_before, sigma_before, mu_after, sigma_after)
    SELECT ${[0, 1, 2, 3, 4, 5, 6].map(J).join(', ')} FROM json_each(?1) j WHERE true
    ON CONFLICT (round_id, player_id) DO UPDATE SET team = excluded.team,
        mu_before = excluded.mu_before, sigma_before = excluded.sigma_before,
        mu_after = excluded.mu_after, sigma_after = excluded.sigma_after`;

const upsertRatings = `INSERT INTO ratings (game_id, player_id, mu, sigma, rounds, wins)
    SELECT ?1, ${[0, 1, 2, 3, 4].map(J).join(', ')} FROM json_each(?2) j WHERE true
    ON CONFLICT (game_id, player_id) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma,
        rounds = excluded.rounds, wins = excluded.wins`;

const upsertHandicaps = `INSERT INTO handicaps (game_id, format, mu, sigma)
    SELECT ?1, ${[0, 1, 2].map(J).join(', ')} FROM json_each(?2) j WHERE true
    ON CONFLICT (game_id, format) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma`;

const updateRoundHandicaps = `UPDATE rounds SET format = ${J(1)}, h_mu_before = ${J(2)}, h_sigma_before = ${J(3)},
    h_mu_after = ${J(4)}, h_sigma_after = ${J(5)}
    FROM json_each(?1) j WHERE rounds.id = ${J(0)}`;

// Fails the whole batch (json() of invalid JSON raises) unless the game's
// version is still the one read at the start of the request.
const versionGuard = `UPDATE games SET version = version + 1
    WHERE id = ?1 AND CASE WHEN version = ?2 THEN 1 ELSE json('stale') END`;

function chunks(items, size = 1000) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

const near = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-9;

// Recalculates ratings after one round changes, starting at that round rather
// than at the beginning of the game, and commits everything — including the
// caller's own `statements` (the round insert/update) — in one batch.
//
// round: the round's row before the change (or { id, played_at } for a new
// one). oldRows: its stored round_players. wasActive: it counted before.
// def: { teams, winner } if it counts after the change, else null.
//
// The state just before the round comes from stored values: the round's own
// "before" values, else each player's first later round's "before" values,
// else their current rating. Round counts only change by this round.
async function rerate(env, game, round, oldRows, wasActive, def, statements) {
    const later = await count(env,
        `SELECT COUNT(*) FROM rounds WHERE game_id = ?1 AND deleted_at IS NULL AND id != ?2
         AND (played_at > ?3 OR (played_at = ?3 AND id > ?2))`, game.id, round.id, round.played_at);
    if (later > MAX_RERATE) throw new HttpError(409, 'too far back to change');
    const [windowRes, handicapRes] = await env.DB.batch([
        env.DB.prepare(
            `SELECT r.id, r.played_at, r.winner, r.format, r.h_mu_before, r.h_sigma_before,
                    rp.player_id, rp.team, rp.mu_before, rp.sigma_before, rp.mu_after, rp.sigma_after
             FROM rounds r JOIN round_players rp ON rp.round_id = r.id
             WHERE r.game_id = ?1 AND r.deleted_at IS NULL AND r.id != ?2
               AND (r.played_at > ?3 OR (r.played_at = ?3 AND r.id > ?2))
             ORDER BY r.played_at, r.id`,
        ).bind(game.id, round.id, round.played_at),
        env.DB.prepare('SELECT * FROM handicaps WHERE game_id = ?').bind(game.id),
    ]);
    const windowRounds = [];
    for (const row of windowRes.results) {
        let r = windowRounds[windowRounds.length - 1];
        if (!r || r.id !== row.id) {
            r = {
                id: row.id, winner: row.winner, format: row.format,
                hBefore: row.h_mu_before === null ? null : { mu: row.h_mu_before, sigma: row.h_sigma_before },
                teams: [[], []], stored: new Map(),
            };
            windowRounds.push(r);
        }
        r.teams[row.team].push(row.player_id);
        r.stored.set(row.player_id, row);
    }

    const ids = new Set([...oldRows.map((p) => p.player_id), ...(def ? def.teams.flat() : [])]);
    for (const r of windowRounds) for (const id of r.stored.keys()) ids.add(id);
    const { results: currentRows } = await env.DB.prepare(
        'SELECT * FROM ratings WHERE game_id = ? AND player_id IN (SELECT value FROM json_each(?))',
    ).bind(game.id, JSON.stringify([...ids])).all();
    const current = new Map(currentRows.map((r) => [r.player_id, r]));

    // State just before the round.
    const ratings = new Map();
    if (wasActive) {
        for (const p of oldRows) if (p.mu_before !== null) ratings.set(p.player_id, { mu: p.mu_before, sigma: p.sigma_before });
    }
    for (const r of windowRounds) {
        for (const [id, row] of r.stored) if (!ratings.has(id)) ratings.set(id, { mu: row.mu_before, sigma: row.sigma_before });
    }
    for (const id of ids) {
        if (!ratings.has(id)) ratings.set(id, current.has(id) ? { mu: current.get(id).mu, sigma: current.get(id).sigma } : newRating());
    }
    const handicaps = new Map(handicapRes.results.map((h) => [h.format, { mu: h.mu, sigma: h.sigma }]));
    const hStart = new Map();
    if (wasActive && round.format && round.h_mu_before !== null) hStart.set(round.format, { mu: round.h_mu_before, sigma: round.h_sigma_before });
    for (const r of windowRounds) if (r.format && r.hBefore && !hStart.has(r.format)) hStart.set(r.format, r.hBefore);
    for (const [f, h] of hStart) handicaps.set(f, h);
    const touchedFormats = new Set(hStart.keys());

    // Replay the changed round and everything after it.
    const rpRows = [];
    const hRows = [];
    if (def) {
        const res = applyRound(ratings, handicaps, { teams: def.teams, winner: def.winner });
        def.teams.forEach((team, t) => team.forEach((id) => {
            const c = res.players.get(id);
            rpRows.push([round.id, id, t, c.before.mu, c.before.sigma, c.after.mu, c.after.sigma]);
        }));
        const h = res.handicap;
        hRows.push([round.id, res.format, h?.before.mu ?? null, h?.before.sigma ?? null, h?.after.mu ?? null, h?.after.sigma ?? null]);
        if (res.format) touchedFormats.add(res.format);
    }
    for (const r of windowRounds) {
        const res = applyRound(ratings, handicaps, r);
        for (const [id, c] of res.players) {
            const s = r.stored.get(id);
            if (near(s.mu_before, c.before.mu) && near(s.sigma_before, c.before.sigma)
                && near(s.mu_after, c.after.mu) && near(s.sigma_after, c.after.sigma)) continue;
            rpRows.push([r.id, id, s.team, c.before.mu, c.before.sigma, c.after.mu, c.after.sigma]);
        }
        const h = res.handicap;
        if (h && !(r.hBefore && near(r.hBefore.mu, h.before.mu) && near(r.hBefore.sigma, h.before.sigma))) {
            hRows.push([r.id, res.format, h.before.mu, h.before.sigma, h.after.mu, h.after.sigma]);
        }
    }

    // Round counts change only by this round.
    const counts = new Map([...ids].map((id) => [id, { rounds: current.get(id)?.rounds ?? 0, wins: current.get(id)?.wins ?? 0 }]));
    if (wasActive) {
        for (const p of oldRows) {
            const c = counts.get(p.player_id);
            c.rounds--;
            if (p.team === round.winner) c.wins--;
        }
    }
    if (def) {
        def.teams.forEach((team, t) => team.forEach((id) => {
            const c = counts.get(id);
            c.rounds++;
            if (t === def.winner) c.wins++;
        }));
    }
    const ratingRows = [];
    const gone = [];
    for (const id of ids) {
        const c = counts.get(id);
        const r = ratings.get(id);
        if (c.rounds <= 0) gone.push(id);
        else ratingRows.push([id, r.mu, r.sigma, c.rounds, c.wins]);
    }
    const hcRows = [...touchedFormats].map((f) => [f, handicaps.get(f).mu, handicaps.get(f).sigma]);

    const batch = [env.DB.prepare(versionGuard).bind(game.id, game.version), ...statements];
    if (def) batch.push(env.DB.prepare('DELETE FROM round_players WHERE round_id = ?').bind(round.id));
    for (const c of chunks(rpRows)) batch.push(env.DB.prepare(upsertRoundPlayers).bind(JSON.stringify(c)));
    for (const c of chunks(hRows)) batch.push(env.DB.prepare(updateRoundHandicaps).bind(JSON.stringify(c)));
    for (const c of chunks(ratingRows)) batch.push(env.DB.prepare(upsertRatings).bind(game.id, JSON.stringify(c)));
    if (gone.length) {
        batch.push(env.DB.prepare('DELETE FROM ratings WHERE game_id = ? AND player_id IN (SELECT value FROM json_each(?))')
            .bind(game.id, JSON.stringify(gone)));
    }
    if (hcRows.length) batch.push(env.DB.prepare(upsertHandicaps).bind(game.id, JSON.stringify(hcRows)));
    try {
        await env.DB.batch(batch);
    } catch (err) {
        if (/malformed JSON/i.test(`${err?.message} ${err?.cause?.message}`)) throw new Stale();
        throw err;
    }
}

// Runs a rating write, retrying if another write to the same game got in first.
async function retrying(fn) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!(err instanceof Stale)) throw err;
            if (attempt >= 4) throw new HttpError(503, 'busy, try again');
        }
    }
}

// ---- handlers: groups, links, devices ---------------------------------------

const newDashboardToken = () => randomString('abcdefghijklmnopqrstuvwxyz0123456789', 16);

async function createGroup(env, request) {
    await limit(env.JOIN_LIMIT, ipKey(request));
    const input = await body(request);
    const name = cleanName(input.name, 'group name');
    const now = Date.now();
    const groupId = newId();
    const token = newToken();
    const ownerToken = newToken();
    const statements = [
        env.DB.prepare('INSERT INTO groups (id, name, invite_code, dashboard_token, owner_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(groupId, name, newCode(), newDashboardToken(), await sha256(ownerToken), now),
    ];
    let playerId = null;
    if (input.playerName) {
        const playerName = cleanName(input.playerName, 'player name');
        playerId = newId();
        statements.push(env.DB.prepare('INSERT INTO players (id, group_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(playerId, groupId, playerName, nameKey(playerName), now));
    }
    statements.push(env.DB.prepare(
        'INSERT INTO devices (id, token_hash, group_id, player_id, is_owner, label, created_at, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
    ).bind(newId(), await sha256(token), groupId, playerId, deviceLabel(request.headers.get('user-agent') || ''), now, now));
    let gameId = null;
    if (input.gameName) {
        gameId = newId();
        statements.push(env.DB.prepare('INSERT INTO games (id, group_id, name, created_at) VALUES (?, ?, ?, ?)')
            .bind(gameId, groupId, cleanName(input.gameName, 'game name'), now));
    }
    await env.DB.batch(statements);
    return json({ token, groupId, name, gameId, ownerToken }, 201);
}

async function addDevice(env, request, groupId, owner) {
    await cap(env, CAPS.devices, 'SELECT COUNT(*) FROM devices WHERE group_id = ?', groupId);
    const token = newToken();
    const now = Date.now();
    await env.DB.prepare(
        'INSERT INTO devices (id, token_hash, group_id, is_owner, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(newId(), await sha256(token), groupId, owner ? 1 : 0, deviceLabel(request.headers.get('user-agent') || ''), now, now).run();
    return token;
}

// Office link: anyone with the code joins as a member.
async function joinGroup(env, request) {
    await limit(env.JOIN_LIMIT, ipKey(request));
    const input = await body(request);
    const code = normalizeCode(input.code);
    if (code.length !== 8) throw new HttpError(404, 'unknown code');
    const group = await env.DB.prepare('SELECT id, name FROM groups WHERE invite_code = ?').bind(code).first();
    if (!group) throw new HttpError(404, 'unknown code');
    const token = await addDevice(env, request, group.id, false);
    return json({ token, groupId: group.id, name: group.name }, 201);
}

// Owner link: makes this browser an owner — its existing device in the group
// if it has one (it sends the tokens it knows), else a new device.
async function claimOwner(env, request) {
    await limit(env.JOIN_LIMIT, ipKey(request));
    const input = await body(request);
    const group = await env.DB.prepare('SELECT id, name FROM groups WHERE owner_hash = ?')
        .bind(await sha256(String(input.token || ''))).first();
    if (!group) throw new HttpError(404, 'unknown link');
    const hashes = await Promise.all((Array.isArray(input.tokens) ? input.tokens.slice(0, 50) : []).map((t) => sha256(String(t))));
    const existing = hashes.length ? await env.DB.prepare(
        'SELECT id FROM devices WHERE group_id = ? AND token_hash IN (SELECT value FROM json_each(?))',
    ).bind(group.id, JSON.stringify(hashes)).first() : null;
    if (existing) {
        await env.DB.prepare('UPDATE devices SET is_owner = 1 WHERE id = ?').bind(existing.id).run();
        return json({ groupId: group.id, name: group.name, token: null });
    }
    const token = await addDevice(env, request, group.id, true);
    return json({ groupId: group.id, name: group.name, token }, 201);
}

// Owners can replace any of the three links; the old one stops working.
async function rotateLink(env, me, kind) {
    requireOwner(me);
    if (kind === 'office') {
        const code = newCode();
        await env.DB.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').bind(code, me.groupId).run();
        return json({ inviteCode: formatCode(code) });
    }
    if (kind === 'dashboard') {
        const token = newDashboardToken();
        await env.DB.prepare('UPDATE groups SET dashboard_token = ? WHERE id = ?').bind(token, me.groupId).run();
        return json({ dashboardToken: token });
    }
    if (kind === 'owner') {
        const token = newToken();
        await env.DB.prepare('UPDATE groups SET owner_hash = ? WHERE id = ?').bind(await sha256(token), me.groupId).run();
        return json({ ownerToken: token });
    }
    throw notFound();
}

async function getGroup(env, me) {
    const [group, players, games, owners] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(me.groupId),
        env.DB.prepare('SELECT * FROM players WHERE group_id = ? ORDER BY name COLLATE NOCASE').bind(me.groupId),
        env.DB.prepare('SELECT * FROM games WHERE group_id = ? ORDER BY created_at').bind(me.groupId),
        env.DB.prepare('SELECT player_id, label FROM devices WHERE group_id = ? AND is_owner = 1').bind(me.groupId),
    ]);
    const g = group.results[0];
    return json({
        group: {
            id: g.id,
            name: g.name,
            inviteCode: formatCode(g.invite_code),
            dashboardToken: g.dashboard_token,
            createdAt: g.created_at,
        },
        me: { deviceId: me.id, playerId: me.playerId, owner: me.owner },
        owners: owners.results.map((d) => ({ playerId: d.player_id, label: d.label })),
        players: players.results.map((p) => ({ id: p.id, name: p.name, archived: !!p.archived })),
        games: games.results.map(gameOut),
    });
}

async function updateGroup(env, me, request) {
    requireOwner(me);
    const input = await body(request);
    if (input.name !== undefined) {
        await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(cleanName(input.name, 'group name'), me.groupId).run();
    }
    return json({ ok: true });
}

async function deleteGroup(env, me) {
    requireOwner(me);
    await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(me.groupId).run();
    return json({ ok: true });
}

async function listDevices(env, me) {
    requireOwner(me);
    const { results } = await env.DB.prepare(
        'SELECT id, player_id, is_owner, label, created_at, last_seen FROM devices WHERE group_id = ? ORDER BY created_at',
    ).bind(me.groupId).all();
    return json({
        devices: results.map((d) => ({
            id: d.id, playerId: d.player_id, owner: !!d.is_owner, label: d.label,
            createdAt: d.created_at, lastSeen: d.last_seen, me: d.id === me.id,
        })),
    });
}

// Owners can remove any device; anyone can remove (leave with) their own.
async function deleteDevice(env, me, deviceId) {
    if (deviceId !== me.id) requireOwner(me);
    await env.DB.prepare('DELETE FROM devices WHERE id = ? AND group_id = ?').bind(deviceId, me.groupId).run();
    return json({ ok: true });
}

async function setMe(env, me, request) {
    const input = await body(request);
    let playerId = null;
    if (input.playerId) {
        const p = await env.DB.prepare('SELECT id FROM players WHERE id = ? AND group_id = ?').bind(input.playerId, me.groupId).first();
        if (!p) throw bad('unknown player');
        playerId = p.id;
    }
    await env.DB.prepare('UPDATE devices SET player_id = ? WHERE id = ?').bind(playerId, me.id).run();
    return json({ ok: true });
}

// ---- dashboard (read-only, no device) ----------------------------------------

async function dashboardGroup(env, token) {
    const group = await env.DB.prepare('SELECT id, name FROM groups WHERE dashboard_token = ?').bind(String(token)).first();
    if (!group) throw new HttpError(404, 'unknown link');
    return group;
}

async function getDashboard(env, token) {
    const group = await dashboardGroup(env, token);
    const [games, players] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM games WHERE group_id = ? AND archived = 0 ORDER BY created_at').bind(group.id),
        env.DB.prepare('SELECT id, name, archived FROM players WHERE group_id = ?').bind(group.id),
    ]);
    return json({
        group: { name: group.name },
        games: games.results.map(gameOut),
        players: players.results.map((p) => ({ id: p.id, name: p.name, archived: !!p.archived })),
    });
}

async function getDashboardGame(env, token, gameId, url) {
    const group = await dashboardGroup(env, token);
    return getGame(env, { groupId: group.id }, gameId, url);
}

// ---- handlers: players, games, tournaments ----------------------------------

async function createPlayer(env, me, request) {
    const input = await body(request);
    const name = cleanName(input.name, 'player name');
    const taken = await env.DB.prepare('SELECT id, name, archived FROM players WHERE group_id = ? AND name_key = ?')
        .bind(me.groupId, nameKey(name)).first();
    if (taken) return json({ error: 'name taken', player: { id: taken.id, name: taken.name, archived: !!taken.archived } }, 409);
    await cap(env, CAPS.players, 'SELECT COUNT(*) FROM players WHERE group_id = ?', me.groupId);
    const id = newId();
    const statements = [env.DB.prepare('INSERT INTO players (id, group_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, me.groupId, name, nameKey(name), Date.now())];
    if (input.me) statements.push(env.DB.prepare('UPDATE devices SET player_id = ? WHERE id = ?').bind(id, me.id));
    await env.DB.batch(statements);
    return json({ id, name, archived: false }, 201);
}

async function updatePlayer(env, me, playerId, request) {
    const input = await body(request);
    const sets = [];
    const args = [];
    if (input.name !== undefined) {
        const name = cleanName(input.name, 'player name');
        const taken = await env.DB.prepare('SELECT id FROM players WHERE group_id = ? AND name_key = ? AND id != ?')
            .bind(me.groupId, nameKey(name), playerId).first();
        if (taken) throw new HttpError(409, 'name taken');
        sets.push('name = ?', 'name_key = ?');
        args.push(name, nameKey(name));
    }
    if (input.archived !== undefined) { sets.push('archived = ?'); args.push(input.archived ? 1 : 0); }
    if (sets.length) {
        await env.DB.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ? AND group_id = ?`).bind(...args, playerId, me.groupId).run();
    }
    return json({ ok: true });
}

async function createGame(env, me, request) {
    const input = await body(request);
    await cap(env, CAPS.games, 'SELECT COUNT(*) FROM games WHERE group_id = ?', me.groupId);
    const row = {
        id: newId(),
        group_id: me.groupId,
        name: cleanName(input.name, 'game name'),
        team_a: optionalName(input.teamA, 'team name'),
        team_b: optionalName(input.teamB, 'team name'),
        archived: 0,
        created_at: Date.now(),
    };
    await env.DB.prepare('INSERT INTO games (id, group_id, name, team_a, team_b, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.group_id, row.name, row.team_a, row.team_b, row.created_at).run();
    return json(gameOut(row), 201);
}

async function updateGame(env, me, gameId, request) {
    await loadGame(env, me, gameId);
    const input = await body(request);
    const sets = [];
    const args = [];
    if (input.name !== undefined) { sets.push('name = ?'); args.push(cleanName(input.name, 'game name')); }
    if (input.teamA !== undefined) { sets.push('team_a = ?'); args.push(optionalName(input.teamA, 'team name')); }
    if (input.teamB !== undefined) { sets.push('team_b = ?'); args.push(optionalName(input.teamB, 'team name')); }
    if (input.archived !== undefined) { sets.push('archived = ?'); args.push(input.archived ? 1 : 0); }
    if (sets.length) await env.DB.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).bind(...args, gameId).run();
    return json({ ok: true });
}

// Leaderboard, handicaps, tournaments and recent rounds in one call. `since`
// (ms) is the start of "today" in the viewer's time zone; rounds since then
// are always included so the client can show today's changes.
async function getGame(env, me, gameId, url) {
    const game = await loadGame(env, me, gameId);
    const since = Number(url.searchParams.get('since')) || Date.now() - 86400000;
    const [ratings, handicaps, tournaments, rounds] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM ratings WHERE game_id = ?').bind(gameId),
        env.DB.prepare('SELECT * FROM handicaps WHERE game_id = ?').bind(gameId),
        env.DB.prepare('SELECT * FROM tournaments WHERE game_id = ? ORDER BY created_at DESC LIMIT 50').bind(gameId),
        env.DB.prepare(
            `SELECT * FROM rounds WHERE game_id = ?1 AND deleted_at IS NULL AND played_at >= ?2
             UNION SELECT * FROM (SELECT * FROM rounds WHERE game_id = ?1 AND deleted_at IS NULL ORDER BY played_at DESC LIMIT 20)
             ORDER BY played_at DESC, id DESC LIMIT 200`,
        ).bind(gameId, since),
    ]);
    return json({
        game: gameOut(game),
        ratings: ratings.results.map((r) => ({ playerId: r.player_id, mu: r.mu, sigma: r.sigma, rounds: r.rounds, wins: r.wins })),
        handicaps: handicaps.results.map((h) => ({ format: h.format, mu: h.mu, sigma: h.sigma })),
        tournaments: tournaments.results.map(tournamentOut),
        rounds: await roundsOut(env, rounds.results),
    });
}

// Paged history, newest first. Cursor: "playedAt.id" from the previous page's
// `next`. Filters: tournament, player.
async function listRounds(env, me, gameId, url) {
    await loadGame(env, me, gameId);
    const size = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('limit'))) || PAGE, 1), MAX_PAGE);
    const tournament = url.searchParams.get('tournament');
    const player = url.searchParams.get('player');
    const [beforeAt, beforeId] = (url.searchParams.get('before') || '').split('.');
    let sql = 'SELECT r.* FROM rounds r';
    const args = [];
    if (player) { sql += ' JOIN round_players rp ON rp.round_id = r.id AND rp.player_id = ?'; args.push(player); }
    sql += ' WHERE r.game_id = ? AND r.deleted_at IS NULL';
    args.push(gameId);
    if (beforeAt && beforeId) {
        sql += ' AND (r.played_at < ? OR (r.played_at = ? AND r.id < ?))';
        args.push(Number(beforeAt), Number(beforeAt), beforeId);
    }
    if (tournament) { sql += ' AND r.tournament_id = ?'; args.push(tournament); }
    sql += ' ORDER BY r.played_at DESC, r.id DESC LIMIT ?';
    args.push(size + 1);
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    const page = results.slice(0, size);
    const last = page[page.length - 1];
    return json({ rounds: await roundsOut(env, page), next: results.length > size ? `${last.played_at}.${last.id}` : null });
}

// A player's whole history in a game, compactly: rating after every round and
// win/loss tallies with and against everyone.
async function playerStats(env, me, gameId, playerId) {
    await loadGame(env, me, gameId);
    const [history, pairs] = await env.DB.batch([
        env.DB.prepare(
            `SELECT r.played_at, r.winner, rp.team, rp.mu_after, rp.sigma_after
             FROM round_players rp JOIN rounds r ON r.id = rp.round_id
             WHERE rp.player_id = ? AND r.game_id = ? AND r.deleted_at IS NULL
             ORDER BY r.played_at, r.id`,
        ).bind(playerId, gameId),
        env.DB.prepare(
            `SELECT o.player_id, o.team = me.team AS same, COUNT(*) AS games, SUM(me.team = r.winner) AS wins
             FROM round_players me JOIN rounds r ON r.id = me.round_id
             JOIN round_players o ON o.round_id = me.round_id AND o.player_id != me.player_id
             WHERE me.player_id = ? AND r.game_id = ? AND r.deleted_at IS NULL
             GROUP BY o.player_id, same`,
        ).bind(playerId, gameId),
    ]);
    return json({
        history: history.results.map((h) => [h.played_at, h.mu_after, h.sigma_after, h.team === h.winner ? 1 : 0]),
        with: pairs.results.filter((p) => p.same).map((p) => ({ id: p.player_id, games: p.games, wins: p.wins })),
        against: pairs.results.filter((p) => !p.same).map((p) => ({ id: p.player_id, games: p.games, wins: p.wins })),
    });
}

async function createTournament(env, me, gameId, request) {
    await loadGame(env, me, gameId);
    const input = await body(request);
    await cap(env, CAPS.tournaments, 'SELECT COUNT(*) FROM tournaments WHERE game_id = ?', gameId);
    const t = { id: newId(), game_id: gameId, name: cleanName(input.name, 'tournament name'), created_at: Date.now(), ended_at: null };
    await env.DB.prepare('INSERT INTO tournaments (id, game_id, name, created_at) VALUES (?, ?, ?, ?)')
        .bind(t.id, t.game_id, t.name, t.created_at).run();
    return json(tournamentOut(t), 201);
}

async function updateTournament(env, me, tournamentId, request) {
    const t = await env.DB.prepare(
        'SELECT t.* FROM tournaments t JOIN games g ON g.id = t.game_id WHERE t.id = ? AND g.group_id = ?',
    ).bind(tournamentId, me.groupId).first();
    if (!t) throw notFound();
    const input = await body(request);
    const sets = [];
    const args = [];
    if (input.name !== undefined) { sets.push('name = ?'); args.push(cleanName(input.name, 'tournament name')); }
    if (input.ended !== undefined) { sets.push('ended_at = ?'); args.push(input.ended ? Date.now() : null); }
    if (sets.length) await env.DB.prepare(`UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?`).bind(...args, tournamentId).run();
    return json({ ok: true });
}

// ---- handlers: rounds --------------------------------------------------------

async function createRound(env, me, gameId, request) {
    const input = await body(request);
    if (input.winner !== 0 && input.winner !== 1) throw bad('winner required');
    await loadGame(env, me, gameId);
    const teams = await checkTeams(env, me, input.teams);
    const tournamentId = await checkTournament(env, gameId, input.tournamentId);
    await cap(env, CAPS.roundsPerDay, 'SELECT COUNT(*) FROM rounds WHERE game_id = ? AND played_at > ?', gameId, Date.now() - 86400000);
    const round = { id: newId(), played_at: Date.now() };
    const insert = env.DB.prepare(
        `INSERT INTO rounds (id, game_id, tournament_id, played_at, winner, score_a, score_b, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(round.id, gameId, tournamentId, round.played_at, input.winner, optionalScore(input.scoreA), optionalScore(input.scoreB), me.id);
    await retrying(async () => {
        const game = await loadGame(env, me, gameId);
        await rerate(env, game, round, [], false, { teams, winner: input.winner }, [insert]);
    });
    const row = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?').bind(round.id).first();
    return json((await roundsOut(env, [row]))[0], 201);
}

async function updateRound(env, me, roundId, request) {
    const input = await body(request);
    if (input.winner !== undefined && input.winner !== 0 && input.winner !== 1) throw bad('invalid winner');
    const newTeams = input.teams !== undefined ? await checkTeams(env, me, input.teams) : null;
    await retrying(async () => {
        const round = await loadRound(env, me, roundId);
        const oldRows = await roundPlayerRows(env, roundId);
        const sets = [];
        const args = [];
        if (input.scoreA !== undefined) { sets.push('score_a = ?'); args.push(optionalScore(input.scoreA)); }
        if (input.scoreB !== undefined) { sets.push('score_b = ?'); args.push(optionalScore(input.scoreB)); }
        if (input.tournamentId !== undefined) { sets.push('tournament_id = ?'); args.push(await checkTournament(env, round.game_id, input.tournamentId)); }
        const winner = input.winner ?? round.winner;
        const teams = newTeams ?? teamsOf(oldRows);
        const key = (t) => JSON.stringify(t.map((x) => [...x].sort()));
        const ratingChange = winner !== round.winner || key(teams) !== key(teamsOf(oldRows));
        if (winner !== round.winner) { sets.push('winner = ?'); args.push(winner); }
        const statements = sets.length ? [env.DB.prepare(`UPDATE rounds SET ${sets.join(', ')} WHERE id = ?`).bind(...args, roundId)] : [];
        if (ratingChange && !round.deleted_at) {
            const game = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(round.game_id).first();
            await rerate(env, game, round, oldRows, true, { teams, winner }, statements);
            return;
        }
        if (ratingChange) {
            // A deleted round doesn't count; just keep its new line-up for a restore.
            statements.push(env.DB.prepare('DELETE FROM round_players WHERE round_id = ?').bind(roundId));
            statements.push(env.DB.prepare(upsertRoundPlayers).bind(JSON.stringify(
                teams.flatMap((team, t) => team.map((id) => [roundId, id, t, null, null, null, null])))));
        }
        if (statements.length) await env.DB.batch(statements);
    });
    const updated = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?').bind(roundId).first();
    return json((await roundsOut(env, [updated]))[0]);
}

async function setRoundDeleted(env, me, roundId, deleted) {
    await retrying(async () => {
        const round = await loadRound(env, me, roundId);
        if (!!round.deleted_at === deleted) return;
        const oldRows = await roundPlayerRows(env, roundId);
        const game = await env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(round.game_id).first();
        const mark = env.DB.prepare('UPDATE rounds SET deleted_at = ? WHERE id = ?').bind(deleted ? Date.now() : null, roundId);
        if (deleted) await rerate(env, game, round, oldRows, true, null, [mark]);
        else await rerate(env, game, round, oldRows, false, { teams: teamsOf(oldRows), winner: round.winner }, [mark]);
    });
    return json({ ok: true });
}

// ---- routing ----------------------------------------------------------------

const G = '^/api/g/(\\w+)';
const routes = [
    // [method, pattern, handler, auth: 'none' | 'read' | 'write' (rate-limited per device)]
    ['POST', '^/api/groups$', (c) => createGroup(c.env, c.req), 'none'],
    ['POST', '^/api/join$', (c) => joinGroup(c.env, c.req), 'none'],
    ['POST', '^/api/owner$', (c) => claimOwner(c.env, c.req), 'none'],
    ['GET', '^/api/d/(\\w+)$', (c) => getDashboard(c.env, c.m[1]), 'none'],
    ['GET', '^/api/d/(\\w+)/games/(\\w+)$', (c) => getDashboardGame(c.env, c.m[1], c.m[2], c.url), 'none'],
    ['GET', `${G}$`, (c) => getGroup(c.env, c.me), 'read'],
    ['PATCH', `${G}$`, (c) => updateGroup(c.env, c.me, c.req), 'write'],
    ['DELETE', `${G}$`, (c) => deleteGroup(c.env, c.me), 'write'],
    ['POST', `${G}/links/(office|dashboard|owner)$`, (c) => rotateLink(c.env, c.me, c.m[2]), 'write'],
    ['PUT', `${G}/me$`, (c) => setMe(c.env, c.me, c.req), 'write'],
    ['GET', `${G}/devices$`, (c) => listDevices(c.env, c.me), 'read'],
    ['DELETE', `${G}/devices/(\\w+)$`, (c) => deleteDevice(c.env, c.me, c.m[2]), 'write'],
    ['POST', `${G}/players$`, (c) => createPlayer(c.env, c.me, c.req), 'write'],
    ['PATCH', `${G}/players/(\\w+)$`, (c) => updatePlayer(c.env, c.me, c.m[2], c.req), 'write'],
    ['POST', `${G}/games$`, (c) => createGame(c.env, c.me, c.req), 'write'],
    ['GET', `${G}/games/(\\w+)$`, (c) => getGame(c.env, c.me, c.m[2], c.url), 'read'],
    ['PATCH', `${G}/games/(\\w+)$`, (c) => updateGame(c.env, c.me, c.m[2], c.req), 'write'],
    ['GET', `${G}/games/(\\w+)/rounds$`, (c) => listRounds(c.env, c.me, c.m[2], c.url), 'read'],
    ['POST', `${G}/games/(\\w+)/rounds$`, (c) => createRound(c.env, c.me, c.m[2], c.req), 'write'],
    ['GET', `${G}/games/(\\w+)/players/(\\w+)$`, (c) => playerStats(c.env, c.me, c.m[2], c.m[3]), 'read'],
    ['POST', `${G}/games/(\\w+)/tournaments$`, (c) => createTournament(c.env, c.me, c.m[2], c.req), 'write'],
    ['PATCH', `${G}/tournaments/(\\w+)$`, (c) => updateTournament(c.env, c.me, c.m[2], c.req), 'write'],
    ['PATCH', `${G}/rounds/(\\w+)$`, (c) => updateRound(c.env, c.me, c.m[2], c.req), 'write'],
    ['DELETE', `${G}/rounds/(\\w+)$`, (c) => setRoundDeleted(c.env, c.me, c.m[2], true), 'write'],
    ['POST', `${G}/rounds/(\\w+)/restore$`, (c) => setRoundDeleted(c.env, c.me, c.m[2], false), 'write'],
].map(([method, pattern, handler, auth]) => ({ method, pattern: new RegExp(pattern), handler, auth }));

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        try {
            const route = routes.find((r) => r.method === request.method && r.pattern.test(url.pathname));
            if (!route) throw notFound();
            const m = url.pathname.match(route.pattern);
            const me = route.auth === 'none' ? null : await authenticate(env, ctx, request, m[1]);
            if (route.auth === 'write') await limit(env.WRITE_LIMIT, me.id);
            return await route.handler({ env, req: request, me, m, url });
        } catch (err) {
            if (err instanceof HttpError) return json({ error: err.message }, err.status);
            console.error(err);
            return json({ error: 'internal error' }, 500);
        }
    },
};
