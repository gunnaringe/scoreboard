# scoreboard

Self-hosted game scores with fair team ratings, for offices, clubs and
friends. One Go binary: web server with the frontend embedded, Connect API,
SQLite, admin port and CLI. Apache-2.0. See `README.md` for what it does and
how to run it; this file is only what is easy to get wrong. The earlier
Cloudflare Workers + D1 version is the tag `worker-final` (never deployed to
production). `CLAUDE.md` only points here; edit this file.

## Workflow

- `main` is the only long-lived branch; work on a branch and open a PR. CI
  (`.github/workflows/ci.yml`) runs `make check`, smoke and e2e on every PR.
- A `v*` tag publishes binaries and the `ghcr.io/gunnaringe/scoreboard` image
  (`release.yml`). Nothing deploys from `main`.
- **Visible changes need screenshots**: run `make screenshots`, commit the
  changed `docs/screenshots/*.png` in the same PR, and put the affected
  images in the PR description (the template asks for them). The README
  embeds these files, so it stays current only this way. Add a shot to
  `scripts/screenshots.mjs` when a new screen is worth showing.
- Keep the README about using and running the app; architecture and
  gotchas belong here, the rating explanation in `docs/rating.md`.

## Layout

- `cmd/scoreboard` — `serve`, `admin`, `healthcheck`, `version`.
- `internal/config` — flags + env + JSON file (stdlib only); `Validate`.
- `internal/store` — SQLite (`modernc.org/sqlite`, no cgo): all queries,
  transactions and re-rating. Migrations in `internal/store/migrations/`.
- `internal/rating` — the rating model (Weng-Lin) and `Balance`. **The only
  rating implementation.**
- `internal/api` — public server: Connect service (`service.go`), JSON codec,
  static files + `/config.json` + branding routes (`static.go`), rate limiter.
- `internal/admin` — admin Connect service + CLI client.
- `internal/branding` — `--branding-dir` loader (accent CSS, manifest, index).
- `proto/` → `gen/` — protobuf definitions and generated code (checked in).
- `web/` — the frontend, vanilla JS, no build step, compiled in by `go:embed`
  (`web/assets.go`). Editing it needs a rebuild + restart to show up.
- `test/reference/rating.js` — the old JS rating model, kept only as an
  independent oracle (golden vectors, `scripts/smoke.js`). Not shipped.
- `scripts/` — `smoke.js`, `e2e.mjs`, `screenshots.mjs` (README images),
  `gen-golden.mjs`, `build-qr.sh`.
- `deploy/` — systemd unit and `docker-compose.yml`; `docs/` — screenshots
  and `rating.md`.

## The API is the app

Every UI action is an RPC in `scoreboard.v1.ScoreboardService`; the frontend
uses nothing else (`test/i18n.test.js` checks every `rpc/grpc/act('Name'` in
`web/app.js` exists in the proto). A device token (`Authorization: Bearer`)
identifies the group, so requests never carry a group id. When adding a
feature: proto first, `make gen`, handler in `internal/api/service.go`, store
method, test through the generated client, then the UI.

JSON quirks the frontend relies on (`TestJSONWireFormat` pins them):
- our `jsonCodec` emits default values (`archived:false`, `winner:0`, `[]`);
  **unset `optional` fields are omitted** — that is how "no score" differs from 0;
- int64 is a JSON string: times are `*Ms`, plus `version`; `normalize()` in
  `web/app.js` turns those keys into numbers;
- patches: proto3 `optional` = absent leaves unchanged; nested messages
  (`RoundScore`, `RoundTournament`) set when present and clear when empty;
  an empty team name resets to the localised default;
- errors are Connect codes; the frontend maps a few *messages* to translations
  (`msgRateLimited`, `msgJoinLimited`, `msgLimit` in `server.go` ↔ `ERRORS` in app.js).

## Rating

All maths is Go. The browser shows server-computed numbers: `display`,
`delta`, `today`, `provisional` (< 10 rounds = "new", unranked), win odds
(`PreviewRound`) and team suggestions (`SuggestTeams`, ≤ 14 players).
Model: Weng-Lin BT-full, sigma0 6, display `1000 + 25·(mu − sigma − 19)`, team
strength Σ(mu − 25) plus a **learned handicap per uneven format** ("2v1"…)
(see `internal/rating/rating.go`). Per game **rating speed** (`games.rating_speed`,
`rating.Speed`: steady/medium/fast = tau Mu/300, /100, /50): changing it replays
the game (`UpdateGame`). `internal/rating/testdata/golden.json` is
generated from the JS reference (`npm run golden`) and the Go package must
reproduce it exactly; the reference only knows Steady (the default), so other
speeds are covered by Go tests only.

