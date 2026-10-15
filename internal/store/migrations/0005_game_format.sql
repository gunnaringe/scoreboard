-- A game is played in teams (any size, uneven allowed) or one against one.
-- Existing games keep teams.
ALTER TABLE games ADD COLUMN format TEXT NOT NULL DEFAULT 'teams';
