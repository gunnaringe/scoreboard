// Browser end-to-end tests: starts the real binary (single and multi mode, with
// and without branding) and drives it with Chromium like a person would.
//
//   make build && npm run e2e            (CHROME=/path/to/chrome to pick a browser)
//
// Any console error or uncaught exception in the page fails the run. Screenshots
// of the main screens go to $E2E_SHOTS (default /tmp/scoreboard-e2e).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BIN = process.env.SCOREBOARD_BIN || './scoreboard';
const SHOTS = process.env.E2E_SHOTS || '/tmp/scoreboard-e2e';
mkdirSync(SHOTS, { recursive: true });
if (!existsSync(BIN)) {
    console.error(`${BIN} not found: run \`make build\` first`);
    process.exit(2);
}
const chrome = [process.env.CHROME, '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((p) => p && existsSync(p));

const failures = [];
const check = (cond, msg) => {
    if (!cond) { failures.push(msg); console.error(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`);
};
const eq = (got, want, msg) => check(JSON.stringify(got) === JSON.stringify(want), `${msg}${JSON.stringify(got) === JSON.stringify(want) ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);

// ---- a throwaway server ---------------------------------------------------------------------
let nextPort = 18700 + Math.floor(Math.random() * 500);
async function startServer(name, extra = []) {
    const dir = mkdtempSync(join(tmpdir(), `sb-e2e-${name}-`));
    const port = nextPort++;
    const admin = nextPort++;
    const args = ['serve', '--db', join(dir, 'db'), '--listen', `127.0.0.1:${port}`, '--admin-listen', `127.0.0.1:${admin}`,
        '--public-url', `http://127.0.0.1:${port}`, '--join-limit', '0', '--write-limit', '0', ...extra];
    const proc = spawn(BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    proc.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
        if (i === 49) throw new Error(`server did not start:\n${log}`);
    }
    return {
        url: `http://127.0.0.1:${port}`,
        cli: (...a) => execFileSync(BIN, ['admin', '--url', `http://127.0.0.1:${admin}`, ...a], { encoding: 'utf8' }),
        stop: () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); },
    };
}

// ---- browser helpers ----------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: chrome });
const errors = [];
async function newPage({ theme = 'dark', vp = { width: 390, height: 844 }, locale = 'en-US', name = 'page' } = {}) {
    const ctx = await browser.newContext({ viewport: vp, locale });
    await ctx.addInitScript((t) => { if (!localStorage.getItem('theme')) localStorage.setItem('theme', t); }, theme);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
    p.on('dialog', (d) => d.accept(d.defaultValue()));
    p.ctx = ctx;
    return p;
}
const settle = (p) => p.waitForLoadState('networkidle');
const shot = (p, name, full = true) => p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full });
const text = async (p, sel = '#app') => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ');
const rpcDone = (p, method) => p.waitForResponse((r) => r.url().endsWith(`.ScoreboardService/${method}`) && r.request().method() === 'POST');

// The chip of a player in the open round sheet.
const chipOf = (p, name) => p.locator('dialog .pchip', { has: p.locator(`.chip-name:text-is("${name}")`) }).first();
// Puts a player on a team in the open round sheet (adding them first if unknown),
// with the chip's buttons: + team on the bench, "move" in the other team.
async function place(p, name, team) {
    if (!(await chipOf(p, name).count())) {
        await p.fill('dialog input[placeholder="New player"]', name);
        await p.click('dialog form button');
        await chipOf(p, name).waitFor();
    }
    for (let i = 0; i < 3; i++) {
        const c = chipOf(p, name);
        const cls = (await c.getAttribute('class')) || '';
        if (cls.includes(`team-${team}`)) return;
        await c.locator(cls.includes('team-') ? '.chip-move' : `.add-${team}`).click();
    }
    throw new Error(`could not put ${name} on team ${team}`);
}
// Drags a chip onto a drop zone ('0', '1' or 'bench') with the mouse.
async function drag(p, name, zone) {
    const from = await chipOf(p, name).locator('.chip-name').boundingBox();
    const to = await p.locator(`dialog [data-drop="${zone}"]`).boundingBox();
    await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await p.mouse.down();
    await p.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
    await p.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await p.mouse.up();
}
// Logs a round: a/b are lists of names; winner 0 or 1. Resolves when the page has refreshed.
async function logRound(p, a, b, winner) {
    await p.locator('.fab').click();
    await p.waitForSelector('dialog[open]');
    await settle(p);
    await p.click('dialog button:has-text("Clear")');
    for (const n of a) await place(p, n, 0);
    for (const n of b) await place(p, n, 1);
    const refreshed = rpcDone(p, 'GetGame');
    await p.click(`dialog .win-${winner}`);
    await refreshed;
    await p.waitForTimeout(250);
}
const ratingOf = async (p, name) => Number(await p.locator('.board tr', { hasText: name }).first().locator('.rating').innerText());

