// Weng-Lin rating (Bradley-Terry, full pairing), the open TrueSkill-style
// model behind OpenSkill. Weng & Lin, "A Bayesian Approximation Method for
// Online Ranking", JMLR 12 (2011), Algorithm 1.
//
// Each player has a skill estimate mu and an uncertainty sigma. A team's
// strength is the sum of its players' mu, so uneven teams (1v2) are handled
// naturally, and each player's share of the update is scaled by their own
// variance: new players move fast, established players stay stable.
//
// Shared by the Worker (src/) and the browser; keep it dependency-free and
// deterministic — incremental updates and full history replay must agree.

export const MU = 25;
export const SIGMA = MU / 3;
export const BETA = SIGMA / 2;
export const KAPPA = 0.0001;
// Added to every player's variance before each round they play, so ratings
// never freeze completely (OpenSkill's default tau).
export const TAU = MU / 300;
export const PROVISIONAL_ROUNDS = 5;

export function newRating() {
    return { mu: MU, sigma: SIGMA };
}

// Conservative, Elo-looking number: 1000 for a brand new player, rising as the
// system gets confident. 40 points per unit of (mu - 3 sigma).
export function displayRating(r) {
    return Math.round(1000 + 40 * (r.mu - 3 * r.sigma));
}

function teamStats(team) {
    let mu = 0;
    let s2 = 0;
    for (const p of team) {
        mu += p.mu;
        s2 += p.sigma * p.sigma;
    }
    return { mu, s2 };
}

// teams: array of arrays of { mu, sigma }. ranks: same length, lower is better,
// equal ranks are a draw. Returns new arrays of { mu, sigma } in the same shape.
export function rate(teams, ranks) {
    const decayed = teams.map((team) => team.map((p) => ({
        mu: p.mu,
        sigma: Math.sqrt(p.sigma * p.sigma + TAU * TAU),
    })));
    const stats = decayed.map(teamStats);
    return decayed.map((team, i) => {
        let omega = 0;
        let delta = 0;
        for (let q = 0; q < decayed.length; q++) {
            if (q === i) continue;
            const c = Math.sqrt(stats[i].s2 + stats[q].s2 + 2 * BETA * BETA);
            const ei = Math.exp(stats[i].mu / c);
            const eq = Math.exp(stats[q].mu / c);
            const p = ei / (ei + eq);
            const s = ranks[q] > ranks[i] ? 1 : ranks[q] === ranks[i] ? 0.5 : 0;
            omega += (stats[i].s2 / c) * (s - p);
            const gamma = Math.sqrt(stats[i].s2) / c;
            delta += ((gamma * stats[i].s2) / (c * c)) * p * (1 - p);
        }
        return team.map((p) => {
            const share = (p.sigma * p.sigma) / stats[i].s2;
            return {
                mu: p.mu + share * omega,
                sigma: p.sigma * Math.sqrt(Math.max(1 - share * delta, KAPPA)),
            };
        });
    });
}

// Probability that team a beats team b, using the same model as rate().
export function winProbability(a, b) {
    const sa = teamStats(a);
    const sb = teamStats(b);
    const c = Math.sqrt(sa.s2 + sb.s2 + 2 * BETA * BETA);
    const ea = Math.exp(sa.mu / c);
    return ea / (ea + Math.exp(sb.mu / c));
}

// Replays rounds in order. rounds: [{ id, teams: [[playerId...], [playerId...]],
// winner: team index }]. Returns { ratings: Map(playerId -> {mu, sigma, rounds,
// wins}), changes: Map(roundId -> Map(playerId -> {before, after})) }.
export function replay(rounds) {
    const ratings = new Map();
    const changes = new Map();
    for (const round of rounds) {
        const result = applyRound(ratings, round);
        changes.set(round.id, result);
    }
    return { ratings, changes };
}

// Applies one round to a ratings Map in place; returns per-player before/after.
export function applyRound(ratings, round) {
    const get = (id) => ratings.get(id) || { ...newRating(), rounds: 0, wins: 0 };
    const before = round.teams.map((team) => team.map(get));
    const ranks = round.teams.map((_, i) => (i === round.winner ? 0 : 1));
    const after = rate(before, ranks);
    const result = new Map();
    round.teams.forEach((team, i) => team.forEach((id, j) => {
        const b = before[i][j];
        const a = after[i][j];
        ratings.set(id, {
            mu: a.mu,
            sigma: a.sigma,
            rounds: b.rounds + 1,
            wins: b.wins + (i === round.winner ? 1 : 0),
        });
        result.set(id, { before: { mu: b.mu, sigma: b.sigma }, after: a });
    }));
    return result;
}

// Splits players into two teams (sizes differ by at most one) with the closest
// win probability to 50 %. Picks randomly among near-ties so the same group
// doesn't always get the same split. players: [{ id, mu, sigma }].
export function balanceTeams(players, random = Math.random) {
    const n = players.length;
    if (n < 2) return null;
    const half = Math.floor(n / 2);
    const options = [];
    // Bitmasks over n players; fix player 0 on team A to skip mirror images.
    for (let mask = 0; mask < 1 << n; mask++) {
        if (!(mask & 1)) continue;
        let count = 0;
        for (let m = mask; m; m &= m - 1) count++;
        if (count !== half && count !== n - half) continue;
        const a = [];
        const b = [];
        players.forEach((p, i) => (mask & (1 << i) ? a : b).push(p));
        options.push({ a, b, gap: Math.abs(winProbability(a, b) - 0.5) });
    }
    const best = Math.min(...options.map((o) => o.gap));
    const close = options.filter((o) => o.gap <= best + 0.03);
    const pick = close[Math.floor(random() * close.length)];
    return random() < 0.5 ? [pick.a, pick.b] : [pick.b, pick.a];
}
