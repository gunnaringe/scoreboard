# scoreboard

Office game scoreboard at score.apphub.casa: groups → games (e.g. Rocket
League) → rounds, optional tournaments, Weng-Lin team ratings. No accounts:
devices join a group with an invite code (usually a printed QR poster).

**Not deployed yet** (2026-10-10). See "Deploy" in README.md for the one-time
setup (D1 database, Workers Builds import).

## Layout

- `src/worker.js` — the JSON API under `/api/*`. Only these paths run the
  Worker (`run_worker_first`); everything else is free static assets.
- `public/` — the app, no build step. `app.js` is a small SPA routing on
  `location.pathname` (`not_found_handling: single-page-application` serves
  `index.html` for `/j/CODE`, `/g/...`). Render user text via `h()` /
  `textContent`, never markup.
- `public/rating.js` — Weng-Lin (Bradley-Terry full pair). Shared by the
  Worker and the browser (win odds, team balancing). Must stay deterministic:
  incremental updates and full replay have to agree (tested).
- `public/qrcodegen.js` — generated from `vendor/qrcodegen.ts` (Nayuki, MIT)
  by `scripts/build-qr.sh`. Don't edit by hand.
- `public/theme.js`, `fonts/`, theme CSS blocks — copied from `world-clock`
  (auto/light/dark/hacker). Keep the look in sync with clock.apphub.casa.
- `public/i18n.js` — `en` and `no`, same keys (checked by `test/i18n.test.js`,
  which also checks every `t('key')` in `app.js` exists).
- `migrations/` — D1 schema. Add new numbered files; never edit applied ones.

## Data and ratings

- `round_players` stores each player's mu/sigma before and after every round,
  `ratings` the current value per game. The leaderboard only reads `ratings`,
  so page views stay cheap however long the history gets.
- New rounds are applied incrementally. Editing teams/winner, deleting or
  restoring a round that is still the newest round of everyone in it (wrong
  winner, Undo) is also incremental (`latestRoundStatements`: revert from the
  stored before-values, re-apply). Anything older replays the whole game
  (`replayGame`), rewriting only rows that changed. Replay of 5,000 rounds is
  ~17–29 ms CPU, over the free plan's 10 ms/request — fine for occasional
  edits of old rounds, but keep the common paths off it.
  `scripts/smoke.js` checks fast path == full replay. Admins have a
  "Recalculate" button per game as a repair for the rare concurrent-insert
  race.
- Display rating = `1000 + 40·(mu − 3·sigma)`; under 5 rounds is
  "provisional" (shown, not ranked).
- Tournament rounds count towards the game's overall rating; the tournament
  page just filters rounds and sums deltas.

## D1 free-plan limits that shape the code

50 queries per request and 100 bound parameters per query: bulk writes go
through one JSON parameter + `json_each()` (see `ratingRowsSql`,
`roundPlayersSql`). `INSERT … SELECT … ON CONFLICT` needs `WHERE true` before
`ON CONFLICT` (SQLite parser quirk).

## Permissions

- Device token (SHA-256 stored) per browser per group.
- Admin = `devices.is_admin` OR `groups.everyone_admin`. The creator is admin.
- `groups.edit_policy`: `anyone` (default) or `admin` — then only admins and
  the device that logged a round may edit/delete it. Logging new rounds is
  always open. All enforced server-side.

## Develop

    npm install
    npm run migrate:local
    npm run dev                 # http://localhost:8787, local D1
    npm test                    # rating + i18n unit tests
    node scripts/smoke.js       # end-to-end API check against npm run dev

The service worker isn't registered on localhost. Bump `CACHE` in `sw.js` when
changing its precache list.
