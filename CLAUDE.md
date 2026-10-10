# scoreboard

Office game scoreboard at scoreboard.apphub.casa: groups → games (e.g. Rocket
League) → rounds, optional tournaments, Weng-Lin team ratings. No accounts.

**Not deployed yet** (2026-10-10): the D1 database exists (ID in
`wrangler.jsonc`), the Workers Builds import is still to do — see "Deploy" in
README.md. The deploy command is `npm run deploy`, which runs `wrangler d1
migrations apply --remote` before `wrangler deploy`, so migrations ship with
the code. `migrations/0001_init.sql` is applied by the first build: from then
on never edit it, add new numbered migrations.

## Access: three links per group

- **Office link** `/j/<CODE>` (8-char code, QR poster): anyone with it joins
  and gets a device token. Members can do everything with rounds, players,
  games and tournaments — office trust, by the user's choice. They can see and
  share the office and dashboard links but not change them.
- **Dashboard link** `/d/<token>`: read-only leaderboard + recent rounds for
  wall screens, no device needed (`/api/d/...`). Polls every 30 s, wake lock.
  Stored as is (members are shown it).
- **Owner link** `/o/<token>`: opening it makes this browser's device an owner
  (`devices.is_owner`). Owners make new office/dashboard/owner links, rename
  or delete the group, remove devices. Only its SHA-256 is stored; it's shown
  once (at creation or when made anew) with copy / mailto / share. The owner
  link is also the recovery path, so a group can't get locked out.

Device tokens: one per browser per group, SHA-256 stored, `Authorization:
Bearer`. iOS Safari drops localStorage after 7 days unvisited unless the app
is on the home screen — the game page nudges iPhone users.

## Layout

- `src/worker.js` — the JSON API under `/api/*`. Only these paths run the
  Worker (`run_worker_first`); everything else is free static assets.
- `public/` — the app, no build step. `app.js` is a small SPA routing on
  `location.pathname` (`not_found_handling: single-page-application`). Render
  user text via `h()` / `textContent`, never markup. `_headers` sets CSP
  (same-origin only) and `Referrer-Policy: no-referrer`.
- `public/rating.js` — the rating model, shared by Worker and browser (win
  odds, team balancing). Must stay deterministic: incremental updates and full
  replay have to agree (tested).
- `public/qrcodegen.js` — generated from `vendor/qrcodegen.ts` (Nayuki, MIT)
  by `scripts/build-qr.sh`. Don't edit by hand.
- `public/theme.js`, `fonts/`, theme CSS blocks — from `world-clock`
  (auto/light/dark/hacker). Dark theme uses dark text on accent/team fills
  (`--on-accent`, `--on-team`) for contrast.
- `public/i18n.js` — `en` and `no`, same keys (`test/i18n.test.js` also checks
  every `t('key')` in `app.js` exists). Default team names are NULL in the DB
  and localised (Blue/Orange, Blå/Oransje).

## Rating model (tuned with simulations by a review, 2026-10-10)

- Weng-Lin Bradley-Terry full pairing, starting sigma 6, beta 25/6, tau 25/300.
- Team strength = Σ(mu − 25), so team size is worth nothing by itself; each
  uneven format ("2v1", "3v2") has a learned **handicap** pseudo-player on the
  bigger team (`handicaps` table; before/after stored on `rounds`). Summing raw
  mu made 2v1 98 % for the pair and let the solo player farm rating.
- Display = `1000 + 25·(mu − sigma − 19)` (newcomer = 1000). The +/− shown per
  round and "today" are mu changes (`displayDelta`), so a losing day never
  shows a gain. mu − 3σ was rejected: it rewarded volume over skill.
- Under 10 rounds a player is "new": listed separately, not ranked.
- Tournament rounds count towards the game's rating.

## Rating writes (`rerate` in worker.js)

Every rating change — new round, edit of teams/winner, delete, restore — goes
through `rerate`: it recalculates from the changed round onward (not from the
start), using stored before-values as the starting state, and commits the
round change plus all rating rows in **one batch**. The batch starts with a
version guard on `games.version` that fails (via `json('stale')`) if another
write got in first; `retrying()` then redoes the request. Changes more than
`MAX_RERATE` (300) rounds back are refused: measured ~4 ms for 300 rounds and
~10 ms for 800, against the 10 ms CPU limit. `scripts/smoke.js` does random
edits/deletes/restores, concurrent saves and uneven formats, then checks every
stored value against a full replay.

## Free-plan limits that shape the code

- D1: 50 queries/request, 100 bound params/query → bulk writes via one JSON
  parameter + `json_each()`. `INSERT … SELECT … ON CONFLICT` needs `WHERE true`
  before `ON CONFLICT` (SQLite parser quirk).
- Daily D1 quotas (5M rows read, 100k written) are shared by the whole account
  and enforced (requests fail until 00:00 UTC). Hence: `WRITE_LIMIT` 60/min per
  device on every change, `JOIN_LIMIT` 100/min per IP on join/create/owner (a
  whole office joins from one IP), page size ≤ 200 with a `(played_at, id)`
  cursor, and per-group caps (`CAPS`).
- Workers: 10 ms CPU per request (see MAX_RERATE).
- Polling (game page 60 s while visible, dashboard 30 s) asks
  `/games/<id>/version` (2–3 rows) and reloads only when it changed, at
  midnight, or every 40th check — a full reload is hundreds of rows on a busy
  day. Keep it that way: a wall screen runs 24/7.

## Develop

    npm install
    npm run migrate:local
    npm run dev                 # http://localhost:8787, local D1
    npm test                    # rating + i18n unit tests
    node scripts/smoke.js       # end-to-end API check against npm run dev

The service worker isn't registered on localhost. Bump `CACHE` in `sw.js` when
changing its precache list. Killing `wrangler dev` with `pkill -f` from a shell
whose command line contains the pattern kills that shell too — use a script.
