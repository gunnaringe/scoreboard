-- How quickly a game's ratings follow changes in form: steady, medium or fast
-- (rating.Speed). Existing games keep the behaviour they were rated with.
ALTER TABLE games ADD COLUMN rating_speed TEXT NOT NULL DEFAULT 'steady';
