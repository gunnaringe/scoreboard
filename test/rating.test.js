import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MU, SIGMA, HANDICAP_MU, newRating, rate, displayRating, displayDelta, winProbability, replay, applyRound,
    balanceTeams, formatOf,
} from '../public/rating.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const run = (rounds) => replay(rounds.map((r, i) => ({ id: i, ...r })));

test('new players display as 1000', () => {
    assert.equal(displayRating(newRating()), 1000);
});

test('1v1 between equals is symmetric', () => {
    const [[w], [l]] = rate([[newRating()], [newRating()]], [0, 1]);
    close(w.mu - MU, MU - l.mu);
    close(w.sigma, l.sigma);
    assert.ok(w.mu > MU && l.mu < MU);
    assert.ok(w.sigma < SIGMA);
});

test('team members with equal ratings get equal changes', () => {
    const [[a, b], [c, d]] = rate([[newRating(), newRating()], [newRating(), newRating()]], [0, 1]);
    close(a.mu, b.mu);
    close(c.mu, d.mu);
    close(a.mu - MU, MU - c.mu);
    void d;
});

test('equal-size teams ignore the base offset (same as summing raw mu)', () => {
    const t = [[{ mu: 30, sigma: 2 }, { mu: 20, sigma: 3 }], [{ mu: 27, sigma: 4 }, { mu: 22, sigma: 1 }]];
    const [[a]] = rate(t, [0, 1]);
    const [[b]] = rate(t.map((team) => team.map((p) => ({ ...p, mu: p.mu + 5, base: MU + 5 }))), [0, 1]);
    close(a.mu + 5, b.mu);
});

test('uneven formats use the learned handicap, not team size', () => {
    assert.equal(formatOf([2, 1]), '2v1');
    assert.equal(formatOf([2, 3]), '3v2');
    assert.equal(formatOf([2, 2]), null);
    const p = winProbability([newRating(), newRating()], [newRating()], new Map());
    assert.ok(p > 0.5 && p < 0.75, `prior 2v1 odds ${p}`);
    // With no handicap advantage the sizes alone would give 50 %.
    close(winProbability([newRating(), newRating()], [newRating()], new Map([['2v1', { mu: 0, sigma: 0.001 }]])), 0.5, 1e-3);
});

test('the handicap learns from results', () => {
    const { handicaps } = run(Array.from({ length: 60 }, () => ({ teams: [['a', 'b'], ['c']], winner: 1 })));
    assert.ok(handicaps.get('2v1').mu < HANDICAP_MU);
});

test('1v2: the solo player gains more from a win than they lose from a loss', () => {
    const win = applyRound(new Map(), new Map(), { teams: [['solo'], ['x', 'y']], winner: 0 }).players.get('solo');
    const loss = applyRound(new Map(), new Map(), { teams: [['solo'], ['x', 'y']], winner: 1 }).players.get('solo');
    assert.ok(win.after.mu - MU > MU - loss.after.mu);
});

test('upset moves ratings more than an expected result', () => {
    const strong = { mu: 35, sigma: 3 };
    const weak = { mu: 15, sigma: 3 };
    const [[expected]] = rate([[strong], [weak]], [0, 1]);
    const [[upset]] = rate([[weak], [strong]], [0, 1]);
    assert.ok(upset.mu - weak.mu > expected.mu - strong.mu);
});

test('an uncertain newcomer moves more than an established teammate', () => {
    const vet = { mu: 30, sigma: 2 };
    const rookie = newRating();
    const [[v, r]] = rate([[vet, rookie], [newRating(), newRating()]], [0, 1]);
    assert.ok(r.mu - rookie.mu > v.mu - vet.mu);
});

test('first-round swings stay moderate', () => {
    const { players } = applyRound(new Map(), new Map(), { teams: [['a', 'b'], ['c', 'd']], winner: 0 });
    const d = displayDelta(players.get('a').before, players.get('a').after);
    assert.ok(d > 10 && d < 60, `first win delta ${d}`);
});

test('a losing day never shows a gain', () => {
    const ratings = new Map();
    const handicaps = new Map();
    let total = 0;
    for (let i = 0; i < 3; i++) {
        const r = applyRound(ratings, handicaps, { teams: [['new'], ['x' + i]], winner: 1 }).players.get('new');
        total += displayDelta(r.before, r.after);
    }
    assert.ok(total < 0);
});

test('draws are supported', () => {
    const [[a], [b]] = rate([[newRating()], [newRating()]], [0, 0]);
    close(a.mu, MU);
    close(b.mu, MU);
});

test('replay equals incremental updates', () => {
    const rounds = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f'].sort(() => rnd() - 0.5);
        const size = 1 + Math.floor(rnd() * 3);
        const other = size > 1 && rnd() < 0.3 ? size - 1 : size;
        rounds.push({ id: i, teams: [ids.slice(0, size), ids.slice(size, size + other)], winner: rnd() < 0.5 ? 0 : 1 });
    }
    const full = replay(rounds);
    const ratings = new Map();
    const handicaps = new Map();
    for (const r of rounds) applyRound(ratings, handicaps, r);
    for (const [id, r] of full.ratings) {
        close(r.mu, ratings.get(id).mu);
        close(r.sigma, ratings.get(id).sigma);
    }
    for (const [f, h] of full.handicaps) close(h.mu, handicaps.get(f).mu);
});

test('a strong player climbs well above 1000 over many wins', () => {
    const { ratings } = run(Array.from({ length: 40 }, (_, i) => ({ teams: [['ace'], ['x' + (i % 4)]], winner: 0 })));
    assert.ok(displayRating(ratings.get('ace')) > 1200);
});

test('balanceTeams splits evenly and fairly', () => {
    const players = [
        { id: 1, mu: 40, sigma: 2 }, { id: 2, mu: 10, sigma: 2 },
        { id: 3, mu: 26, sigma: 2 }, { id: 4, mu: 24, sigma: 2 },
    ];
    const [a, b] = balanceTeams(players, new Map(), () => 0);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.ok(Math.abs(winProbability(a, b) - 0.5) < 0.05);
    const [x, y] = balanceTeams(players.slice(0, 3), new Map(), () => 0.9);
    assert.equal(x.length + y.length, 3);
});