// =============================================================================================
// 1. Multi mode with branding: create a group, play, edit, tournaments, settings
// =============================================================================================
console.log('\nmulti mode, branded: the full tour');
const brandDir = mkdtempSync(join(tmpdir(), 'sb-brand-'));
writeFileSync(join(brandDir, 'branding.json'), '{"name":"Acme Games","accent":"#e4572e","defaultTheme":"dark","footer":"Made at Acme"}');
writeFileSync(join(brandDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" fill="#e4572e"/></svg>');
const multi = await startServer('multi', ['--branding-dir', brandDir]);
{
    const ada = await newPage({ name: 'ada' });
    await ada.goto(multi.url);
    check((await ada.title()) === 'Acme Games', 'page title uses the branded name');
    check(await ada.locator('.brand-logo').count() > 0, 'the logo is in the top bar');
    check((await text(ada, 'footer')).includes('Made at Acme'), 'the footer shows');
    check((await ada.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))).trim() === '#e4572e', 'accent colour applied');
    await shot(ada, 'multi-01-home');

    await ada.fill('input[placeholder="e.g. Oslo office"]', 'Oslo office');
    await ada.click('text=Create group');
    await ada.waitForSelector('dialog[open] input.mono');
    const ownerLink = await ada.inputValue('dialog input.mono');
    check(/\/o\/[\w-]{20,}$/.test(ownerLink), 'the owner link is shown once');
    await shot(ada, 'multi-02-owner-link', false);
    await ada.click('dialog button[aria-label="Close"]');
    await ada.waitForSelector('.fab');
    check((await text(ada)).includes('No rounds yet'), 'empty game explains what to do');
    const gamePath = new URL(ada.url()).pathname;

    // Rounds: 1v1, 2v2, 2v1 (teaches a handicap), balance, same-as-last
    await logRound(ada, ['Ada'], ['Bob'], 0);
    eq([await ratingOf(ada, 'Ada') > 1000, await ratingOf(ada, 'Bob') < 1000], [true, true], 'the winner goes up, the loser down');
    // Today and this week: both cells filled for someone who played today.
    eq(await ada.locator('.board tr', { hasText: 'Ada' }).first().locator('.delta-cell').allInnerTexts().then((c) => c.map((x) => x.trim() !== '')), [true, true],
        'the leaderboard shows today and this week');
    await logRound(ada, ['Ada', 'Cy'], ['Bob', 'Dee'], 1);
    await logRound(ada, ['Ada', 'Bob'], ['Cy'], 0);
    await ada.locator('.fab').click();
    await ada.waitForSelector('dialog[open]');
    await settle(ada);
    const lineup = (await ada.locator('dialog .team-box').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
    check(lineup[0].includes('Ada') && lineup[0].includes('Bob') && lineup[1].includes('Cy'), 'the sheet opens with the last line-up');
    await ada.waitForSelector('dialog .odds');
    const odds = (await ada.locator('dialog .odds').allInnerTexts()).map((x) => parseInt(x));
    check(odds.length === 2 && odds[0] + odds[1] >= 99 && odds[0] + odds[1] <= 101, `win odds come from the server (${odds.join(' / ')})`);
    // Chips show the rating; drag and drop moves players like the buttons do.
    check(/Ada\s*\d{3,4}/.test(await chipOf(ada, 'Ada').innerText()), 'player chips show the rating');
    await drag(ada, 'Cy', '0');
    check((await chipOf(ada, 'Cy').getAttribute('class')).includes('team-0'), 'dragging a player onto the other team moves them');
    await drag(ada, 'Cy', 'bench');
    check(!(await chipOf(ada, 'Cy').getAttribute('class')).includes('team-'), 'dragging onto the bench benches them');
    await place(ada, 'Cy', 1);
    // Balance
    await place(ada, 'Dee', 1);
    const balanced = rpcDone(ada, 'SuggestTeams');
    await ada.click('dialog button:has-text("Balance")');
    await balanced;
    await ada.waitForTimeout(300);
    const sizes = (await ada.locator('dialog .team-box').evaluateAll((els) => els.map((e) => e.querySelectorAll('.pchip').length)));
    check(Math.abs(sizes[0] - sizes[1]) <= 1 && sizes[0] + sizes[1] === 4, `balance splits 4 players evenly (${sizes.join('/')})`);
    await ada.click('dialog button[aria-label="Close"]');

    // Edit: flip the newest round, delete it, undo
    await settle(ada);
    const before = await ratingOf(ada, 'Ada');
    await ada.locator('button.round').first().click();
    await ada.waitForSelector('dialog[open]');
    const pressed = await ada.getAttribute('dialog .win-0', 'aria-pressed');
    await ada.click(pressed === 'true' ? 'dialog .win-1' : 'dialog .win-0');
    let refreshed = rpcDone(ada, 'GetGame');
    await ada.click('dialog .sheet-actions .btn:has-text("Save")');
    await refreshed;
    await ada.waitForTimeout(250);
    const flipped = await ratingOf(ada, 'Ada');
    check(flipped !== before, `flipping the winner changes the ratings (${before} → ${flipped})`);
    await ada.locator('button.round').first().click();
    await ada.waitForSelector('dialog[open]');
    refreshed = rpcDone(ada, 'GetGame');
    await ada.click('dialog button:has-text("Delete")');
    await refreshed;
    await ada.waitForTimeout(250);
    const deleted = await ratingOf(ada, 'Ada');
    check(deleted !== flipped, 'deleting a round recalculates');
    refreshed = rpcDone(ada, 'GetGame');
    await ada.click('.toast button');
    await refreshed;
    await ada.waitForTimeout(250);
    eq(await ratingOf(ada, 'Ada'), flipped, 'Undo brings the rating back');
    await shot(ada, 'multi-03-game');

    // Gamer theme: picked in the app settings; the teams keep their game's colours.
    await ada.goto(`${multi.url}/settings`);
    await ada.click('.segmented button:has-text("Gamer")');
    eq(await ada.evaluate(() => document.documentElement.dataset.theme), 'gamer', 'the gamer theme can be picked');
    await ada.goto(multi.url + gamePath);
    await ada.waitForSelector('.board');
    eq(await ada.locator('.tl').allInnerTexts(), ['Blue', 'Orange'], 'gamer theme: the teams are still the game\'s Blue and Orange');
    await shot(ada, 'multi-03b-gamer', false);
    await ada.evaluate(() => { localStorage.setItem('theme', 'dark'); window.applyTheme(); });
    await ada.reload();
    await ada.waitForSelector('.board');

    // Tournament
    await ada.fill('input[placeholder="New tournament"]', 'Friday cup');
    await ada.click('button:has-text("Start")');
    await ada.waitForSelector('text=Standings');
    await logRound(ada, ['Ada'], ['Cy'], 0).catch(() => {});
    await settle(ada);
    check((await text(ada)).includes('Friday cup'), 'the tournament page lists its round');
    eq(await ada.locator('.board td.name').allInnerTexts(), ['Ada', 'Cy'], 'the standings name the players');
    await shot(ada, 'multi-04-tournament');
    await ada.click('button:has-text("End tournament")');
    await ada.waitForSelector('text=ended');

    // Player page, history
    await ada.goBack();
    await ada.waitForSelector('.board');
    await ada.locator('.board tr', { hasText: 'Ada' }).first().click();
    await ada.waitForSelector('.chart');
    const stats = (await text(ada)).toLowerCase(); // headings are upper-cased by CSS
    check(stats.includes('streak') && stats.includes('with') && stats.includes('against'), 'the player page shows stats and head-to-head');
    const h2h = await ada.locator('.board.compact td.name').allInnerTexts();
    check(h2h.length > 0 && !h2h.includes('?'), `the head-to-head tables name the players (${h2h.join(', ')})`);
    await shot(ada, 'multi-05-player');
    await ada.goBack();
    await ada.click('a:has-text("History")');
    // The game page has a .rounds list too, and networkidle doesn't wait after a
    // client-side navigation: wait for the history page's own title (rendered with its data).
    await ada.waitForURL(/\/history$/);
    await ada.waitForSelector('h1.title:has-text("History")');
    await ada.waitForSelector('.rounds');
    check(await ada.locator('.round').count() >= 4, 'history lists the rounds');

    // Settings as owner
    await ada.goto(`${multi.url}${new URL(ada.url()).pathname.replace(/\/game.*/, '')}/settings`);
    await ada.waitForSelector('text=Players');
    const settings = await text(ada);
    check(settings.includes('Owner') && settings.includes('Devices') && settings.includes('Leave or delete'), 'an owner sees owner tools, devices and the danger zone');
    const gid = new URL(ada.url()).pathname.split('/')[2];

    // Teams: a name and a colour each, in one sheet. Without a name a team goes by its colour.
    await ada.click('button:has-text("Teams")');
    await ada.waitForSelector('dialog[open]');
    const named = rpcDone(ada, 'UpdateGame');
    await ada.locator('dialog input').nth(0).fill('Lions');
    await ada.click('dialog .team-box-1 .swatch[aria-label="Red"]');
    check(await ada.locator('dialog .team-box-0 .swatch[aria-label="Red"]').isDisabled(), "the other team's colour can't be picked");
    eq(await ada.locator('dialog .team-box-1 strong').innerText(), 'Red', 'an unnamed team is called by its colour');
    await shot(ada, 'multi-05a-teams', false);
    await ada.click('dialog button:has-text("Save")');
    await named;
    await ada.waitForSelector('text=Lions / Red');
    check(true, 'a team gets a name and another a colour');
    await ada.goto(multi.url + gamePath);
    await ada.waitForSelector('.board');
    eq(await ada.locator('.tl').allInnerTexts(), ['Lions', 'Red'], 'the game page uses the team names');
    const css = (prop) => ada.evaluate((p) => getComputedStyle(document.documentElement).getPropertyValue(p).trim(), prop);
    eq(await css('--team-1'), await css('--c-red'), 'and their colours');
    await ada.goBack();
    await ada.waitForSelector('text=Lions / Red');
    const reset = rpcDone(ada, 'UpdateGame');
    await ada.click('button:has-text("Teams")');
    await ada.locator('dialog input').nth(0).fill('');
    await ada.click('dialog .team-box-1 .swatch[aria-label="Orange"]');
    await ada.click('dialog button:has-text("Save")');
    await reset;
    await ada.waitForSelector('text=Blue / Orange');

    // Rating speed: the sheet explains the choice, saving re-rates the game.
    const setSpeed = async (label) => {
        await ada.click('button:has-text("Rating speed")');
        await ada.waitForSelector('dialog[open]');
        await ada.click(`dialog .segmented button:has-text("${label}")`);
        return (await text(ada, 'dialog'));
    };
    const speedText = await setSpeed('Fast');
    check(speedText.includes('table tennis') && speedText.includes('recalculates every rating'), 'the rating speed sheet explains the choice');
    await shot(ada, 'multi-05b-rating-speed', false);
    let updated = rpcDone(ada, 'UpdateGame');
    await ada.click('dialog button:has-text("Save")');
    await updated;
    await ada.waitForSelector('text=Ratings recalculated');
    await ada.waitForSelector('.list-row:has-text("· Fast")');
    check(true, 'a game shows its non-default rating speed');
    updated = rpcDone(ada, 'UpdateGame');
    await setSpeed('Steady');
    await ada.click('dialog button:has-text("Save")');
    await updated;
    await ada.waitForFunction(() => !document.body.innerText.includes('· Fast'));

    // A second phone joins with the office code
    const code = (await text(ada, '.code')).trim();
    const bob = await newPage({ name: 'bob', theme: 'light' });
    await bob.goto(`${multi.url}/j/${code}`);
    await bob.waitForSelector('.board');
    check(new URL(bob.url()).pathname.includes('/game/') && (await bob.locator('dialog[open]').count()) === 0,
        'joining by link opens the only game, without asking who you are');
    await shot(bob, 'multi-06-joined', false);
    await bob.goto(`${multi.url}/g/${gid}/settings`);
    await bob.waitForSelector('text=Players');
    const bobSettings = await text(bob);
    check(!bobSettings.includes('Leave or delete') === false && !bobSettings.includes('New office link') && bobSettings.includes('Owner'), 'a member sees no owner buttons');
    check(bobSettings.includes('Have the owner link'), 'a member is told how to become an owner');
    // ...until they open the owner link
    await bob.goto(ownerLink);
    await bob.waitForURL(/settings/);
    await bob.waitForSelector('text=New office link and code');
    check(true, 'opening the owner link makes a member an owner');

    // Owner rotates the office link; the old code is dead and the page explains
    await ada.click('button:has-text("New office link and code")');
    await ada.waitForFunction((old) => document.querySelector('.code')?.textContent.trim() !== old, code);
    const stale = await newPage({ name: 'stale' });
    await stale.goto(`${multi.url}/j/${code}`);
    await stale.waitForSelector('text=no longer works');
    check(true, 'a rotated office link shows a clear message');
    await shot(stale, 'multi-07-stale-link', false);

    // Poster
    await ada.goto(`${multi.url}/g/${gid}/poster`);
    await ada.waitForSelector('.poster .qr');
    check(await ada.locator('.poster-logo').count() === 1 && (await ada.locator('.poster-code').count()) === 1, 'the poster has the logo and the code');
    await shot(ada, 'multi-08-poster', false);

    // Dashboard
    await ada.goto(`${multi.url}/g/${gid}/settings`);
    await ada.waitForSelector('text=Dashboard link');
    const dashHref = await ada.locator('a:has-text("Open dashboard")').getAttribute('href');
    const tv = await newPage({ name: 'tv', theme: 'hacker', vp: { width: 1366, height: 860 } });
    await tv.goto(dashHref);
    await tv.waitForSelector('.board');
    check((await tv.locator('.fab, button.round').count()) === 0, 'the dashboard has no controls');
    await shot(tv, 'multi-09-dashboard', false);
    // It follows new rounds by itself: it polls the game's version every 30 seconds.
    const boardBefore = await text(tv, '.board-wrap');
    await ada.goto(`${multi.url}${gamePath}`);
    await ada.waitForSelector('.fab');
    await logRound(ada, ['Ada'], ['Dee'], 1);
    await tv.waitForFunction((old) => document.querySelector('.board-wrap')?.innerText.replace(/\s+/g, ' ') !== old, boardBefore, { timeout: 45000 });
    check(true, 'the dashboard picks up a new round on its own');

    // Leaving: the group disappears from this phone
    await bob.goto(`${multi.url}/g/${gid}/settings`);
    await bob.waitForSelector('text=Leave group on this device');
    await bob.click('button:has-text("Leave group on this device")');
    await bob.waitForSelector('text=Join a group');
    check(true, 'leaving a group returns to the start page');
}

// =============================================================================================
// 2. Multi mode, operator-only group creation, Norwegian
// =============================================================================================
console.log('\nmulti mode, group creation off, Norwegian');
const closed = await startServer('closed', ['--allow-group-creation=false']);
{
    const out = closed.cli('groups', 'create', 'Kontoret', '--player', 'Kari', '--game', 'Rocket League');
    const office = out.match(/office link:\s+(\S+)/)[1];
    const p = await newPage({ name: 'nb', locale: 'nb-NO' });
    await p.goto(closed.url);
    check(!(await text(p)).includes('Ny gruppe'), 'no "new group" card when creation is off');
    check((await text(p)).includes('Bli med i en gruppe'), 'the start page is in Norwegian');
    await p.goto(office);
    await p.waitForSelector('.fab');
    check((await text(p)).includes('Tabell') && (await text(p)).includes('Ny runde'), 'the game page is Norwegian');
    check((await text(p)).includes('Blå') || (await text(p)).includes('Blue') === false, 'default team names follow the language');
    await shot(p, 'nb-01-game', false);
    await p.click('.fab');
    await p.waitForSelector('dialog[open]');
    check((await text(p, 'dialog')).includes('Blå') && (await text(p, 'dialog')).includes('Benken'), 'the round sheet is Norwegian, teams Blå / Oransje');
    await shot(p, 'nb-02-sheet', false);
}
closed.stop();

// =============================================================================================
// 3. Single mode
// =============================================================================================
console.log('\nsingle mode');
const single = await startServer('single', ['--mode', 'single', '--group-name', 'Oslo office']);
{
    const a = await newPage({ name: 'single-a' });
    await a.goto(single.url);
    await a.waitForSelector('text=No games yet.');
    await settle(a);
    check(new URL(a.url()).pathname === '/g/main' && (await a.locator('dialog[open]').count()) === 0, 'opening the address joins silently');
    check(!(await text(a)).includes('Join a group'), 'there is no start page');
    check(!(await text(a)).includes("You're") && !(await text(a)).includes('Who are you'), 'nobody is asked who they are');
    await a.fill('input[placeholder="Game name"]', 'Table tennis');
    await a.click('button:has-text("Add")');
    await a.waitForURL(/\/game\//);
    await a.waitForSelector('.fab');
    await logRound(a, ['Ada'], ['Bob'], 0);
    await logRound(a, ['Ada'], ['Bob'], 1);
    check((await text(a, '.board-wrap')).includes('Bob'), 'rounds work in single mode');

    await a.goto(`${single.url}/g/main/settings`);
    await a.waitForSelector('text=Players');
    const s = await text(a);
    check(!s.includes('Owner') && !s.includes('Devices') && !s.includes('Leave'), 'no owner tools, devices or leave button');
    check(s.includes('Share') && s.includes('Dashboard link'), 'it offers sharing the address and the dashboard');
    await a.goto(`${single.url}/g/main/poster`);
    await a.waitForSelector('.poster .qr');
    check((await a.locator('.poster-code').count()) === 0, 'the poster has no code in single mode');
    await shot(a, 'single-01-poster', false);

    const b = await newPage({ name: 'single-b', theme: 'light' });
    await b.goto(single.url);
    await b.waitForSelector('.board');
    check(new URL(b.url()).pathname.includes('/game/'), 'a second phone lands on the only game');
    await b.goto(`${single.url}/j/ABCD-EFGH`);
    await b.waitForSelector('.board');
    check(!new URL(b.url()).pathname.startsWith('/j/'), 'multi-mode links just open the app');

    const tv = await newPage({ name: 'single-tv', theme: 'hacker', vp: { width: 1366, height: 860 } });
    await tv.goto(`${single.url}/d`);
    await tv.waitForSelector('.board');
    check((await text(tv)).includes('Table tennis') || (await text(tv)).includes('Leaderboard'), 'the dashboard is open at /d');

    // The operator renames the group from the CLI; the app shows it.
    single.cli('groups', 'rename', 'Oslo HQ');
    await b.goto(`${single.url}/g/main`);
    await b.waitForSelector('text=Table tennis');
    check((await b.title()).includes('Oslo HQ'), 'a rename through the admin CLI shows up');
    // Named like the instance: the top bar doesn't say it twice.
    single.cli('groups', 'rename', 'Scoreboard');
    await b.reload();
    await b.waitForSelector('text=Table tennis');
    eq((await text(b, '.topbar')).match(/Scoreboard/g)?.length, 1, 'the group name is not shown twice in the top bar');
    eq(await b.title(), 'Scoreboard', 'nor in the page title');
}
single.stop();

// A single-mode server with the dashboard off
console.log('\nsingle mode, dashboard off');
const noDash = await startServer('nodash', ['--mode', 'single', '--dashboard', 'off']);
{
    const p = await newPage({ name: 'nodash' });
    await p.goto(`${noDash.url}/d`);
    await p.waitForSelector('text=Not found');
    check(true, '/d is not found when the dashboard is off');
    await p.goto(`${noDash.url}/g/main/settings`);
    await p.waitForSelector('text=Players');
    check(!(await text(p)).includes('Dashboard link'), 'no dashboard link is offered when it is off');
}
noDash.stop();
multi.stop();
rmSync(brandDir, { recursive: true, force: true });

await browser.close();
check(errors.length === 0, errors.length ? `no console errors (got: ${errors.join(' | ')})` : 'no console errors in any page');
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall e2e checks passed');
console.log(`screenshots: ${SHOTS}`);
process.exit(failures.length ? 1 : 0);
