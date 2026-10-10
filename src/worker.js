// JSON API for the scoreboard. Only /api/* reaches this Worker; everything else
// is served as static assets from public/ (free, not counted as requests).
//
// Auth: no accounts. Joining a group with its invite code gives the browser a
// device token (sent as "Authorization: Bearer <token>"); only its SHA-256 is
// stored. A token belongs to exactly one group.
//
// D1 free plan: 50 queries per request and 100 bound parameters per query, so
// bulk writes go through a single JSON parameter and json_each().

import { applyRound, replay } from '../public/rating.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_NAME = 40;
const MAX_TEAM = 8;
const ROUNDS_PAGE = 50;

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const bad = (msg) => new HttpError(400, msg);
const forbidden = () => new HttpError(403, 'forbidden');
const notFound = () => new HttpError(404, 'not found');

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}

function randomString(alphabet, length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let out = '';
    for (const b of bytes) out += alphabet[b % alphabet.length];
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

function cleanName(value, field = 'name') {
    const name = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw bad(`${field} required`);
    if (name.length > MAX_NAME) throw bad(`${field} too long`);
    return name;
}

function optionalScore(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw bad('invalid score');
    return n;
}

async function body(request) {
    try {
        return await request.json();
    } catch {
        throw bad('invalid JSON');
    }
}

async function rateLimit(env, request) {
    if (!env.JOIN_LIMIT) return;
    const key = request.headers.get('cf-connecting-ip') || 'local';
    const { success } = await env.JOIN_LIMIT.limit({ key });
    if (!success) throw new HttpError(429, 'too many attempts, wait a minute');
}

// ---- auth -------------------------------------------------------------------

async function authenticate(env, request, groupId) {
    const header = request.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'not joined');
    const row = await env.DB.prepare(
        `SELECT d.id, d.group_id, d.player_id, d.is_admin, g.everyone_admin, g.edit_policy
         FROM devices d JOIN groups g ON g.id = d.group_id WHERE d.token_hash = ?`,
    ).bind(await sha256(token)).first();
    if (!row || row.group_id !== groupId) throw new HttpError(401, 'not joined');
    return {
        id: row.id,
        groupId,
        playerId: row.player_id,
        admin: !!(row.is_admin || row.everyone_admin),
        editPolicy: row.edit_policy,
    };
}

function requireAdmin(me) {
    if (!me.admin) throw forbidden();
}

function canEditRound(me, round) {
    return me.editPolicy === 'anyone' || me.admin || round.created_by === me.id;
}

// ---- loading ----------------------------------------------------------------

async function loadGame(env, me, gameId) {
    const game = await env.DB.prepare('SELECT * FROM games WHERE id = ? AND group_id = ?')
        .bind(gameId, me.groupId).first();
    if (!game) throw notFound();
    return game;
}

async function loadRound(env, me, roundId) {
    const round = await env.DB.prepare(
        `SELECT r.* FROM rounds r JOIN games g ON g.id = r.game_id WHERE r.id = ? AND g.group_id = ?`,
    ).bind(roundId, me.groupId).first();
    if (!round) throw notFound();
    return round;
}

function gameOut(g) {
    return { id: g.id, name: g.name, teamA: g.team_a, teamB: g.team_b, archived: !!g.archived, createdAt: g.created_at };
}

function tournamentOut(t) {
    return { id: t.id, gameId: t.game_id, name: t.name, createdAt: t.created_at, endedAt: t.ended_at };
}

