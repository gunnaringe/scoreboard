-- Each team has a colour (store.TeamColors); existing games keep blue and orange.
ALTER TABLE games ADD COLUMN team_a_color TEXT NOT NULL DEFAULT 'blue';
ALTER TABLE games ADD COLUMN team_b_color TEXT NOT NULL DEFAULT 'orange';
