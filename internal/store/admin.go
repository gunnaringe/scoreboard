package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/gunnaringe/scoreboard/internal/rating"
)

// MergePlayers moves everything of player `from` onto `into` (the same person
// entered twice), deletes `from` and re-rates the group's games. They must
// never have played in the same round.
func (s *Store) MergePlayers(ctx context.Context, groupID, from, into string) error {
	if from == into {
		return BadRequest("pick two different players")
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		n, err := count(ctx, tx, `SELECT COUNT(*) FROM players WHERE group_id = ? AND id IN (?, ?)`, groupID, from, into)
		if err != nil {
			return err
		}
		if n != 2 {
			return ErrNotFound
		}
		both, err := count(ctx, tx, `SELECT COUNT(*) FROM round_players a JOIN round_players b ON a.round_id = b.round_id WHERE a.player_id = ? AND b.player_id = ?`, from, into)
		if err != nil {
			return err
		}
		if both > 0 {
			return BadRequest("they played in the same round, so they are two people")
		}
		for _, q := range []string{
			`UPDATE round_players SET player_id = ?2 WHERE player_id = ?1`,
			`DELETE FROM players WHERE id = ?1`,
		} {
			if _, err := tx.ExecContext(ctx, q, from, into); err != nil {
				return err
			}
		}
		return s.replayGroup(ctx, tx, groupID)
	})
}

func (s *Store) replayGroup(ctx context.Context, tx *sql.Tx, groupID string) error {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM games WHERE group_id = ?`, groupID)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		if err := s.replayGame(ctx, tx, id); err != nil {
			return err
		}
		if err := bumpVersion(ctx, tx, id); err != nil {
			return err
		}
	}
	return nil
}

// Stats is a summary of the whole instance.
type Stats struct {
	Groups, Players, Games, Rounds, Devices int
	DatabaseBytes                           int64
}

// GetStats counts what the database holds.
func (s *Store) GetStats(ctx context.Context) (Stats, error) {
	var st Stats
	for _, c := range []struct {
		dst *int
		q   string
	}{
		{&st.Groups, `SELECT COUNT(*) FROM groups`},
		{&st.Players, `SELECT COUNT(*) FROM players`},
		{&st.Games, `SELECT COUNT(*) FROM games`},
		{&st.Rounds, `SELECT COUNT(*) FROM rounds WHERE deleted_at IS NULL`},
		{&st.Devices, `SELECT COUNT(*) FROM devices`},
	} {
		if err := s.db.QueryRowContext(ctx, c.q).Scan(c.dst); err != nil {
			return st, err
		}
	}
	err := s.db.QueryRowContext(ctx, `SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size)`).Scan(&st.DatabaseBytes)
	return st, err
}

// Backup writes a consistent copy of the database to path (which must not
// exist), safe to run while the server is serving.
func (s *Store) Backup(ctx context.Context, path string) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("%s already exists", path)
	}
	_, err := s.db.ExecContext(ctx, `VACUUM INTO '`+strings.ReplaceAll(path, `'`, `''`)+`'`)
	return err
}

// ---- export / import ------------------------------------------------------------------

// ExportFormat is the version of the export file.
const ExportFormat = 1

// ExportedGroup is a group as plain data, for moving between instances.
type ExportedGroup struct {
	Format  int            `json:"format"`
	Name    string         `json:"name"`
	Players []ExportPlayer `json:"players"`
	Games   []ExportGame   `json:"games"`
}

type ExportPlayer struct {
	Name     string `json:"name"`
	Archived bool   `json:"archived,omitempty"`
}

type ExportGame struct {
	Name        string             `json:"name"`
	TeamA       *string            `json:"teamA,omitempty"`
	TeamB       *string            `json:"teamB,omitempty"`
	TeamAColor  string             `json:"teamAColor,omitempty"` // absent: blue
	TeamBColor  string             `json:"teamBColor,omitempty"` // absent: orange
	Archived    bool               `json:"archived,omitempty"`
	RatingSpeed string             `json:"ratingSpeed,omitempty"` // absent: steady
	Tournaments []ExportTournament `json:"tournaments,omitempty"`
	Rounds      []ExportRound      `json:"rounds"`
}

