-- Times are Unix milliseconds. IDs are random URL-safe strings.

CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    -- 1: every device in the group is an admin (the default; office trust).
    everyone_admin INTEGER NOT NULL DEFAULT 1,
    -- SHA-256 of the admin recovery token; opening /r/<token> makes a device admin.
    recovery_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE players (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- Normalised name (NFKC, lower case, no invisible characters) for uniqueness.
    name_key TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (group_id, name_key)
);

-- A device is a browser that joined with the invite code. Only the SHA-256 of
-- its token is stored.
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    label TEXT, -- e.g. "iPhone · Safari", from the User-Agent at join
    created_at INTEGER NOT NULL,
    last_seen INTEGER -- updated at most once a day
);
CREATE INDEX devices_group ON devices(group_id);

CREATE TABLE games (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- NULL: the localised default (Blue/Orange, Blå/Oransje).
    team_a TEXT,
    team_b TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    -- Bumped by every rating write; a stale batch fails instead of losing an update.
    version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX games_group ON games(group_id);

CREATE TABLE tournaments (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
);
CREATE INDEX tournaments_game ON tournaments(game_id);

CREATE TABLE rounds (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    tournament_id TEXT REFERENCES tournaments(id) ON DELETE SET NULL,
    played_at INTEGER NOT NULL,
    winner INTEGER NOT NULL, -- 0 = team A, 1 = team B
    score_a INTEGER,
    score_b INTEGER,
    created_by TEXT, -- device id
    deleted_at INTEGER,
    -- Uneven rounds ("2v1"): the format's handicap before/after this round.
    format TEXT,
    h_mu_before REAL, h_sigma_before REAL,
    h_mu_after REAL, h_sigma_after REAL
);
CREATE INDEX rounds_game ON rounds(game_id, played_at);
CREATE INDEX rounds_tournament ON rounds(tournament_id);

-- Ratings before/after each round are stored so history, deltas and
-- tournament standings never need a replay.
CREATE TABLE round_players (
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    team INTEGER NOT NULL,
    mu_before REAL, sigma_before REAL,
    mu_after REAL, sigma_after REAL,
    PRIMARY KEY (round_id, player_id)
);
CREATE INDEX round_players_player ON round_players(player_id);

-- Current rating per player per game: the leaderboard reads only this.
CREATE TABLE ratings (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    mu REAL NOT NULL,
    sigma REAL NOT NULL,
    rounds INTEGER NOT NULL,
    wins INTEGER NOT NULL,
    PRIMARY KEY (game_id, player_id)
);

-- Learned advantage of the bigger team per uneven format ("2v1", "3v2", ...).
CREATE TABLE handicaps (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    format TEXT NOT NULL,
    mu REAL NOT NULL,
    sigma REAL NOT NULL,
    PRIMARY KEY (game_id, format)
);
