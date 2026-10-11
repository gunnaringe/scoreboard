# scoreboard

Game scores with fair team ratings, for an office. One Go binary: web server
with the frontend embedded, Connect API, SQLite, admin port and CLI. See
`README.md` for what it does and how to run it; this file is only what is easy
to get wrong. The earlier Cloudflare Workers + D1 version is the tag
`worker-final` (never deployed to production).

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
(see `internal/rating/rating.go`). `internal/rating/testdata/golden.json` is
generated from the JS reference (`npm run golden`) and the Go package must
reproduce it exactly.

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
```

`scripts/smoke.js` speaks Connect JSON and checks every stored rating, handicap
and win probability against the JS reference. Frontend changes need a real
browser check (Playwright/Chromium): the Go tests can't see rendering bugs.

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
