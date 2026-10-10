import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MU, SIGMA, newRating, rate, displayRating, winProbability, replay, applyRound, balanceTeams,
} from '../public/rating.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

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
});

test('1v2: the solo player gains more from a win than they lose from a loss', () => {
    const solo = [newRating()];
    const duo = [newRating(), newRating()];
    const [[soloWin]] = rate([solo, duo], [0, 1]);
    const [[soloLoss]] = rate([solo, duo], [1, 0]);
    assert.ok(soloWin.mu - MU > MU - soloLoss.mu);
    assert.ok(winProbability(solo, duo) < 0.5);
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
        const other = size > 1 && rnd() < 0.2 ? size - 1 : size;
        rounds.push({ id: i, teams: [ids.slice(0, size), ids.slice(size, size + other)], winner: rnd() < 0.5 ? 0 : 1 });
    }
    const full = replay(rounds);
    const inc = new Map();
    for (const r of rounds) applyRound(inc, r);
    for (const [id, r] of full.ratings) {
        close(r.mu, inc.get(id).mu);
        close(r.sigma, inc.get(id).sigma);
        assert.equal(r.rounds, inc.get(id).rounds);
    }
    const total = [...full.ratings.values()].reduce((s, r) => s + r.rounds, 0);
    assert.equal(total, rounds.reduce((s, r) => s + r.teams.flat().length, 0));
});

test('a strong player climbs well above 1000 over many wins', () => {
    const ratings = new Map();
    for (let i = 0; i < 40; i++) applyRound(ratings, { id: i, teams: [['ace'], ['x' + (i % 4)]], winner: 0 });
    assert.ok(displayRating(ratings.get('ace')) > 1300);
    assert.equal(ratings.get('ace').wins, 40);
});

test('balanceTeams splits evenly and fairly', () => {
    const players = [
        { id: 1, mu: 40, sigma: 2 }, { id: 2, mu: 10, sigma: 2 },
        { id: 3, mu: 26, sigma: 2 }, { id: 4, mu: 24, sigma: 2 },
    ];
    const [a, b] = balanceTeams(players, () => 0);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.ok(Math.abs(winProbability(a, b) - 0.5) < 0.05);
    const [x, y] = balanceTeams(players.slice(0, 3), () => 0.9);
    assert.equal(x.length + y.length, 3);
});
