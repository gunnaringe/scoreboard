-- Times are Unix milliseconds. IDs are random URL-safe strings.

CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    -- 1: every device in the group is an admin.
    everyone_admin INTEGER NOT NULL DEFAULT 0,
    -- 'anyone': any member may edit/delete any round. 'admin': only admins
    -- (and the device that logged it) may.
    edit_policy TEXT NOT NULL DEFAULT 'anyone',
    created_at INTEGER NOT NULL
);

CREATE TABLE players (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX players_group ON players(group_id);

-- A device is a browser that joined with the invite code. Only the SHA-256 of
-- its token is stored.
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX devices_group ON devices(group_id);

CREATE TABLE games (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    team_a TEXT NOT NULL DEFAULT 'Blue',
    team_b TEXT NOT NULL DEFAULT 'Orange',
    archived INTEGER NOT NULL DEFAULT 0,
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
    deleted_at INTEGER
);
CREATE INDEX rounds_game ON rounds(game_id, played_at);
CREATE INDEX rounds_tournament ON rounds(tournament_id);

-- Ratings before/after each round are stored so history, deltas and
-- tournament standings never need a replay. Rewritten by replays.
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
    last_played INTEGER NOT NULL,
    PRIMARY KEY (game_id, player_id)
);
