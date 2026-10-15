package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/gunnaringe/scoreboard/internal/rating"
)

// Player is someone who plays in a group.
type Player struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
}

// Game is something the group plays (e.g. Rocket League).
type Game struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Teams     [2]Team `json:"teams"` // team A, team B
	Archived  bool    `json:"archived"`
	CreatedAt int64   `json:"createdAt"`
	// RatingSpeed is how quickly ratings follow changes in form.
	RatingSpeed rating.Speed `json:"ratingSpeed"`
	Version     int64        `json:"-"`
}

// Tournament groups rounds of one game.
type Tournament struct {
	ID        string `json:"id"`
	GameID    string `json:"gameId"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	EndedAt   *int64 `json:"endedAt"`
}

// ---- players --------------------------------------------------------------------

// ListPlayers returns a group's players by name.
func (s *Store) ListPlayers(ctx context.Context, groupID string) ([]Player, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, archived FROM players WHERE group_id = ? ORDER BY name COLLATE NOCASE`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Player{}
	for rows.Next() {
		var p Player
		var archived int
		if err := rows.Scan(&p.ID, &p.Name, &archived); err != nil {
			return nil, err
		}
		p.Archived = archived == 1
		out = append(out, p)
	}
	return out, rows.Err()
}

// CreatePlayer adds a player. A name that is already taken (ignoring case and
// invisible characters) returns *NameTakenError with the existing player, so
// callers can use that one instead.
func (s *Store) CreatePlayer(ctx context.Context, groupID, name string) (Player, error) {
	name, err := CleanName(name, "player name")
	if err != nil {
		return Player{}, err
	}
	var existing Player
	var archived int
	err = s.db.QueryRowContext(ctx, `SELECT id, name, archived FROM players WHERE group_id = ? AND name_key = ?`, groupID, nameKey(name)).
		Scan(&existing.ID, &existing.Name, &archived)
	if err == nil {
		existing.Archived = archived == 1
		return Player{}, &NameTakenError{Existing: existing}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Player{}, err
	}
	p := Player{ID: newID(), Name: name}
	err = s.write(ctx, func(tx *sql.Tx) error {
		n, err := count(ctx, tx, `SELECT COUNT(*) FROM players WHERE group_id = ?`, groupID)
		if err != nil {
			return err
		}
		if n >= s.Limits.Players {
			return ErrLimit
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO players (id, group_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)`,
			p.ID, groupID, name, nameKey(name), s.nowMs())
		return err
	})
	return p, err
}

// PlayerPatch changes a player; nil fields stay as they are.
type PlayerPatch struct {
	Name     *string
	Archived *bool
}

// UpdatePlayer renames or archives a player.
func (s *Store) UpdatePlayer(ctx context.Context, groupID, playerID string, patch PlayerPatch) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		n, err := count(ctx, tx, `SELECT COUNT(*) FROM players WHERE id = ? AND group_id = ?`, playerID, groupID)
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		if patch.Name != nil {
			name, err := CleanName(*patch.Name, "player name")
			if err != nil {
				return err
			}
			var other string
			err = tx.QueryRowContext(ctx, `SELECT id FROM players WHERE group_id = ? AND name_key = ? AND id != ?`, groupID, nameKey(name), playerID).Scan(&other)
			if err == nil {
				return &NameTakenError{}
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE players SET name = ?, name_key = ? WHERE id = ?`, name, nameKey(name), playerID); err != nil {
				return err
			}
		}
		if patch.Archived != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE players SET archived = ? WHERE id = ?`, b2i(*patch.Archived), playerID); err != nil {
				return err
			}
		}
		return nil
	})
}

// ---- games ----------------------------------------------------------------------------

// Team is one side of a game. An empty Name means it goes by its colour.
type Team struct {
	Name  string `json:"name"`
	Color string `json:"color"` // one of TeamColors
}

// TeamColors are the colours a team can have; the frontend has a shade of each
// per theme and a name for each per language.
var TeamColors = []string{"blue", "orange", "red", "green", "purple", "yellow", "pink", "teal"}

// DefaultTeamColors are a new game's colours (team A, team B).
var DefaultTeamColors = [2]string{"blue", "orange"}

// cleanTeams checks a game's two teams: names are optional, colours must be
// known (empty takes `fallback`'s) and different.
func cleanTeams(teams, fallback [2]Team) ([2]Team, error) {
	for i := range teams {
		name, err := optionalName(&teams[i].Name, "team name")
		if err != nil {
			return teams, err
		}
		teams[i].Name = ""
		if name != nil {
			teams[i].Name = *name
		}
		if teams[i].Color == "" {
			teams[i].Color = fallback[i].Color
		}
		if !slices.Contains(TeamColors, teams[i].Color) {
			return teams, BadRequest(fmt.Sprintf("unknown team colour %q", teams[i].Color))
		}
	}
	if teams[0].Color == teams[1].Color {
		return teams, BadRequest("the two teams need different colours")
	}
	return teams, nil
}

const gameCols = `id, name, team_a, team_b, team_a_color, team_b_color, archived, created_at, version, rating_speed`

func scanGame(row interface{ Scan(...any) error }) (Game, error) {
	var g Game
	var a, b sql.NullString
	var archived int
	var speed string
	if err := row.Scan(&g.ID, &g.Name, &a, &b, &g.Teams[0].Color, &g.Teams[1].Color, &archived, &g.CreatedAt, &g.Version, &speed); err != nil {
		return Game{}, notFoundIf(err)
	}
	g.RatingSpeed, _ = rating.ParseSpeed(speed)
	g.Archived = archived == 1
	g.Teams[0].Name, g.Teams[1].Name = a.String, b.String
	return g, nil
}

// ListGames returns a group's games in the order they were made.
func (s *Store) ListGames(ctx context.Context, groupID string) ([]Game, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+gameCols+` FROM games WHERE group_id = ? ORDER BY created_at, id`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Game{}
	for rows.Next() {
		g, err := scanGame(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetGame returns a game if it belongs to the group.
func (s *Store) GetGame(ctx context.Context, groupID, gameID string) (Game, error) {
	return scanGame(s.db.QueryRowContext(ctx, `SELECT `+gameCols+` FROM games WHERE id = ? AND group_id = ?`, gameID, groupID))
}

// CreateGame adds a game. Team names are optional (a team goes by its colour);
// empty colours are the defaults, blue and orange.
func (s *Store) CreateGame(ctx context.Context, groupID, name string, teams [2]Team) (Game, error) {
	name, err := CleanName(name, "game name")
	if err != nil {
		return Game{}, err
	}
	if teams, err = cleanTeams(teams, [2]Team{{Color: DefaultTeamColors[0]}, {Color: DefaultTeamColors[1]}}); err != nil {
		return Game{}, err
	}
	g := Game{ID: newID(), Name: name, Teams: teams, CreatedAt: s.nowMs(), RatingSpeed: rating.Steady}
	err = s.write(ctx, func(tx *sql.Tx) error {
		n, err := count(ctx, tx, `SELECT COUNT(*) FROM games WHERE group_id = ?`, groupID)
		if err != nil {
			return err
		}
		if n >= s.Limits.Games {
			return ErrLimit
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO games (id, group_id, name, team_a, team_b, team_a_color, team_b_color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			g.ID, groupID, name, nullIfEmpty(teams[0].Name), nullIfEmpty(teams[1].Name), teams[0].Color, teams[1].Color, g.CreatedAt)
		return err
	})
	return g, err
}

// GamePatch changes a game. A team that is set replaces its name (empty: it
// goes by its colour) and, unless empty, its colour.
type GamePatch struct {
	Name     *string
	Teams    [2]*Team
	Archived *bool
	// RatingSpeed: a change re-rates the whole game.
	RatingSpeed *string
}

// UpdateGame applies a patch.
func (s *Store) UpdateGame(ctx context.Context, groupID, gameID string, p GamePatch) error {
	game, err := s.GetGame(ctx, groupID, gameID)
	if err != nil {
		return err
	}
	var sets []string
	var args []any
	if p.Name != nil {
		name, err := CleanName(*p.Name, "game name")
		if err != nil {
			return err
		}
		sets, args = append(sets, "name = ?"), append(args, name)
	}
	if p.Teams[0] != nil || p.Teams[1] != nil {
		teams := game.Teams
		for i, t := range p.Teams {
			if t != nil {
				teams[i] = Team{Name: t.Name, Color: t.Color}
			}
		}
		if teams, err = cleanTeams(teams, game.Teams); err != nil {
			return err
		}
		sets = append(sets, "team_a = ?", "team_b = ?", "team_a_color = ?", "team_b_color = ?")
		args = append(args, nullIfEmpty(teams[0].Name), nullIfEmpty(teams[1].Name), teams[0].Color, teams[1].Color)
	}
	if p.Archived != nil {
		sets, args = append(sets, "archived = ?"), append(args, b2i(*p.Archived))
	}
	var speed rating.Speed
	if p.RatingSpeed != nil {
		var ok bool
		if speed, ok = rating.ParseSpeed(*p.RatingSpeed); !ok || *p.RatingSpeed == "" {
			return BadRequest("rating speed must be steady, medium or fast")
		}
		sets, args = append(sets, "rating_speed = ?"), append(args, string(speed))
	}
	if len(sets) == 0 {
		return nil
	}
	return s.write(ctx, func(tx *sql.Tx) error {
		rerate := false
		if speed != "" {
			current, err := gameSpeed(ctx, tx, gameID)
			if err != nil {
				return err
			}
			rerate = speed != current
		}
		if _, err := tx.ExecContext(ctx, `UPDATE games SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, gameID)...); err != nil {
			return err
		}
		if !rerate {
			return nil
		}
		if err := s.replayGame(ctx, tx, gameID); err != nil {
			return err
		}
		return bumpVersion(ctx, tx, gameID)
	})
}

