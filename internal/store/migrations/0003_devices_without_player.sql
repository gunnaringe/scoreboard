-- Devices are no longer tied to a player ("who are you"): screens are shared.
-- A table rebuild, because player_id has a foreign key (see the runner).
CREATE TABLE devices_new (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    -- Opened the owner link: may make new links, rename/delete the group, remove devices.
    is_owner INTEGER NOT NULL DEFAULT 0,
    label TEXT, -- e.g. "iPhone · Safari", from the User-Agent at join
    created_at INTEGER NOT NULL,
    last_seen INTEGER
);
INSERT INTO devices_new (id, token_hash, group_id, is_owner, label, created_at, last_seen)
    SELECT id, token_hash, group_id, is_owner, label, created_at, last_seen FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
CREATE INDEX devices_group ON devices(group_id);