// rounds: rows from `rounds`; fills in players from round_players.
async function roundsOut(env, me, rounds) {
    if (!rounds.length) return [];
    const { results } = await env.DB.prepare(
        `SELECT rp.* FROM round_players rp JOIN json_each(?) j ON rp.round_id = j.value`,
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
        canEdit: canEditRound(me, r),
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
    const { results } = await env.DB.prepare(
        `SELECT p.id FROM players p JOIN json_each(?) j ON p.id = j.value WHERE p.group_id = ?`,
    ).bind(JSON.stringify([...seen]), me.groupId).all();
    if (results.length !== seen.size) throw bad('unknown player');
    return teams.map((t) => [...t]);
}

async function checkTournament(env, gameId, tournamentId) {
    if (!tournamentId) return null;
    const t = await env.DB.prepare('SELECT id FROM tournaments WHERE id = ? AND game_id = ?')
        .bind(tournamentId, gameId).first();
    if (!t) throw bad('unknown tournament');
    return t.id;
}

const ratingRowsSql = `INSERT INTO ratings (game_id, player_id, mu, sigma, rounds, wins, last_played)
    SELECT ?1, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
           json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]')
    FROM json_each(?2) j WHERE true
    ON CONFLICT (game_id, player_id) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma,
        rounds = excluded.rounds, wins = excluded.wins, last_played = excluded.last_played`;

const roundPlayersSql = `INSERT INTO round_players (round_id, player_id, team, mu_before, sigma_before, mu_after, sigma_after)
    SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
           json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'), json_extract(j.value, '$[6]')
    FROM json_each(?1) j WHERE true
    ON CONFLICT (round_id, player_id) DO UPDATE SET team = excluded.team,
        mu_before = excluded.mu_before, sigma_before = excluded.sigma_before,
        mu_after = excluded.mu_after, sigma_after = excluded.sigma_after`;

function chunks(items, size = 1500) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

// Recomputes every rating in a game from its full history and rewrites only
// the rows that changed. Used after edits, deletes and restores; new rounds
// are applied incrementally instead.
async function replayGame(env, gameId) {
    const { results } = await env.DB.prepare(
        `SELECT r.id, r.played_at, r.winner, rp.player_id, rp.team,
                rp.mu_before, rp.sigma_before, rp.mu_after, rp.sigma_after
         FROM rounds r JOIN round_players rp ON rp.round_id = r.id
         WHERE r.game_id = ? AND r.deleted_at IS NULL
         ORDER BY r.played_at, r.id`,
    ).bind(gameId).all();
    const rounds = [];
    const stored = new Map();
    for (const row of results) {
        let round = rounds[rounds.length - 1];
        if (!round || round.id !== row.id) {
            round = { id: row.id, playedAt: row.played_at, winner: row.winner, teams: [[], []] };
            rounds.push(round);
        }
        round.teams[row.team].push(row.player_id);
        stored.set(`${row.id}|${row.player_id}`, row);
    }
    const { ratings, changes } = replay(rounds);
    const same = (a, b) => a !== null && Math.abs(a - b) < 1e-9;
    const changed = [];
    for (const round of rounds) {
        for (const [playerId, c] of changes.get(round.id)) {
            const s = stored.get(`${round.id}|${playerId}`);
            if (same(s.mu_before, c.before.mu) && same(s.sigma_before, c.before.sigma)
                && same(s.mu_after, c.after.mu) && same(s.sigma_after, c.after.sigma)) continue;
            changed.push([round.id, playerId, s.team, c.before.mu, c.before.sigma, c.after.mu, c.after.sigma]);
        }
    }
    const lastPlayed = new Map();
    for (const round of rounds) for (const id of round.teams.flat()) lastPlayed.set(id, round.playedAt);
    const ratingRows = [...ratings].map(([id, r]) => [id, r.mu, r.sigma, r.rounds, r.wins, lastPlayed.get(id)]);

    const statements = [env.DB.prepare('DELETE FROM ratings WHERE game_id = ?').bind(gameId)];
    for (const chunk of chunks(ratingRows)) statements.push(env.DB.prepare(ratingRowsSql).bind(gameId, JSON.stringify(chunk)));
    for (const chunk of chunks(changed)) statements.push(env.DB.prepare(roundPlayersSql).bind(JSON.stringify(chunk)));
    await env.DB.batch(statements);
}

// ---- handlers ---------------------------------------------------------------

async function createGroup(env, request) {
    await rateLimit(env, request);
    const input = await body(request);
    const name = cleanName(input.name, 'group name');
    const now = Date.now();
    const groupId = newId();
    const deviceId = newId();
    const token = newToken();
    const code = newCode();
    const statements = [
        env.DB.prepare('INSERT INTO groups (id, name, invite_code, created_at) VALUES (?, ?, ?, ?)')
            .bind(groupId, name, code, now),
    ];
    let playerId = null;
    if (input.playerName) {
        playerId = newId();
        statements.push(env.DB.prepare('INSERT INTO players (id, group_id, name, created_at) VALUES (?, ?, ?, ?)')
            .bind(playerId, groupId, cleanName(input.playerName, 'player name'), now));
    }
    statements.push(env.DB.prepare(
        'INSERT INTO devices (id, token_hash, group_id, player_id, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ).bind(deviceId, await sha256(token), groupId, playerId, now));
    if (input.gameName) {
        statements.push(env.DB.prepare('INSERT INTO games (id, group_id, name, created_at) VALUES (?, ?, ?, ?)')
            .bind(newId(), groupId, cleanName(input.gameName, 'game name'), now));
    }
    await env.DB.batch(statements);
    return json({ token, groupId, name }, 201);
}

async function joinGroup(env, request) {
    await rateLimit(env, request);
    const input = await body(request);
    const code = normalizeCode(input.code);
    if (code.length !== 8) throw new HttpError(404, 'unknown code');
    const group = await env.DB.prepare('SELECT id, name FROM groups WHERE invite_code = ?').bind(code).first();
    if (!group) throw new HttpError(404, 'unknown code');
    const token = newToken();
    await env.DB.prepare('INSERT INTO devices (id, token_hash, group_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(newId(), await sha256(token), group.id, Date.now()).run();
    return json({ token, groupId: group.id, name: group.name }, 201);
}

async function getGroup(env, me) {
    const [group, players, games] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(me.groupId),
        env.DB.prepare('SELECT * FROM players WHERE group_id = ? ORDER BY name COLLATE NOCASE').bind(me.groupId),
        env.DB.prepare('SELECT * FROM games WHERE group_id = ? ORDER BY created_at').bind(me.groupId),
    ]);
    const g = group.results[0];
    return json({
        group: {
            id: g.id,
            name: g.name,
            inviteCode: formatCode(g.invite_code),
            everyoneAdmin: !!g.everyone_admin,
            editPolicy: g.edit_policy,
            createdAt: g.created_at,
        },
        me: { deviceId: me.id, playerId: me.playerId, admin: me.admin },
        players: players.results.map((p) => ({ id: p.id, name: p.name, archived: !!p.archived })),
        games: games.results.map(gameOut),
    });
}

async function updateGroup(env, me, request) {
    requireAdmin(me);
    const input = await body(request);
    const sets = [];
    const args = [];
    if (input.name !== undefined) { sets.push('name = ?'); args.push(cleanName(input.name, 'group name')); }
    if (input.everyoneAdmin !== undefined) { sets.push('everyone_admin = ?'); args.push(input.everyoneAdmin ? 1 : 0); }
    if (input.editPolicy !== undefined) {
        if (!['anyone', 'admin'].includes(input.editPolicy)) throw bad('invalid edit policy');
        sets.push('edit_policy = ?');
        args.push(input.editPolicy);
    }
    if (input.everyoneAdmin === false) {
        // Turning it off must not lock everyone out: whoever does it stays admin.
        await env.DB.prepare('UPDATE devices SET is_admin = 1 WHERE id = ?').bind(me.id).run();
    }
    if (sets.length) await env.DB.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).bind(...args, me.groupId).run();
    return json({ ok: true });
}

async function rotateInvite(env, me) {
    requireAdmin(me);
    const code = newCode();
    await env.DB.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').bind(code, me.groupId).run();
    return json({ inviteCode: formatCode(code) });
}

async function deleteGroup(env, me) {
    requireAdmin(me);
    await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(me.groupId).run();
    return json({ ok: true });
}

async function listDevices(env, me) {
    requireAdmin(me);
    const { results } = await env.DB.prepare(
        'SELECT id, player_id, is_admin, created_at FROM devices WHERE group_id = ? ORDER BY created_at',
    ).bind(me.groupId).all();
    return json({
        devices: results.map((d) => ({ id: d.id, playerId: d.player_id, admin: !!d.is_admin, createdAt: d.created_at, me: d.id === me.id })),
    });
}

async function updateDevice(env, me, deviceId, request) {
    requireAdmin(me);
    const input = await body(request);
    await env.DB.prepare('UPDATE devices SET is_admin = ? WHERE id = ? AND group_id = ?')
        .bind(input.admin ? 1 : 0, deviceId, me.groupId).run();
    return json({ ok: true });
}

// Admins can remove any device; anyone can remove (leave with) their own.
async function deleteDevice(env, me, deviceId) {
    if (deviceId !== me.id) requireAdmin(me);
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

async function createPlayer(env, me, request) {
    const input = await body(request);
    const name = cleanName(input.name, 'player name');
    const taken = await env.DB.prepare('SELECT id FROM players WHERE group_id = ? AND name = ? COLLATE NOCASE')
        .bind(me.groupId, name).first();
    if (taken) throw new HttpError(409, 'name taken');
    const id = newId();
    const statements = [env.DB.prepare('INSERT INTO players (id, group_id, name, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, me.groupId, name, Date.now())];
    if (input.me) statements.push(env.DB.prepare('UPDATE devices SET player_id = ? WHERE id = ?').bind(id, me.id));
    await env.DB.batch(statements);
    return json({ id, name, archived: false }, 201);
}

async function updatePlayer(env, me, playerId, request) {
    if (playerId !== me.playerId) requireAdmin(me);
    const input = await body(request);
    const sets = [];
    const args = [];
    if (input.name !== undefined) {
        const name = cleanName(input.name, 'player name');
        const taken = await env.DB.prepare('SELECT id FROM players WHERE group_id = ? AND name = ? COLLATE NOCASE AND id != ?')
            .bind(me.groupId, name, playerId).first();
        if (taken) throw new HttpError(409, 'name taken');
        sets.push('name = ?');
        args.push(name);
    }
    if (input.archived !== undefined) { sets.push('archived = ?'); args.push(input.archived ? 1 : 0); }
    if (sets.length) {
        await env.DB.prepare(`UPDATE players SET ${sets.join(', ')} WHERE id = ? AND group_id = ?`)
            .bind(...args, playerId, me.groupId).run();
    }
    return json({ ok: true });
}

async function createGame(env, me, request) {
    const input = await body(request);
    const id = newId();
    const row = {
        id,
        group_id: me.groupId,
        name: cleanName(input.name, 'game name'),
        team_a: input.teamA ? cleanName(input.teamA, 'team name') : 'Blue',
        team_b: input.teamB ? cleanName(input.teamB, 'team name') : 'Orange',
        archived: 0,
        created_at: Date.now(),
    };
    await env.DB.prepare('INSERT INTO games (id, group_id, name, team_a, team_b, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.group_id, row.name, row.team_a, row.team_b, row.created_at).run();
    return json(gameOut(row), 201);
}

async function updateGame(env, me, gameId, request) {
    requireAdmin(me);
    await loadGame(env, me, gameId);
    const input = await body(request);
    const sets = [];
    const args = [];
    if (input.name !== undefined) { sets.push('name = ?'); args.push(cleanName(input.name, 'game name')); }
    if (input.teamA !== undefined) { sets.push('team_a = ?'); args.push(cleanName(input.teamA, 'team name')); }
    if (input.teamB !== undefined) { sets.push('team_b = ?'); args.push(cleanName(input.teamB, 'team name')); }
    if (input.archived !== undefined) { sets.push('archived = ?'); args.push(input.archived ? 1 : 0); }
    if (sets.length) await env.DB.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`).bind(...args, gameId).run();
    if (input.recalculate) await replayGame(env, gameId);
    return json({ ok: true });
}

// Leaderboard, tournaments and recent rounds in one call. `since` (ms) is the
// start of "today" in the viewer's time zone; rounds since then are always
// included so the client can show today's changes.
async function getGame(env, me, gameId, url) {
    const game = await loadGame(env, me, gameId);
    const since = Number(url.searchParams.get('since')) || Date.now() - 86400000;
    const [ratings, tournaments, rounds] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM ratings WHERE game_id = ?').bind(gameId),
        env.DB.prepare('SELECT * FROM tournaments WHERE game_id = ? ORDER BY created_at DESC').bind(gameId),
        env.DB.prepare(
            `SELECT * FROM rounds WHERE game_id = ? AND deleted_at IS NULL AND played_at >= ?
             UNION SELECT * FROM (SELECT * FROM rounds WHERE game_id = ? AND deleted_at IS NULL ORDER BY played_at DESC LIMIT 20)
             ORDER BY played_at DESC LIMIT 200`,
        ).bind(gameId, since, gameId),
    ]);
    return json({
        game: gameOut(game),
        ratings: ratings.results.map((r) => ({
            playerId: r.player_id, mu: r.mu, sigma: r.sigma, rounds: r.rounds, wins: r.wins, lastPlayed: r.last_played,
        })),
        tournaments: tournaments.results.map(tournamentOut),
        rounds: await roundsOut(env, me, rounds.results),
    });
}

// Paged history, newest first. Filters: before (ms), tournament, player.
async function listRounds(env, me, gameId, url) {
    await loadGame(env, me, gameId);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const tournament = url.searchParams.get('tournament');
    const player = url.searchParams.get('player');
    const limit = Math.min(Number(url.searchParams.get('limit')) || ROUNDS_PAGE, 1000);
    let sql = 'SELECT r.* FROM rounds r';
    const args = [];
    if (player) { sql += ' JOIN round_players rp ON rp.round_id = r.id AND rp.player_id = ?'; args.push(player); }
    sql += ' WHERE r.game_id = ? AND r.deleted_at IS NULL AND r.played_at < ?';
    args.push(gameId, before);
    if (tournament) { sql += ' AND r.tournament_id = ?'; args.push(tournament); }
    sql += ' ORDER BY r.played_at DESC LIMIT ?';
    args.push(limit + 1);
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ rounds: await roundsOut(env, me, results.slice(0, limit)), more: results.length > limit });
}

async function createRound(env, me, gameId, request) {
    await loadGame(env, me, gameId);
    const input = await body(request);
    const teams = await checkTeams(env, me, input.teams);
    if (input.winner !== 0 && input.winner !== 1) throw bad('winner required');
    const tournamentId = await checkTournament(env, gameId, input.tournamentId);
    const ids = teams.flat();
    const { results: current } = await env.DB.prepare(
        `SELECT r.* FROM ratings r JOIN json_each(?) j ON r.player_id = j.value WHERE r.game_id = ?`,
    ).bind(JSON.stringify(ids), gameId).all();
    const ratings = new Map(current.map((r) => [r.player_id, { mu: r.mu, sigma: r.sigma, rounds: r.rounds, wins: r.wins }]));
    const roundId = newId();
    const now = Date.now();
    const change = applyRound(ratings, { id: roundId, teams, winner: input.winner });
    const rpRows = teams.flatMap((team, t) => team.map((id) => {
        const c = change.get(id);
        return [roundId, id, t, c.before.mu, c.before.sigma, c.after.mu, c.after.sigma];
    }));
    const ratingRows = ids.map((id) => {
        const r = ratings.get(id);
        return [id, r.mu, r.sigma, r.rounds, r.wins, now];
    });
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO rounds (id, game_id, tournament_id, played_at, winner, score_a, score_b, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(roundId, gameId, tournamentId, now, input.winner, optionalScore(input.scoreA), optionalScore(input.scoreB), me.id),
        env.DB.prepare(roundPlayersSql).bind(JSON.stringify(rpRows)),
        env.DB.prepare(ratingRowsSql).bind(gameId, JSON.stringify(ratingRows)),
    ]);
    const round = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?').bind(roundId).first();
    return json((await roundsOut(env, me, [round]))[0], 201);
}

// Changing a round that is still the newest round of everyone in it (wrong
// winner, undo, restore) doesn't need a full replay: undo its effect from the
// stored "before" values and apply the new version. Full replays of long
// histories can exceed the free plan's 10 ms CPU limit, so this is the path
// everyday corrections take. Returns statements, or null when some player has
// a later round (the caller then replays the game).
async function latestRoundStatements(env, round, oldRows, next) {
    const ids = [...new Set([...oldRows.map((p) => p.player_id), ...(next ? next.teams.flat() : [])])];
    const later = await env.DB.prepare(
        `SELECT 1 FROM round_players rp JOIN rounds r ON r.id = rp.round_id
         WHERE rp.player_id IN (SELECT value FROM json_each(?1)) AND r.game_id = ?2 AND r.deleted_at IS NULL
           AND r.id != ?3 AND (r.played_at > ?4 OR (r.played_at = ?4 AND r.id > ?3))
         LIMIT 1`,
    ).bind(JSON.stringify(ids), round.game_id, round.id, round.played_at).first();
    if (later) return null;
    const { results } = await env.DB.prepare(
        'SELECT * FROM ratings WHERE game_id = ? AND player_id IN (SELECT value FROM json_each(?))',
    ).bind(round.game_id, JSON.stringify(ids)).all();
    const ratings = new Map(results.map((r) => [r.player_id, { mu: r.mu, sigma: r.sigma, rounds: r.rounds, wins: r.wins }]));
    for (const p of oldRows) {
        const cur = ratings.get(p.player_id);
        if (!cur || p.mu_before === null) return null;
        const rounds = cur.rounds - 1;
        if (rounds <= 0) ratings.delete(p.player_id);
        else ratings.set(p.player_id, { mu: p.mu_before, sigma: p.sigma_before, rounds, wins: cur.wins - (p.team === round.winner ? 1 : 0) });
    }
    const statements = [];
    if (next) {
        const change = applyRound(ratings, { id: round.id, teams: next.teams, winner: next.winner });
        const rows = next.teams.flatMap((team, t) => team.map((id) => {
            const c = change.get(id);
            return [round.id, id, t, c.before.mu, c.before.sigma, c.after.mu, c.after.sigma];
        }));
        statements.push(env.DB.prepare('DELETE FROM round_players WHERE round_id = ?').bind(round.id));
        statements.push(env.DB.prepare(roundPlayersSql).bind(JSON.stringify(rows)));
    }
    const gone = ids.filter((id) => !ratings.has(id));
    const rows = [...ratings].map(([id, r]) => [id, r.mu, r.sigma, r.rounds, r.wins, round.played_at]);
    if (gone.length) {
        statements.push(env.DB.prepare('DELETE FROM ratings WHERE game_id = ? AND player_id IN (SELECT value FROM json_each(?))')
            .bind(round.game_id, JSON.stringify(gone)));
    }
    if (rows.length) statements.push(env.DB.prepare(ratingRowsSql).bind(round.game_id, JSON.stringify(rows)));
    return statements;
}

async function roundPlayerRows(env, roundId) {
    const { results } = await env.DB.prepare('SELECT * FROM round_players WHERE round_id = ?').bind(roundId).all();
    return results;
}

async function updateRound(env, me, roundId, request) {
    const round = await loadRound(env, me, roundId);
    if (!canEditRound(me, round)) throw forbidden();
    const input = await body(request);
    const sets = [];
    const args = [];
    if (input.winner !== undefined && input.winner !== 0 && input.winner !== 1) throw bad('invalid winner');
    if (input.scoreA !== undefined) { sets.push('score_a = ?'); args.push(optionalScore(input.scoreA)); }
    if (input.scoreB !== undefined) { sets.push('score_b = ?'); args.push(optionalScore(input.scoreB)); }
    if (input.tournamentId !== undefined) {
        sets.push('tournament_id = ?');
        args.push(await checkTournament(env, round.game_id, input.tournamentId));
    }
    const oldRows = await roundPlayerRows(env, roundId);
    const winner = input.winner ?? round.winner;
    const teams = input.teams !== undefined
        ? await checkTeams(env, me, input.teams)
        : [0, 1].map((t) => oldRows.filter((p) => p.team === t).map((p) => p.player_id));
    const sameTeams = JSON.stringify(teams.map((t) => [...t].sort()))
        === JSON.stringify([0, 1].map((t) => oldRows.filter((p) => p.team === t).map((p) => p.player_id).sort()));
    const ratingChange = winner !== round.winner || !sameTeams;
    if (winner !== round.winner) { sets.push('winner = ?'); args.push(winner); }

    const statements = [];
    if (sets.length) statements.push(env.DB.prepare(`UPDATE rounds SET ${sets.join(', ')} WHERE id = ?`).bind(...args, roundId));
    let replayNeeded = false;
    if (ratingChange && !round.deleted_at) {
        const fast = await latestRoundStatements(env, round, oldRows, { teams, winner });
        if (fast) statements.push(...fast);
        else replayNeeded = true;
    }
    if (ratingChange && (round.deleted_at || replayNeeded) && !sameTeams) {
        statements.push(env.DB.prepare('DELETE FROM round_players WHERE round_id = ?').bind(roundId));
        const rows = teams.flatMap((team, t) => team.map((id) => [roundId, id, t, null, null, null, null]));
        statements.push(env.DB.prepare(roundPlayersSql).bind(JSON.stringify(rows)));
    }
    if (statements.length) await env.DB.batch(statements);
    if (replayNeeded) await replayGame(env, round.game_id);
    const updated = await env.DB.prepare('SELECT * FROM rounds WHERE id = ?').bind(roundId).first();
    return json((await roundsOut(env, me, [updated]))[0]);
}

async function setRoundDeleted(env, me, roundId, deleted) {
    const round = await loadRound(env, me, roundId);
    if (!canEditRound(me, round)) throw forbidden();
    if (!!round.deleted_at === deleted) return json({ ok: true });
    const rows = await roundPlayerRows(env, roundId);
    const fast = deleted
        ? await latestRoundStatements(env, round, rows, null)
        : await latestRoundStatements(env, round, [], {
            teams: [0, 1].map((t) => rows.filter((p) => p.team === t).map((p) => p.player_id)),
            winner: round.winner,
        });
    await env.DB.batch([
        env.DB.prepare('UPDATE rounds SET deleted_at = ? WHERE id = ?').bind(deleted ? Date.now() : null, roundId),
        ...(fast || []),
    ]);
    if (!fast) await replayGame(env, round.game_id);
    return json({ ok: true });
}

async function createTournament(env, me, gameId, request) {
    await loadGame(env, me, gameId);
    const input = await body(request);
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
    if (input.delete) {
        requireAdmin(me);
        await env.DB.prepare('DELETE FROM tournaments WHERE id = ?').bind(tournamentId).run();
        return json({ ok: true });
    }
    if (sets.length) await env.DB.prepare(`UPDATE tournaments SET ${sets.join(', ')} WHERE id = ?`).bind(...args, tournamentId).run();
    return json({ ok: true });
}

// ---- routing ----------------------------------------------------------------

const routes = [
    ['POST', /^\/api\/groups$/, (env, req) => createGroup(env, req)],
    ['POST', /^\/api\/join$/, (env, req) => joinGroup(env, req)],
    ['GET', /^\/api\/g\/([\w]+)$/, (env, req, me) => getGroup(env, me), true],
    ['PATCH', /^\/api\/g\/([\w]+)$/, (env, req, me) => updateGroup(env, me, req), true],
    ['DELETE', /^\/api\/g\/([\w]+)$/, (env, req, me) => deleteGroup(env, me), true],
    ['POST', /^\/api\/g\/([\w]+)\/invite$/, (env, req, me) => rotateInvite(env, me), true],
    ['PUT', /^\/api\/g\/([\w]+)\/me$/, (env, req, me) => setMe(env, me, req), true],
    ['GET', /^\/api\/g\/([\w]+)\/devices$/, (env, req, me) => listDevices(env, me), true],
    ['PATCH', /^\/api\/g\/([\w]+)\/devices\/([\w]+)$/, (env, req, me, m) => updateDevice(env, me, m[2], req), true],
    ['DELETE', /^\/api\/g\/([\w]+)\/devices\/([\w]+)$/, (env, req, me, m) => deleteDevice(env, me, m[2]), true],
    ['POST', /^\/api\/g\/([\w]+)\/players$/, (env, req, me) => createPlayer(env, me, req), true],
    ['PATCH', /^\/api\/g\/([\w]+)\/players\/([\w]+)$/, (env, req, me, m) => updatePlayer(env, me, m[2], req), true],
    ['POST', /^\/api\/g\/([\w]+)\/games$/, (env, req, me) => createGame(env, me, req), true],
    ['GET', /^\/api\/g\/([\w]+)\/games\/([\w]+)$/, (env, req, me, m, url) => getGame(env, me, m[2], url), true],
    ['PATCH', /^\/api\/g\/([\w]+)\/games\/([\w]+)$/, (env, req, me, m) => updateGame(env, me, m[2], req), true],
    ['GET', /^\/api\/g\/([\w]+)\/games\/([\w]+)\/rounds$/, (env, req, me, m, url) => listRounds(env, me, m[2], url), true],
    ['POST', /^\/api\/g\/([\w]+)\/games\/([\w]+)\/rounds$/, (env, req, me, m) => createRound(env, me, m[2], req), true],
    ['POST', /^\/api\/g\/([\w]+)\/games\/([\w]+)\/tournaments$/, (env, req, me, m) => createTournament(env, me, m[2], req), true],
    ['PATCH', /^\/api\/g\/([\w]+)\/tournaments\/([\w]+)$/, (env, req, me, m) => updateTournament(env, me, m[2], req), true],
    ['PATCH', /^\/api\/g\/([\w]+)\/rounds\/([\w]+)$/, (env, req, me, m) => updateRound(env, me, m[2], req), true],
    ['DELETE', /^\/api\/g\/([\w]+)\/rounds\/([\w]+)$/, (env, req, me, m) => setRoundDeleted(env, me, m[2], true), true],
    ['POST', /^\/api\/g\/([\w]+)\/rounds\/([\w]+)\/restore$/, (env, req, me, m) => setRoundDeleted(env, me, m[2], false), true],
];

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        try {
            for (const [method, pattern, handler, needsAuth] of routes) {
                const m = url.pathname.match(pattern);
                if (!m) continue;
                if (request.method !== method) continue;
                const me = needsAuth ? await authenticate(env, request, m[1]) : null;
                return await handler(env, request, me, m, url);
            }
            throw notFound();
        } catch (err) {
            if (err instanceof HttpError) return json({ error: err.message }, err.status);
            console.error(err);
            return json({ error: 'internal error' }, 500);
        }
    },
};