// gameSpeed is the rating speed a game's rounds are rated with.
func gameSpeed(ctx context.Context, q queryer, gameID string) (rating.Speed, error) {
	var v string
	if err := q.QueryRowContext(ctx, `SELECT rating_speed FROM games WHERE id = ?`, gameID).Scan(&v); err != nil {
		return "", notFoundIf(err)
	}
	speed, _ := rating.ParseSpeed(v)
	return speed, nil
}

// GameVersion is the cheap change counter polling screens ask for.
func (s *Store) GameVersion(ctx context.Context, groupID, gameID string) (int64, error) {
	var v int64
	err := s.db.QueryRowContext(ctx, `SELECT version FROM games WHERE id = ? AND group_id = ?`, gameID, groupID).Scan(&v)
	return v, notFoundIf(err)
}

// ---- tournaments --------------------------------------------------------------------------

const tournamentCols = `id, game_id, name, created_at, ended_at`

func scanTournament(row interface{ Scan(...any) error }) (Tournament, error) {
	var t Tournament
	var ended sql.NullInt64
	if err := row.Scan(&t.ID, &t.GameID, &t.Name, &t.CreatedAt, &ended); err != nil {
		return Tournament{}, notFoundIf(err)
	}
	if ended.Valid {
		t.EndedAt = &ended.Int64
	}
	return t, nil
}