type ExportTournament struct {
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	EndedAt   *int64 `json:"endedAt,omitempty"`
}

type ExportRound struct {
	PlayedAt   int64       `json:"playedAt"`
	Winner     int         `json:"winner"`
	ScoreA     *int        `json:"scoreA,omitempty"`
	ScoreB     *int        `json:"scoreB,omitempty"`
	Tournament string      `json:"tournament,omitempty"`
	Teams      [2][]string `json:"teams"` // player names
}

// Export returns a group's players, games, tournaments and (non-deleted)
// rounds. Ratings are not exported: importing recalculates them.
func (s *Store) Export(ctx context.Context, groupID string) (ExportedGroup, error) {
	g, err := s.GetGroup(ctx, groupID)
	if err != nil {
		return ExportedGroup{}, err
	}
	out := ExportedGroup{Format: ExportFormat, Name: g.Name, Players: []ExportPlayer{}, Games: []ExportGame{}}
	players, err := s.ListPlayers(ctx, groupID)
	if err != nil {
		return out, err
	}
	names := map[string]string{}
	for _, p := range players {
		out.Players = append(out.Players, ExportPlayer{p.Name, p.Archived})
		names[p.ID] = p.Name
	}
	games, err := s.ListGames(ctx, groupID)
	if err != nil {
		return out, err
	}
	for _, game := range games {
		eg := ExportGame{Name: game.Name, Archived: game.Archived, Rounds: []ExportRound{},
			TeamAColor: game.Teams[0].Color, TeamBColor: game.Teams[1].Color}
		if game.Teams[0].Name != "" {
			eg.TeamA = &game.Teams[0].Name
		}
		if game.Teams[1].Name != "" {
			eg.TeamB = &game.Teams[1].Name
		}
		if game.RatingSpeed != rating.Steady {
			eg.RatingSpeed = string(game.RatingSpeed)
		}
		tours, err := s.ListTournaments(ctx, game.ID, 1<<30)
		if err != nil {
			return out, err
		}
		tourNames := map[string]string{}
		for i := len(tours) - 1; i >= 0; i-- { // oldest first
			t := tours[i]
			eg.Tournaments = append(eg.Tournaments, ExportTournament{t.Name, t.CreatedAt, t.EndedAt})
			tourNames[t.ID] = t.Name
		}
		cursor := ""
		var rounds []Round
		for {
			page, next, err := s.ListRounds(ctx, groupID, game.ID, RoundFilter{Before: cursor, Limit: 200})
			if err != nil {
				return out, err
			}
			rounds = append(rounds, page...)
			if next == "" {
				break
			}
			cursor = next
		}
		for i := len(rounds) - 1; i >= 0; i-- { // oldest first
			r := rounds[i]
			er := ExportRound{PlayedAt: r.PlayedAt, Winner: r.Winner, ScoreA: r.ScoreA, ScoreB: r.ScoreB}
			if r.TournamentID != nil {
				er.Tournament = tourNames[*r.TournamentID]
			}
			for _, p := range r.Players {
				er.Teams[p.Team] = append(er.Teams[p.Team], names[p.ID])
			}
			eg.Rounds = append(eg.Rounds, er)
		}
		out.Games = append(out.Games, eg)
	}
	return out, nil
}

