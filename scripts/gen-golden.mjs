// Regenerates internal/rating/testdata/golden.json from the reference model
// (test/reference/rating.js). Both the Go package and web/rating.js are tested
// against it. Run: node scripts/gen-golden.mjs
import { writeFileSync } from 'node:fs';
import { applyRound, displayRating, displayDelta, winProbability, newRating } from '../test/reference/rating.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const obj = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v]));
const r6 = (x) => x;

function sequence(name, rounds) {
    const ratings = new Map();
    const handicaps = new Map();
    const out = [];
    for (const round of rounds) {
        const res = applyRound(ratings, handicaps, round);
        out.push({
            players: obj(res.players),
            format: res.format || '',
            handicap: res.handicap,
        });
    }
    return {
        name, rounds, results: out,
        ratings: obj(ratings), handicaps: obj(handicaps),
    };
}

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const random = (n, formats) => Array.from({ length: n }, () => {
    const s = [...ids].sort(() => rnd() - 0.5);
    const [x, y] = formats[Math.floor(rnd() * formats.length)];
    return { teams: [s.slice(0, x), s.slice(x, x + y)], winner: rnd() < 0.5 ? 0 : 1 };
});

const sequences = [
    sequence('1v1 only', random(80, [[1, 1]])),
    sequence('even teams', random(80, [[1, 1], [2, 2], [3, 3]])),
    sequence('mixed formats', random(250, [[1, 1], [2, 2], [3, 3], [2, 1], [1, 2], [3, 2], [2, 3], [3, 1]])),
    sequence('one player always wins', Array.from({ length: 40 }, (_, i) => ({ teams: [['ace'], ['x' + (i % 4)]], winner: 0 }))),
    sequence('solo against pairs', Array.from({ length: 30 }, (_, i) => ({ teams: [['solo'], ['p', 'q']], winner: i % 3 === 0 ? 0 : 1 }))),
];

const odds = [];
for (let i = 0; i < 120; i++) {
    const size = () => 1 + Math.floor(rnd() * 3);
    const team = (n) => Array.from({ length: n }, () => ({ mu: 15 + rnd() * 20, sigma: 1 + rnd() * 5 }));
    const a = team(size());
    const b = team(size());
    const handicaps = new Map();
    if (rnd() < 0.7) for (const f of ['2v1', '3v1', '3v2']) handicaps.set(f, { mu: rnd() * 10, sigma: 0.5 + rnd() * 4 });
    odds.push({ a, b, handicaps: obj(handicaps), p: winProbability(a, b, handicaps) });
}

const display = Array.from({ length: 60 }, () => {
    const before = { mu: 5 + rnd() * 40, sigma: 0.5 + rnd() * 7 };
    const after = { mu: before.mu + (rnd() - 0.5) * 6, sigma: Math.max(0.4, before.sigma - rnd()) };
    return { before, after, display: displayRating(after), delta: displayDelta(before, after) };
});
display.push({ before: newRating(), after: newRating(), display: 1000, delta: 0 });

writeFileSync(new URL('../internal/rating/testdata/golden.json', import.meta.url), JSON.stringify({ sequences, odds, display }) + '\n');
console.log('golden.json:', sequences.length, 'sequences,', odds.length, 'odds cases,', display.length, 'display cases');