// ListTournaments returns a game's tournaments, newest first (at most limit).
func (s *Store) ListTournaments(ctx context.Context, gameID string, limit int) ([]Tournament, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+tournamentCols+` FROM tournaments WHERE game_id = ? ORDER BY created_at DESC, id LIMIT ?`, gameID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Tournament{}
	for rows.Next() {
		t, err := scanTournament(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// CreateTournament starts a tournament in a game.
func (s *Store) CreateTournament(ctx context.Context, groupID, gameID, name string) (Tournament, error) {
	if _, err := s.GetGame(ctx, groupID, gameID); err != nil {
		return Tournament{}, err
	}
	name, err := CleanName(name, "tournament name")
	if err != nil {
		return Tournament{}, err
	}
	t := Tournament{ID: newID(), GameID: gameID, Name: name, CreatedAt: s.nowMs()}
	err = s.write(ctx, func(tx *sql.Tx) error {
		n, err := count(ctx, tx, `SELECT COUNT(*) FROM tournaments WHERE game_id = ?`, gameID)
		if err != nil {
			return err
		}
		if n >= s.Limits.Tournaments {
			return ErrLimit
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO tournaments (id, game_id, name, created_at) VALUES (?, ?, ?, ?)`, t.ID, gameID, name, t.CreatedAt)
		return err
	})
	return t, err
}

// TournamentPatch changes a tournament; Ended true ends it, false reopens it.
type TournamentPatch struct {
	Name  *string
	Ended *bool
}

// UpdateTournament renames, ends or reopens a tournament.
func (s *Store) UpdateTournament(ctx context.Context, groupID, tournamentID string, p TournamentPatch) error {
	var gid string
	err := s.db.QueryRowContext(ctx, `SELECT g.group_id FROM tournaments t JOIN games g ON g.id = t.game_id WHERE t.id = ?`, tournamentID).Scan(&gid)
	if err != nil || gid != groupID {
		return ErrNotFound
	}
	var sets []string
	var args []any
	if p.Name != nil {
		name, err := CleanName(*p.Name, "tournament name")
		if err != nil {
			return err
		}
		sets, args = append(sets, "name = ?"), append(args, name)
	}
	if p.Ended != nil {
		var ended any
		if *p.Ended {
			ended = s.nowMs()
		}
		sets, args = append(sets, "ended_at = ?"), append(args, ended)
	}
	if len(sets) == 0 {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `UPDATE tournaments SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, tournamentID)...)
	return err
}
