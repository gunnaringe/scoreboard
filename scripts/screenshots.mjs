// README screenshots: starts the real binary with a made-up office (imported
// through the admin CLI, so rounds span weeks), then has Chromium capture the
// main screens into docs/screenshots/.
//
//   make screenshots            (CHROME=/path/to/chrome to pick a browser)
//
// The data comes from a fixed seed and the clock is frozen (in the script and
// the browser). Chromium's blur and anti-aliasing still vary a little from run
// to run, so an existing PNG is only replaced when the new one looks different
// (more than a few pixels changed noticeably): git shows just the screens that
// changed. Run it after any visible change and commit those PNGs with it.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

process.env.TZ = 'Europe/Oslo';
// "Now" for the demo: a Wednesday shortly after lunch.
const NOW = Date.parse('2026-10-14T12:30:00+02:00');

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
const now = NOW;
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
process.on('exit', () => server.kill());
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
const gameId = games.find((g) => g.name === rl.name).id;
const { tournaments } = (await rpc('GetGame', { gameId }, token)).view;
const cupId = tournaments.find((t) => t.name === 'Friday cup').id;

// ---- browser ------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: chrome });
const errors = [];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

async function open(path, { theme = 'dark', device = PHONE } = {}) {
    const ctx = await browser.newContext({ ...device, locale: 'en-US', timezoneId: 'Europe/Oslo', colorScheme: 'dark', reducedMotion: 'reduce' });
    await ctx.clock.setFixedTime(NOW);
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
// Share of pixels that differ visibly between two PNGs (1 if the sizes differ).
async function difference(p, a, b) {
    return p.evaluate(async ([a, b]) => {
        const load = (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
        const [x, y] = await Promise.all([load(a), load(b)]);
        if (x.width !== y.width || x.height !== y.height) return 1;
        const pixels = (img) => {
            const c = new OffscreenCanvas(img.width, img.height).getContext('2d');
            c.drawImage(img, 0, 0);
            return c.getImageData(0, 0, img.width, img.height).data;
        };
        const [da, db] = [pixels(x), pixels(y)];
        let changed = 0;
        for (let i = 0; i < da.length; i += 4) {
            if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48) changed++;
        }
        return changed / (da.length / 4);
    }, [a.toString('base64'), b.toString('base64')]);
}
async function shot(p, name) {
    const file = join(OUT, `${name}.png`);
    const png = await p.screenshot();
    const diff = existsSync(file) ? await difference(p, readFileSync(file), png) : 1;
    if (diff > 0.0005) {
        writeFileSync(file, png);
        console.log(`  ${file}${diff < 1 ? ` (${(diff * 100).toFixed(2)} % changed)` : ''}`);
    } else console.log(`  ${file} unchanged`);
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
{
    const p = await open(`/g/${gid}/settings`);
    await p.locator('.list-row', { hasText: rl.name }).locator('button:has-text("Teams")').click();
    await p.waitForSelector('dialog[open]');
    await p.waitForTimeout(300);
    await shot(p, 'team-names');
}
await shot(await open(`${game}/t/${cupId}`), 'tournament');
await shot(await open(`${new URL(group.links.dashboard).pathname}?game=${gameId}`, { device: DESKTOP }), 'dashboard');
for (const theme of ['light', 'dark', 'hacker', 'gamer']) await shot(await open(game, { theme }), `theme-${theme}`);

await browser.close();
stop();
if (errors.length) {
    console.error(`\nerrors in the page:\n  ${errors.join('\n  ')}`);
    process.exit(1);
}
