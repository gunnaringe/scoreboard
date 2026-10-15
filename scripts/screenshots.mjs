// README screenshots: starts the real binary with a made-up office (imported
// through the admin CLI, so rounds span weeks), then has Chromium capture the
// main screens into docs/screenshots/.
//
//   make screenshots            (CHROME=/path/to/chrome to pick a browser)
//
// The data comes from a fixed seed, so only real UI changes alter the images
// (round times are relative to now, so "today" always has rounds). Run it after
// any visible change and commit the PNGs with it.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BIN = process.env.SCOREBOARD_BIN || './scoreboard';
const OUT = process.env.SHOTS_DIR || 'docs/screenshots';
if (!existsSync(BIN)) {
    console.error(`${BIN} not found: run \`make build\` first`);
    process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const chrome = [process.env.CHROME, '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((p) => p && existsSync(p));

// ---- the made-up office ---------------------------------------------------------------------
let seed = 20261015;
const rand = () => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// True skill drives who wins; the app has to work it out.
const skill = { Ada: 1.2, Bjørn: 0.9, Chen: 0.6, Dina: 0.4, Emil: 0.1, Freya: -0.1, Gus: -0.4, Hana: -0.7, Ivo: 0.3 };
const regulars = Object.keys(skill).filter((n) => n !== 'Ivo');
const wins = (a, b) => {
    const s = (t) => t.reduce((x, n) => x + skill[n], 0) + (t.length === 1 ? 0 : 0.25 * (t.length - 1));
    return rand() < 1 / (1 + Math.exp(s(b) - s(a))) ? 0 : 1;
};

const DAY = 86400000;
const now = Date.now();
const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
const days = []; // weekdays over the last six weeks, oldest first, today last
for (let d = 42; d >= 1; d--) {
    const t = new Date(midnight.getTime() - d * DAY);
    if (t.getDay() !== 0 && t.getDay() !== 6) days.push(t.getTime());
}

const rl = { name: 'Rocket League', tournaments: [], rounds: [] };
const tt = { name: 'Table tennis', ratingSpeed: 'fast', rounds: [] };
const cup = days.filter((d) => new Date(d).getDay() === 5).at(-1);
rl.tournaments.push({ name: 'Friday cup', createdAt: cup + 15 * 3600000, endedAt: cup + 17 * 3600000 });

function rlRound(at, players, tournament) {
    const p = shuffle(players);
    const fmt = pick(['2v2', '2v2', '2v2', '3v3', '2v1']);
    const [na, nb] = fmt.split('v').map(Number);
    const teams = [p.slice(0, na), p.slice(na, na + nb)];
    const winner = wins(teams[0], teams[1]);
    const lose = Math.floor(rand() * 4), win = lose + 1 + Math.floor(rand() * 3);
    rl.rounds.push({ playedAt: at, winner, scoreA: winner === 0 ? win : lose, scoreB: winner === 0 ? lose : win, teams, ...(tournament && { tournament }) });
}
for (const day of days) {
    const here = shuffle(regulars).slice(0, 5 + Math.floor(rand() * 3));
    const n = 4 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) rlRound(day + (11.5 * 3600000) + i * 9 * 60000, here.slice(0, 4 + Math.floor(rand() * 3)));
    for (let m = 0; m < 2; m++) {
        const [a, b] = shuffle(regulars);
        const winner = wins([a], [b]);
        const lose = 3 + Math.floor(rand() * 8);
        tt.rounds.push({ playedAt: day + (13 + m) * 3600000, winner, scoreA: winner === 0 ? 11 : lose, scoreB: winner === 0 ? lose : 11, teams: [[a], [b]] });
    }
}
for (let i = 0; i < 6; i++) rlRound(cup + 15.2 * 3600000 + i * 12 * 60000, regulars.slice(0, 6), 'Friday cup');
// Today: a lunch session so far, with the newcomer's first rounds.
const lunch = now - 70 * 60000;
for (let i = 0; i < 7; i++) rlRound(lunch + i * 8 * 60000, i < 3 ? ['Ada', 'Chen', 'Emil', 'Ivo', 'Dina'] : ['Ada', 'Bjørn', 'Chen', 'Dina', 'Freya', 'Ivo']);
for (const g of [rl, tt]) g.rounds.sort((a, b) => a.playedAt - b.playedAt);

const office = { format: 1, name: 'Oslo office', players: Object.keys(skill).map((name) => ({ name })), games: [rl, tt] };

// ---- server -------------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'sb-shots-'));
const port = 18600 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const adminUrl = `http://127.0.0.1:${port + 100}`;
const server = spawn(BIN, ['serve', '--db', join(dir, 'db'), '--listen', `127.0.0.1:${port}`, '--admin-listen', `127.0.0.1:${port + 100}`,
    '--public-url', base, '--join-limit', '0', '--write-limit', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
server.stderr.on('data', (d) => { log += d; });
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not yet */ }
    if (i > 50) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
}
writeFileSync(join(dir, 'office.json'), JSON.stringify(office));
const { group } = JSON.parse(execFileSync(BIN, ['admin', '--url', adminUrl, '--json', 'import', join(dir, 'office.json')], { encoding: 'utf8' }));

const rpc = async (method, body, token) => {
    const res = await fetch(`${base}/scoreboard.v1.ScoreboardService/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method}: ${res.status} ${await res.text()}`);
    return res.json();
};
const join_ = await rpc('Join', { code: group.links.officeCode });
const token = join_.deviceToken;
const gid = join_.groupId;
const { players, games } = await rpc('GetGroup', {}, token);
const ada = players.find((p) => p.name === 'Ada');
await rpc('SetMe', { playerId: ada.id }, token);
const gameId = games.find((g) => g.name === rl.name).id;
const { tournaments } = (await rpc('GetGame', { gameId }, token)).view;
const cupId = tournaments.find((t) => t.name === 'Friday cup').id;

// ---- browser ------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: chrome });
const errors = [];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

async function open(path, { theme = 'dark', device = PHONE } = {}) {
    const ctx = await browser.newContext({ ...device, locale: 'en-US', colorScheme: 'dark', reducedMotion: 'reduce' });
    await ctx.addInitScript(([groups, t]) => {
        localStorage.setItem('groups', groups);
        localStorage.setItem('theme', t);
        localStorage.setItem('lang', 'en');
    }, [JSON.stringify([{ id: gid, name: join_.name, token, code: group.links.officeCode }]), theme]);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${path}: ${m.text()}`); });
    await p.goto(base + path);
    await p.waitForLoadState('networkidle');
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    return p;
}
async function shot(p, name) {
    await p.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`  ${OUT}/${name}.png`);
    await p.context().close();
}

const game = `/g/${gid}/game/${gameId}`;
await shot(await open(game), 'leaderboard');
{
    const p = await open(game);
    await p.locator('.fab').click();
    await p.waitForSelector('dialog[open]');
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(300);
    await shot(p, 'round');
}
await shot(await open(`${game}/p/${ada.id}`), 'player');
await shot(await open(`${game}/t/${cupId}`), 'tournament');
await shot(await open(`${new URL(group.links.dashboard).pathname}?game=${gameId}`, { device: DESKTOP }), 'dashboard');
for (const theme of ['light', 'dark', 'hacker', 'gamer']) await shot(await open(game, { theme }), `theme-${theme}`);

await browser.close();
stop();
if (errors.length) {
    console.error(`\nerrors in the page:\n  ${errors.join('\n  ')}`);
    process.exit(1);
}
