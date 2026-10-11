# Scoreboard

Game scores with fair team ratings, for an office: a long-running daily Rocket
League game, table tennis, anything with two teams. One Go binary with the web
app inside; SQLite for storage; no accounts.

- **Groups, games, rounds, tournaments.** A round has one or more players per
  team, a winner and an optional score. Tournaments are optional.
- **Fair ratings for teams.** Weng-Lin (Bradley-Terry), a TrueSkill-style model
  built for teams. Uneven teams (2 against 1) work: the app learns how much the
  extra player is worth. New players are listed apart until they have played 10
  rounds. All the maths runs on the server.
- **Fast to use** on a phone: the round sheet opens with the last line-up,
  tapping who won saves it, Undo fixes mistakes. Win odds and "balance teams"
  come from the server.
- **Wall screen:** a read-only dashboard that updates itself.
- Themes (auto, light, dark, hacker), English and Norwegian, installable (PWA).
- **Everything the app does is a [Connect](https://connectrpc.com) API**
  (`proto/scoreboard/v1`), so scripts and other clients can do it too.

## Run it

```sh
go build -o scoreboard ./cmd/scoreboard        # or: make build
./scoreboard serve --mode single               # http://localhost:8080
```

or with Docker (image `ghcr.io/gunnaringe/scoreboard` once released):

```sh
docker run -d -p 8080:8080 -v scoreboard-data:/data -e SCOREBOARD_MODE=single ghcr.io/gunnaringe/scoreboard
```

The schema is created and migrated when the server starts; there is nothing to
set up. Back up with `scoreboard admin backup <file>` (safe while running), or
copy the SQLite file.

## Two modes

| | `--mode single` | `--mode multi` (default) |
|---|---|---|
| For | one office or location | several, e.g. a hosted instance |
| Joining | open the address; no links, no codes | office link / code / QR poster |
| Dashboard | `/d` (can be switched off) | `/d/<secret>` per group |
| Who administers | the operator, with `scoreboard admin` | owners, with the owner link; operator with the CLI |
| Creating groups | — (one implicit group) | in the app, or only by the operator (`--allow-group-creation=false`) |

In **single** mode anyone who can reach the address can log and edit rounds,
so keep it on a LAN, VPN or behind your access proxy.

In **multi** mode each group has three secret links:

- **office link** `/j/ABCD-EFGH` (with a QR poster to print): anyone with it
  joins and can log and edit rounds, add players and games;
- **dashboard link** `/d/<token>`: read-only, for a wall screen or TV;
- **owner link** `/o/<token>`: makes a device an owner, who can replace any of
  the three links (the old one stops working), rename or delete the group and
  remove devices. It is shown once; if it is lost, `scoreboard admin links
  rotate owner` makes a new one.

## Settings

Flags, environment variables or a JSON file (`--config`); later wins:
defaults → file → environment → flags. `scoreboard serve -h` lists them all.

| Flag | Environment | Default | |
|---|---|---|---|
| `--mode` | `SCOREBOARD_MODE` | `multi` | `single` or `multi` |
| `--listen` | `SCOREBOARD_LISTEN` | `:8080` | the web server |
| `--db` | `SCOREBOARD_DB` | `scoreboard.db` | SQLite file |
| `--public-url` | `SCOREBOARD_PUBLIC_URL` | `http://localhost:8080` | used by the CLI when it prints links |
| `--admin-listen` | `SCOREBOARD_ADMIN_LISTEN` | `127.0.0.1:8081` | admin port; empty disables it |
| `--admin-token` | `SCOREBOARD_ADMIN_TOKEN` | | required if the admin port is not loopback |
| `--allow-group-creation` | `SCOREBOARD_ALLOW_GROUP_CREATION` | `true` | multi: `=false` for operator-only |
| `--dashboard` | `SCOREBOARD_DASHBOARD` | `open` | single: `open` or `off` |
| `--group-name` | `SCOREBOARD_GROUP_NAME` | `Scoreboard` | single: the group's name at first start |
| `--branding-dir` | `SCOREBOARD_BRANDING_DIR` | | custom branding, below |
| `--trust-proxy` | `SCOREBOARD_TRUST_PROXY` | `false` | take client IPs from `X-Forwarded-For` / `CF-Connecting-IP` |
| `--join-limit` | `SCOREBOARD_JOIN_LIMIT` | `100` | joins etc. per IP and minute (0 = unlimited) |
| `--write-limit` | `SCOREBOARD_WRITE_LIMIT` | `60` | changes per device and minute |

## Custom branding

Point `--branding-dir` at a directory; every file is optional:

```
branding.json   {"name": "Acme Games", "shortName": "Acme", "accent": "#e4572e",
                 "defaultTheme": "dark", "defaultLanguage": "no", "footer": "Made at Acme"}
logo.svg        top bar, poster, dashboard (also logo.png / logo.webp)
favicon.png     browser tab icon
custom.css      appended to the stylesheet
```

The name, short name and logo also go into the page title and the web app
manifest. The accent recolours the light and dark themes (readable text colour
is chosen for you); the hacker theme stays green. Changes need a restart.

## Administering a running server

The admin port is a second Connect service (`proto/scoreboard/admin/v1`) on
`127.0.0.1:8081`; `scoreboard admin` is its CLI. In a container:
`docker exec <container> /scoreboard admin …`.

```sh
scoreboard admin stats
scoreboard admin groups list | create <name> | rename <new name> | delete --yes
scoreboard admin links show                      # office + dashboard links
scoreboard admin links rotate office|dashboard|owner
scoreboard admin devices list | owner <id> [--off] | remove <id>
scoreboard admin players list | rename <player> <new name> | archive <player> | merge <from> <into>
scoreboard admin games list | rename … | archive … | recalc
scoreboard admin export -o group.json            # a group as JSON
scoreboard admin import group.json --name "Copy" # ratings are recalculated
scoreboard admin backup /var/backups/scoreboard.db
```

Add `--group <id or name>` when there is more than one group, and `--json` for
the raw answer. Every request must carry an `X-Scoreboard-Admin` header (a web
page cannot send one, so a page in your browser can't reach the port) and the
admin token if one is set.

## The API

Everything the web app does goes through `scoreboard.v1.ScoreboardService`
(see `proto/scoreboard/v1/scoreboard.proto`, with comments on every call), as
Connect's JSON over plain POST. A device token (from `Join` / `CreateGroup`)
goes in `Authorization: Bearer …`:

```sh
curl -s localhost:8080/scoreboard.v1.ScoreboardService/GetGroup \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d '{}'
```

Times are Unix milliseconds in `*Ms` fields (JSON renders int64 as strings);
unset optional fields are left out. Typed Go clients are in `gen/`.

## Development

```sh
make test        # go test ./... and the frontend tests
make smoke       # end-to-end check against a throwaway server
make check       # what CI runs
make gen         # regenerate gen/ after editing proto/ (needs buf)
```

`CLAUDE.md` has the architecture and the things worth knowing before changing
it. The previous Cloudflare Workers + D1 version is the git tag `worker-final`.