// Import creates a new group from an export and recalculates every rating.
// name overrides the exported group name when not empty.
func (s *Store) Import(ctx context.Context, in ExportedGroup, name string) (CreatedGroup, error) {
	if in.Format != ExportFormat {
		return CreatedGroup{}, BadRequest(fmt.Sprintf("unsupported export format %d", in.Format))
	}
	if name == "" {
		name = in.Name
	}
	created, err := s.CreateGroup(ctx, name, "", "", false, "")
	if err != nil {
		return created, err
	}
	err = s.write(ctx, func(tx *sql.Tx) error {
		now := s.nowMs()
		ids := map[string]string{}
		for _, p := range in.Players {
			clean, err := CleanName(p.Name, "player name")
			if err != nil {
				return err
			}
			id := newID()
			ids[clean] = id
			if _, err := tx.ExecContext(ctx, `INSERT INTO players (id, group_id, name, name_key, archived, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
				id, created.Group.ID, clean, nameKey(clean), b2i(p.Archived), now); err != nil {
				return fmt.Errorf("player %q: %w", p.Name, err)
			}
		}
		for _, g := range in.Games {
			gname, err := CleanName(g.Name, "game name")
			if err != nil {
				return err
			}
			speed, ok := rating.ParseSpeed(g.RatingSpeed)
			if !ok {
				return BadRequest(fmt.Sprintf("game %q: unknown rating speed %q", g.Name, g.RatingSpeed))
			}
			var teams [2]Team
			for i, t := range [2]struct {
				name  *string
				color string
			}{{g.TeamA, g.TeamAColor}, {g.TeamB, g.TeamBColor}} {
				teams[i].Color = t.color
				if t.name != nil {
					teams[i].Name = *t.name
				}
			}
			if teams, err = cleanTeams(teams, [2]Team{{Color: DefaultTeamColors[0]}, {Color: DefaultTeamColors[1]}}); err != nil {
				return BadRequest(fmt.Sprintf("game %q: %v", g.Name, err))
			}
			gid := newID()
			if _, err := tx.ExecContext(ctx, `INSERT INTO games (id, group_id, name, team_a, team_b, team_a_color, team_b_color, archived, created_at, rating_speed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				gid, created.Group.ID, gname, nullIfEmpty(teams[0].Name), nullIfEmpty(teams[1].Name), teams[0].Color, teams[1].Color, b2i(g.Archived), now, string(speed)); err != nil {
				return err
			}
			tours := map[string]string{}
			for _, t := range g.Tournaments {
				tid := newID()
				tours[t.Name] = tid
				if _, err := tx.ExecContext(ctx, `INSERT INTO tournaments (id, game_id, name, created_at, ended_at) VALUES (?, ?, ?, ?, ?)`, tid, gid, t.Name, t.CreatedAt, t.EndedAt); err != nil {
					return err
				}
			}
			sort.SliceStable(g.Rounds, func(i, j int) bool { return g.Rounds[i].PlayedAt < g.Rounds[j].PlayedAt })
			for _, r := range g.Rounds {
				if r.Winner != 0 && r.Winner != 1 {
					return BadRequest("a round has no winner")
				}
				var tour any
				if r.Tournament != "" {
					if id, ok := tours[r.Tournament]; ok {
						tour = id
					}
				}
				rid := newID()
				if _, err := tx.ExecContext(ctx, `INSERT INTO rounds (id, game_id, tournament_id, played_at, winner, score_a, score_b) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					rid, gid, tour, r.PlayedAt, r.Winner, r.ScoreA, r.ScoreB); err != nil {
					return err
				}
				for t, team := range r.Teams {
					for _, pname := range team {
						pid, ok := ids[pname]
						if !ok {
							return BadRequest(fmt.Sprintf("round with unknown player %q", pname))
						}
						if _, err := tx.ExecContext(ctx, `INSERT INTO round_players (round_id, player_id, team) VALUES (?, ?, ?)`, rid, pid, t); err != nil {
							return fmt.Errorf("round of %q: %w", pname, err)
						}
					}
				}
			}
		}
		return s.replayGroup(ctx, tx, created.Group.ID)
	})
	if err != nil {
		_ = s.DeleteGroup(ctx, created.Group.ID)
		return CreatedGroup{}, err
	}
	return created, nil
}

// Ping checks that the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }
