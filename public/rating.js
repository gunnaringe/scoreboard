// Weng-Lin rating (Bradley-Terry, full pairing), the open TrueSkill-style
// model behind OpenSkill. Weng & Lin, "A Bayesian Approximation Method for
// Online Ranking", JMLR 12 (2011), Algorithm 1.
//
// Each player has a skill estimate mu and an uncertainty sigma; each player's
// share of an update is scaled by their own variance, so new players move fast
// and established players stay stable.
//
// Tuned for a small office group after simulating seasons (see CLAUDE.md):
// - Team strength is the sum of (mu - MU), so team size alone is worth
//   nothing; instead each uneven format ("2v1", "3v2") has its own learned
//   handicap, a pseudo-player on the bigger team updated by the same rule.
//   Summing raw mu made 2 average players 98 % favourites over 1 and let the
//   solo player in 2v1s farm rating.
// - Starting sigma 6 (not 25/3) and display mu - sigma (not mu - 3 sigma), so
//   the number tracks skill rather than how many rounds you have played.
//
// Shared by the Worker (src/) and the browser; keep it dependency-free and
// deterministic — incremental updates and full replay must agree.

export const MU = 25;
export const SIGMA = 6;
export const BETA = 25 / 6;
export const KAPPA = 0.0001;
// Added to every variance before each round, so ratings never freeze (OpenSkill's default tau).
export const TAU = MU / 300;
export const PROVISIONAL_ROUNDS = 10;
// Prior for a format's handicap: the bigger team wins roughly 70 % between equals.
export const HANDICAP_MU = 6;
export const HANDICAP_SIGMA = 4;
// Display points per unit of mu.
export const SCALE = 25;

export function newRating() {
    return { mu: MU, sigma: SIGMA };
}

export function newHandicap() {
    return { mu: HANDICAP_MU, sigma: HANDICAP_SIGMA };
}

// Elo-looking number: 1000 for a brand-new player.
export function displayRating(r) {
    return Math.round(1000 + SCALE * (r.mu - r.sigma - (MU - SIGMA)));
}

// Change shown for one round: how far the skill estimate moved.
export function displayDelta(before, after) {
    return Math.round(SCALE * (after.mu - before.mu));
}

// "2v1" for uneven team sizes, null for even ones. The handicap belongs to the bigger team.
export function formatOf(sizes) {
    const [a, b] = sizes;
    return a === b ? null : `${Math.max(a, b)}v${Math.min(a, b)}`;
}

// Members are { mu, sigma, base }: a member adds (mu - base) to its team's
// strength. Players have base MU; the handicap pseudo-player has base 0.
function teamStats(team) {
    let mu = 0;
    let s2 = 0;
    for (const p of team) {
        mu += p.mu - (p.base ?? MU);
        s2 += p.sigma * p.sigma;
    }
    return { mu, s2 };
}

// teams: arrays of { mu, sigma, base? }. ranks: lower is better, equal ranks
// draw. Returns new { mu, sigma } in the same shape.
export function rate(teams, ranks) {
    const decayed = teams.map((team) => team.map((p) => ({
        mu: p.mu,
        sigma: Math.sqrt(p.sigma * p.sigma + TAU * TAU),
        base: p.base,
    })));
    const stats = decayed.map(teamStats);
    return decayed.map((team, i) => {
        let omega = 0;
        let delta = 0;
        for (let q = 0; q < decayed.length; q++) {
            if (q === i) continue;
            const c = Math.sqrt(stats[i].s2 + stats[q].s2 + 2 * BETA * BETA);
            const p = 1 / (1 + Math.exp((stats[q].mu - stats[i].mu) / c));
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

// Adds the format's handicap to the bigger team. Returns { teams, format, side }.
function withHandicap(teams, handicaps) {
    const format = formatOf(teams.map((t) => t.length));
    if (!format) return { teams, format: null, side: -1 };
    const side = teams[0].length > teams[1].length ? 0 : 1;
    const h = handicaps?.get(format) || newHandicap();
    const out = teams.map((t, i) => (i === side ? [...t, { mu: h.mu, sigma: h.sigma, base: 0 }] : t));
    return { teams: out, format, side };
}

// Probability that team a beats team b. handicaps: Map(format -> {mu, sigma}).
export function winProbability(a, b, handicaps) {
    const { teams } = withHandicap([a, b], handicaps);
    const sa = teamStats(teams[0]);
    const sb = teamStats(teams[1]);
    const c = Math.sqrt(sa.s2 + sb.s2 + 2 * BETA * BETA);
    return 1 / (1 + Math.exp((sb.mu - sa.mu) / c));
}

// Applies one two-team round to `ratings` (Map playerId -> {mu, sigma}) and
// `handicaps` (Map format -> {mu, sigma}) in place. round: { teams: [[ids],
// [ids]], winner }. Returns { players: Map(id -> {before, after}), format,
// handicap: {before, after} | null }.
export function applyRound(ratings, handicaps, round) {
    const get = (id) => ratings.get(id) || newRating();
    const before = round.teams.map((team) => team.map((id) => ({ ...get(id) })));
    const { teams, format, side } = withHandicap(before, handicaps);
    const after = rate(teams, round.teams.map((_, i) => (i === round.winner ? 0 : 1)));
    const players = new Map();
    round.teams.forEach((team, i) => team.forEach((id, j) => {
        const b = before[i][j];
        const a = after[i][j];
        ratings.set(id, { mu: a.mu, sigma: a.sigma });
        players.set(id, { before: { mu: b.mu, sigma: b.sigma }, after: a });
    }));
    let handicap = null;
    if (format) {
        const h = teams[side][teams[side].length - 1];
        const a = after[side][after[side].length - 1];
        handicaps.set(format, a);
        handicap = { before: { mu: h.mu, sigma: h.sigma }, after: a };
    }
    return { players, format, handicap };
}

// Replays rounds in order from scratch. Returns { ratings, handicaps, results:
// Map(roundId -> applyRound result) }.
export function replay(rounds) {
    const ratings = new Map();
    const handicaps = new Map();
    const results = new Map();
    for (const round of rounds) results.set(round.id, applyRound(ratings, handicaps, round));
    return { ratings, handicaps, results };
}

// Splits players into two teams (sizes differ by at most one) with the closest
// win probability to 50 %. Picks randomly among near-ties so the same group
// doesn't always get the same split. players: [{ id, mu, sigma }].
export function balanceTeams(players, handicaps, random = Math.random) {
    const n = players.length;
    if (n < 2) return null;
    const half = Math.floor(n / 2);
    const options = [];
    // Bitmasks over n players; fix player 0 on team A to skip mirror images.
    for (let mask = 1; mask < 1 << n; mask += 2) {
        let count = 0;
        for (let m = mask; m; m &= m - 1) count++;
        if (count !== half && count !== n - half) continue;
        const a = [];
        const b = [];
        players.forEach((p, i) => (mask & (1 << i) ? a : b).push(p));
        options.push({ a, b, gap: Math.abs(winProbability(a, b, handicaps) - 0.5) });
    }
    const best = Math.min(...options.map((o) => o.gap));
    const close = options.filter((o) => o.gap <= best + 0.03);
    const pick = close[Math.floor(random() * close.length)];
    return random() < 0.5 ? [pick.a, pick.b] : [pick.b, pick.a];
}