Every change to a round (create, edit teams/winner, delete, restore) goes
through `store` in one write transaction: new rounds apply incrementally, the
others `replayGame` (recalculate from the first round, rewrite only what
changed). Rounds get strictly increasing `played_at` so replay order = write
order. `games.version` is bumped by every change; screens poll
`GetGameVersion` and reload only when it moved.

## Schema and migrations

`store.Open` creates and migrates the database at startup — nothing else does.
Migrations are numbered SQL files (`0001_init.sql`, `0002_x.sql`…), embedded,
applied in order, each in its own transaction (a failure changes nothing),
recorded in `schema_migrations` with a checksum. **Add a file for every schema
change; never edit one that has shipped** (startup refuses a changed file). A
database containing a migration the binary doesn't know (written by a newer
version) is refused. `migrations_test.go` covers upgrade, rollback, edits and
newer databases with in-memory file sets.

**Table rebuilds are safe** (the standard SQLite way to change a column: create
`x_new`, copy, `DROP TABLE x`, `ALTER TABLE x_new RENAME TO x`): the runner
applies each migration on its own connection with `PRAGMA foreign_keys = OFF`
(it can't be changed inside a transaction, so a migration file can't do it
itself), runs `PRAGMA foreign_key_check` before committing and refuses a
migration that leaves dangling references, then switches foreign keys back on.
Without that, `DROP TABLE` would run `ON DELETE CASCADE` and silently empty the
child tables (`TestTableRebuildKeepsChildRows`). Don't put `PRAGMA
foreign_keys` or `BEGIN`/`COMMIT` in a migration file.

## Modes

`--mode single`: one implicit group `main` (created at startup), no links; the
browser silently gets a device (`Join` ignores the code), the dashboard is
`/d` (token `main`), no owner actions at all — administration is the CLI. The
frontend adapts from `/config.json` (same message as `GetInstance`).
`--mode multi`: office / dashboard / owner links (see README).

## Admin

Second listener (default `127.0.0.1:8081`), `scoreboard.admin.v1.AdminService`.
Needs the `X-Scoreboard-Admin` header on every request (anti-CSRF) and the
bearer token if `--admin-token` is set (mandatory if not loopback).

## Testing

```sh
go test -race ./...     # rating golden vectors, store (random edits vs replay),
                        # migrations, API via the generated client, admin CLI
npm test                # i18n keys, no rating code in the frontend, RPC coverage
make smoke              # black-box run of scripts/smoke.js against a real server
make e2e                # browser tests, both modes (needs Chromium)
make screenshots        # regenerate docs/screenshots/ (needs Chromium)
```

`scripts/smoke.js` speaks Connect JSON and checks every stored rating, handicap
and win probability against the JS reference.

`make e2e` (`scripts/e2e.mjs`, `playwright-core` + any Chromium: `CHROME=…`)
starts the real binary and drives it in a browser: multi mode with branding
(create group, rounds, edit/delete/undo, tournament, player page, owner link,
rotated links, poster, dashboard following new rounds), operator-only group
creation in Norwegian, single mode and single mode with the dashboard off. Any
console error fails it; screenshots go to `/tmp/scoreboard-e2e`. **Frontend
changes need it** (or a manual look): the Go tests can't see rendering bugs.
Gotcha when writing selectors: `innerText` is affected by CSS
`text-transform` (headings come back upper-case; in the gamer theme buttons too).

`make screenshots` (`scripts/screenshots.mjs`) imports a made-up office with a
fixed seed through `scoreboard admin import` (so rounds span six weeks and
today has a session) and captures phone shots of the main pages, the desktop
dashboard and the leaderboard in every theme into `docs/screenshots/`. Round
times are relative to now, so the numbers are stable but times of day move.

## Themes

`[data-theme]` blocks of CSS variables in `web/styles.css`: light, dark,
hacker (green terminal, VT323) and gamer (red against blue). A new theme needs
its block, the picker in `pageAppSettings` + `theme*` strings in `i18n.js`,
`branding.go` (`defaultTheme` validation), the README, the screenshot loop and
an e2e check. Branding's accent only recolours light and dark. Team colours
are `--team-0`/`--team-1`; unnamed teams are called Blue/Orange, or Blue/Red
in the gamer theme (`defaultTeamName` in `app.js`), so keep names and colours
matching.

## Gotchas

- `go.mod` needs Go ≥ 1.26 (a dependency demands it); the Dockerfile and CI follow.
- Don't run `pkill -f 'scoreboard serve'` in a shell whose own command line
  contains that text: it kills the shell. Use a script file.
- SQLite runs in WAL with `_txlock=immediate`, so writers queue; keep write
  transactions short.
- `buf generate` needs `protoc-gen-go` and `protoc-gen-connect-go` on `PATH`
  (`go install` them); CI checks `gen/` is up to date.
- The Worker-era `wrangler.jsonc`, D1 migrations and `src/worker.js` are gone
  (see tag `worker-final`). The Cloudflare Worker `scoreboard` and D1 database
  that were set up for it are unused by this version.
