package store

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/gunnaringe/scoreboard/internal/rating"
)

const maxTeam = 8

// RoundPlayer is one player's part in a round.
type RoundPlayer struct {
	ID     string         `json:"id"`
	Team   int            `json:"team"`
	Before *rating.Rating `json:"before"`
	After  *rating.Rating `json:"after"`
	Delta  int            `json:"delta"` // display points gained or lost
}

// Round is one match.
type Round struct {
	ID           string        `json:"id"`
	GameID       string        `json:"gameId"`
	TournamentID *string       `json:"tournamentId"`
	PlayedAt     int64         `json:"playedAt"`
	Winner       int           `json:"winner"`
	ScoreA       *int          `json:"scoreA"`
	ScoreB       *int          `json:"scoreB"`
	CreatedBy    *string       `json:"createdBy"`
	Deleted      bool          `json:"deleted"`
	Players      []RoundPlayer `json:"players"`
}

// RoundInput is a new round: the players of each team and who won.
type RoundInput struct {
	Teams        [2][]string
	Winner       int
	ScoreA       *int
	ScoreB       *int
	TournamentID *string
}

// RoundPatch changes a round. Changing teams or winner re-rates the game.
type RoundPatch struct {
	Teams        *[2][]string
	Winner       *int
	ScoreA       Nullable[int]
	ScoreB       Nullable[int]
	TournamentID Nullable[string]
}

func checkScore(v *int) error {
	if v != nil && (*v < 0 || *v > 999) {
		return BadRequest("invalid score")
	}
	return nil
}

// validateTeams checks both teams and returns copies sorted by id (so sums are
// always taken in the same order).
func validateTeams(ctx context.Context, q queryer, groupID string, teams [2][]string) ([2][]string, error) {
	var out [2][]string
	seen := map[string]bool{}
	var all []string
	for i, team := range teams {
		if len(team) < 1 {
			return out, BadRequest("each team needs a player")
		}
		if len(team) > maxTeam {
			return out, BadRequest("team too large")
		}
		for _, id := range team {
			if id == "" || seen[id] {
				return out, BadRequest("invalid players")
			}
			seen[id] = true
			all = append(all, id)
		}
		out[i] = append([]string(nil), team...)
		sort.Strings(out[i])
	}
	args := []any{groupID}
	for _, id := range all {
		args = append(args, id)
	}
	n, err := count(ctx, q, `SELECT COUNT(*) FROM players WHERE group_id = ? AND id IN (`+placeholders(len(all))+`)`, args...)
	if err != nil {
		return out, err
	}
	if n != len(all) {
		return out, BadRequest("unknown player")
	}
	return out, nil
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func checkTournament(ctx context.Context, q queryer, gameID string, id *string) error {
	if id == nil {
		return nil
	}
	n, err := count(ctx, q, `SELECT COUNT(*) FROM tournaments WHERE id = ? AND game_id = ?`, *id, gameID)
	if err != nil {
		return err
	}
	if n == 0 {
		return BadRequest("unknown tournament")
	}
	return nil
}

func bumpVersion(ctx context.Context, tx *sql.Tx, gameID string) error {
	_, err := tx.ExecContext(ctx, `UPDATE games SET version = version + 1 WHERE id = ?`, gameID)
	return err
}

func loadHandicaps(ctx context.Context, q queryer, gameID string) (map[string]rating.Rating, error) {
	rows, err := q.QueryContext(ctx, `SELECT format, mu, sigma FROM handicaps WHERE game_id = ?`, gameID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]rating.Rating{}
	for rows.Next() {
		var f string
		var r rating.Rating
		if err := rows.Scan(&f, &r.Mu, &r.Sigma); err != nil {
			return nil, err
		}
		out[f] = r
	}
	return out, rows.Err()
}

type counts struct{ rounds, wins int }

// CreateRound records a round and updates everyone's rating in the same transaction.
func (s *Store) CreateRound(ctx context.Context, groupID, gameID, deviceID string, in RoundInput) (Round, error) {
	if in.Winner != 0 && in.Winner != 1 {
		return Round{}, BadRequest("winner required")
	}
	if err := checkScore(in.ScoreA); err != nil {
		return Round{}, err
	}
	if err := checkScore(in.ScoreB); err != nil {
		return Round{}, err
	}
	id := newID()
	err := s.write(ctx, func(tx *sql.Tx) error {
		if n, err := count(ctx, tx, `SELECT COUNT(*) FROM games WHERE id = ? AND group_id = ?`, gameID, groupID); err != nil {
			return err
		} else if n == 0 {
			return ErrNotFound
		}
		teams, err := validateTeams(ctx, tx, groupID, in.Teams)
		if err != nil {
			return err
		}
		if err := checkTournament(ctx, tx, gameID, in.TournamentID); err != nil {
			return err
		}
		now := s.nowMs()
		today, err := count(ctx, tx, `SELECT COUNT(*) FROM rounds WHERE game_id = ? AND played_at > ?`, gameID, now-86400000)
		if err != nil {
			return err
		}
		if today >= s.Limits.RoundsPerDay {
			return ErrLimit
		}
		// Strictly after every existing round, so replay order matches write order.
		var last sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT MAX(played_at) FROM rounds WHERE game_id = ?`, gameID).Scan(&last); err != nil {
			return err
		}
		playedAt := max(now, last.Int64+1)

		ids := append(append([]string{}, teams[0]...), teams[1]...)
		ratings, cnt, err := loadRatings(ctx, tx, gameID, ids)
		if err != nil {
			return err
		}
		handicaps, err := loadHandicaps(ctx, tx, gameID)
		if err != nil {
			return err
		}
		speed, err := gameSpeed(ctx, tx, gameID)
		if err != nil {
			return err
		}
		res := rating.Apply(ratings, handicaps, teams, in.Winner, speed)

		if _, err := tx.ExecContext(ctx, `INSERT INTO rounds (id, game_id, tournament_id, played_at, winner, score_a, score_b, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id, gameID, in.TournamentID, playedAt, in.Winner, in.ScoreA, in.ScoreB, nullIfEmpty(deviceID)); err != nil {
			return err
		}
		if err := writeRoundResult(ctx, tx, id, res); err != nil {
			return err
		}
		for t, team := range teams {
			for _, pid := range team {
				c := res.Players[pid]
				if _, err := tx.ExecContext(ctx, `INSERT INTO round_players (round_id, player_id, team, mu_before, sigma_before, mu_after, sigma_after) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					id, pid, t, c.Before.Mu, c.Before.Sigma, c.After.Mu, c.After.Sigma); err != nil {
					return err
				}
				k := cnt[pid]
				k.rounds++
				if t == in.Winner {
					k.wins++
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO ratings (game_id, player_id, mu, sigma, rounds, wins) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT (game_id, player_id) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma, rounds = excluded.rounds, wins = excluded.wins`,
					gameID, pid, c.After.Mu, c.After.Sigma, k.rounds, k.wins); err != nil {
					return err
				}
			}
		}
		if res.Handicap != nil {
			if _, err := tx.ExecContext(ctx, `INSERT INTO handicaps (game_id, format, mu, sigma) VALUES (?, ?, ?, ?)
				ON CONFLICT (game_id, format) DO UPDATE SET mu = excluded.mu, sigma = excluded.sigma`,
				gameID, res.Format, res.Handicap.After.Mu, res.Handicap.After.Sigma); err != nil {
				return err
			}
		}
		return bumpVersion(ctx, tx, gameID)
	})
	if err != nil {
		return Round{}, err
	}
	return s.GetRound(ctx, groupID, id)
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// loadRatings returns the current rating and tallies of the given players (new
// players are absent from the maps).
func loadRatings(ctx context.Context, q queryer, gameID string, ids []string) (map[string]rating.Rating, map[string]counts, error) {
	args := []any{gameID}
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := q.QueryContext(ctx, `SELECT player_id, mu, sigma, rounds, wins FROM ratings WHERE game_id = ? AND player_id IN (`+placeholders(len(ids))+`)`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	ratings := map[string]rating.Rating{}
	cnt := map[string]counts{}
	for rows.Next() {
		var id string
		var r rating.Rating
		var c counts
		if err := rows.Scan(&id, &r.Mu, &r.Sigma, &c.rounds, &c.wins); err != nil {
			return nil, nil, err
		}
		ratings[id], cnt[id] = r, c
	}
	return ratings, cnt, rows.Err()
}

// writeRoundResult stores the round's handicap before/after.
func writeRoundResult(ctx context.Context, tx *sql.Tx, roundID string, res rating.Result) error {
	if res.Handicap == nil {
		_, err := tx.ExecContext(ctx, `UPDATE rounds SET format = NULL, h_mu_before = NULL, h_sigma_before = NULL, h_mu_after = NULL, h_sigma_after = NULL WHERE id = ?`, roundID)
		return err
	}
	h := res.Handicap
	_, err := tx.ExecContext(ctx, `UPDATE rounds SET format = ?, h_mu_before = ?, h_sigma_before = ?, h_mu_after = ?, h_sigma_after = ? WHERE id = ?`,
		res.Format, h.Before.Mu, h.Before.Sigma, h.After.Mu, h.After.Sigma, roundID)
	return err
}

// ---- re-rating -----------------------------------------------------------------------

type storedPlayer struct {
	team                                   int
	muBefore, sigmaBefore, muAfter, sAfter sql.NullFloat64
}

type replayRound struct {
	id     string
	winner int
	teams  [2][]string
	stored map[string]storedPlayer
	format sql.NullString
	hMuB   sql.NullFloat64
	hSigB  sql.NullFloat64
	hMuA   sql.NullFloat64
	hSigA  sql.NullFloat64
}

func differs(stored sql.NullFloat64, v float64) bool {
	return !stored.Valid || math.Abs(stored.Float64-v) > 1e-12
}

// replayGame recalculates a game's ratings from its first round: every
// non-deleted round in order. It rewrites only what changed.
func (s *Store) replayGame(ctx context.Context, tx *sql.Tx, gameID string) error {
	speed, err := gameSpeed(ctx, tx, gameID)
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT r.id, r.winner, r.format, r.h_mu_before, r.h_sigma_before, r.h_mu_after, r.h_sigma_after,
		       rp.player_id, rp.team, rp.mu_before, rp.sigma_before, rp.mu_after, rp.sigma_after
		FROM rounds r JOIN round_players rp ON rp.round_id = r.id
		WHERE r.game_id = ? AND r.deleted_at IS NULL
		ORDER BY r.played_at, r.id, rp.team, rp.player_id`, gameID)
	if err != nil {
		return err
	}
	var rounds []*replayRound
	for rows.Next() {
		var id, pid string
		var winner int
		var sp storedPlayer
		var format sql.NullString
		var hb, hsb, ha, hsa sql.NullFloat64
		if err := rows.Scan(&id, &winner, &format, &hb, &hsb, &ha, &hsa, &pid, &sp.team, &sp.muBefore, &sp.sigmaBefore, &sp.muAfter, &sp.sAfter); err != nil {
			rows.Close()
			return err
		}
		var r *replayRound
		if n := len(rounds); n > 0 && rounds[n-1].id == id {
			r = rounds[n-1]
		} else {
			r = &replayRound{id: id, winner: winner, stored: map[string]storedPlayer{}, format: format, hMuB: hb, hSigB: hsb, hMuA: ha, hSigA: hsa}
			rounds = append(rounds, r)
		}
		r.teams[sp.team] = append(r.teams[sp.team], pid)
		r.stored[pid] = sp
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	ratings := map[string]rating.Rating{}
	handicaps := map[string]rating.Rating{}
	tally := map[string]counts{}
	for _, r := range rounds {
		res := rating.Apply(ratings, handicaps, r.teams, r.winner, speed)
		for pid, c := range res.Players {
			sp := r.stored[pid]
			k := tally[pid]
			k.rounds++
			if sp.team == r.winner {
				k.wins++
			}
			tally[pid] = k
			if differs(sp.muBefore, c.Before.Mu) || differs(sp.sigmaBefore, c.Before.Sigma) || differs(sp.muAfter, c.After.Mu) || differs(sp.sAfter, c.After.Sigma) {
				if _, err := tx.ExecContext(ctx, `UPDATE round_players SET mu_before = ?, sigma_before = ?, mu_after = ?, sigma_after = ? WHERE round_id = ? AND player_id = ?`,
					c.Before.Mu, c.Before.Sigma, c.After.Mu, c.After.Sigma, r.id, pid); err != nil {
					return err
				}
			}
		}
		same := (res.Handicap == nil && !r.format.Valid) ||
			(res.Handicap != nil && r.format.Valid && r.format.String == res.Format &&
				!differs(r.hMuB, res.Handicap.Before.Mu) && !differs(r.hSigB, res.Handicap.Before.Sigma) &&
				!differs(r.hMuA, res.Handicap.After.Mu) && !differs(r.hSigA, res.Handicap.After.Sigma))
		if !same {
			if err := writeRoundResult(ctx, tx, r.id, res); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM ratings WHERE game_id = ?`, gameID); err != nil {
		return err
	}
	for pid, r := range ratings {
		k := tally[pid]
		if _, err := tx.ExecContext(ctx, `INSERT INTO ratings (game_id, player_id, mu, sigma, rounds, wins) VALUES (?, ?, ?, ?, ?, ?)`,
			gameID, pid, r.Mu, r.Sigma, k.rounds, k.wins); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM handicaps WHERE game_id = ?`, gameID); err != nil {
		return err
	}
	for f, h := range handicaps {
		if _, err := tx.ExecContext(ctx, `INSERT INTO handicaps (game_id, format, mu, sigma) VALUES (?, ?, ?, ?)`, gameID, f, h.Mu, h.Sigma); err != nil {
			return err
		}
	}
	return nil
}

// Recalculate re-rates a whole game (the admin "recalc" command).
func (s *Store) Recalculate(ctx context.Context, groupID, gameID string) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if n, err := count(ctx, tx, `SELECT COUNT(*) FROM games WHERE id = ? AND group_id = ?`, gameID, groupID); err != nil {
			return err
		} else if n == 0 {
			return ErrNotFound
		}
		if err := s.replayGame(ctx, tx, gameID); err != nil {
			return err
		}
		return bumpVersion(ctx, tx, gameID)
	})
}

// ---- edit, delete, restore -------------------------------------------------------------

type roundRow struct {
	gameID  string
	winner  int
	deleted bool
}

func loadRoundRow(ctx context.Context, q queryer, groupID, roundID string) (roundRow, error) {
	var r roundRow
	var deleted sql.NullInt64
	err := q.QueryRowContext(ctx, `SELECT r.game_id, r.winner, r.deleted_at FROM rounds r JOIN games g ON g.id = r.game_id WHERE r.id = ? AND g.group_id = ?`,
		roundID, groupID).Scan(&r.gameID, &r.winner, &deleted)
	r.deleted = deleted.Valid
	return r, notFoundIf(err)
}

func loadRoundTeams(ctx context.Context, q queryer, roundID string) ([2][]string, error) {
	var teams [2][]string
	rows, err := q.QueryContext(ctx, `SELECT player_id, team FROM round_players WHERE round_id = ? ORDER BY player_id`, roundID)
	if err != nil {
		return teams, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var t int
		if err := rows.Scan(&id, &t); err != nil {
			return teams, err
		}
		teams[t] = append(teams[t], id)
	}
	return teams, rows.Err()
}

func sameTeams(a, b [2][]string) bool {
	for i := range a {
		if len(a[i]) != len(b[i]) {
			return false
		}
		for j := range a[i] {
			if a[i][j] != b[i][j] {
				return false
			}
		}
	}
	return true
}

// UpdateRound edits a round; changing teams or winner re-rates the game.
func (s *Store) UpdateRound(ctx context.Context, groupID, roundID string, p RoundPatch) (Round, error) {
	if p.Winner != nil && *p.Winner != 0 && *p.Winner != 1 {
		return Round{}, BadRequest("invalid winner")
	}
	for _, v := range []Nullable[int]{p.ScoreA, p.ScoreB} {
		if err := checkScore(v.Val); err != nil {
			return Round{}, err
		}
	}
	err := s.write(ctx, func(tx *sql.Tx) error {
		r, err := loadRoundRow(ctx, tx, groupID, roundID)
		if err != nil {
			return err
		}
		oldTeams, err := loadRoundTeams(ctx, tx, roundID)
		if err != nil {
			return err
		}
		teams := oldTeams
		if p.Teams != nil {
			if teams, err = validateTeams(ctx, tx, groupID, *p.Teams); err != nil {
				return err
			}
		}
		winner := r.winner
		if p.Winner != nil {
			winner = *p.Winner
		}
		if p.TournamentID.Set {
			if err := checkTournament(ctx, tx, r.gameID, p.TournamentID.Val); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE rounds SET tournament_id = ? WHERE id = ?`, p.TournamentID.Val, roundID); err != nil {
				return err
			}
		}
		if p.ScoreA.Set {
			if _, err := tx.ExecContext(ctx, `UPDATE rounds SET score_a = ? WHERE id = ?`, p.ScoreA.Val, roundID); err != nil {
				return err
			}
		}
		if p.ScoreB.Set {
			if _, err := tx.ExecContext(ctx, `UPDATE rounds SET score_b = ? WHERE id = ?`, p.ScoreB.Val, roundID); err != nil {
				return err
			}
		}
		teamsChanged := !sameTeams(teams, oldTeams)
		if winner != r.winner {
			if _, err := tx.ExecContext(ctx, `UPDATE rounds SET winner = ? WHERE id = ?`, winner, roundID); err != nil {
				return err
			}
		}
		if teamsChanged {
			if _, err := tx.ExecContext(ctx, `DELETE FROM round_players WHERE round_id = ?`, roundID); err != nil {
				return err
			}
			for t, team := range teams {
				for _, pid := range team {
					if _, err := tx.ExecContext(ctx, `INSERT INTO round_players (round_id, player_id, team) VALUES (?, ?, ?)`, roundID, pid, t); err != nil {
						return err
					}
				}
			}
		}
		// A deleted round doesn't count; it just keeps its new line-up for a restore.
		if (teamsChanged || winner != r.winner) && !r.deleted {
			if err := s.replayGame(ctx, tx, r.gameID); err != nil {
				return err
			}
		}
		return bumpVersion(ctx, tx, r.gameID)
	})
	if err != nil {
		return Round{}, err
	}
	return s.GetRound(ctx, groupID, roundID)
}

// SetRoundDeleted soft-deletes or restores a round and re-rates the game.
func (s *Store) SetRoundDeleted(ctx context.Context, groupID, roundID string, deleted bool) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		r, err := loadRoundRow(ctx, tx, groupID, roundID)
		if err != nil {
			return err
		}
		if r.deleted == deleted {
			return nil
		}
		var at any
		if deleted {
			at = s.nowMs()
		}
		if _, err := tx.ExecContext(ctx, `UPDATE rounds SET deleted_at = ? WHERE id = ?`, at, roundID); err != nil {
			return err
		}
		if err := s.replayGame(ctx, tx, r.gameID); err != nil {
			return err
		}
		return bumpVersion(ctx, tx, r.gameID)
	})
}

// ---- reading rounds ---------------------------------------------------------------------

const roundCols = `r.id, r.game_id, r.tournament_id, r.played_at, r.winner, r.score_a, r.score_b, r.created_by, r.deleted_at`

func scanRound(row interface{ Scan(...any) error }) (Round, error) {
	var r Round
	var tour, by sql.NullString
	var a, b, del sql.NullInt64
	if err := row.Scan(&r.ID, &r.GameID, &tour, &r.PlayedAt, &r.Winner, &a, &b, &by, &del); err != nil {
		return Round{}, notFoundIf(err)
	}
	if tour.Valid {
		r.TournamentID = &tour.String
	}
	if by.Valid {
		r.CreatedBy = &by.String
	}
	if a.Valid {
		v := int(a.Int64)
		r.ScoreA = &v
	}
	if b.Valid {
		v := int(b.Int64)
		r.ScoreB = &v
	}
	r.Deleted = del.Valid
	r.Players = []RoundPlayer{}
	return r, nil
}

// attachPlayers fills in the players of each round.
func (s *Store) attachPlayers(ctx context.Context, rounds []Round) error {
	if len(rounds) == 0 {
		return nil
	}
	index := make(map[string]int, len(rounds))
	args := make([]any, len(rounds))
	for i, r := range rounds {
		index[r.ID] = i
		args[i] = r.ID
	}
	rows, err := s.db.QueryContext(ctx, `SELECT round_id, player_id, team, mu_before, sigma_before, mu_after, sigma_after FROM round_players
		WHERE round_id IN (`+placeholders(len(rounds))+`) ORDER BY team, player_id`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var rid string
		var p RoundPlayer
		var mb, sb, ma, sa sql.NullFloat64
		if err := rows.Scan(&rid, &p.ID, &p.Team, &mb, &sb, &ma, &sa); err != nil {
			return err
		}
		if mb.Valid && ma.Valid {
			p.Before = &rating.Rating{Mu: mb.Float64, Sigma: sb.Float64}
			p.After = &rating.Rating{Mu: ma.Float64, Sigma: sa.Float64}
			p.Delta = rating.Delta(*p.Before, *p.After)
		}
		i := index[rid]
		rounds[i].Players = append(rounds[i].Players, p)
	}
	return rows.Err()
}

func (s *Store) scanRounds(ctx context.Context, rows *sql.Rows) ([]Round, error) {
	defer rows.Close()
	out := []Round{}
	for rows.Next() {
		r, err := scanRound(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return out, s.attachPlayers(ctx, out)
}

// GetRound returns one round if it belongs to the group.
func (s *Store) GetRound(ctx context.Context, groupID, roundID string) (Round, error) {
	r, err := scanRound(s.db.QueryRowContext(ctx, `SELECT `+roundCols+` FROM rounds r JOIN games g ON g.id = r.game_id WHERE r.id = ? AND g.group_id = ?`, roundID, groupID))
	if err != nil {
		return Round{}, err
	}
	out := []Round{r}
	if err := s.attachPlayers(ctx, out); err != nil {
		return Round{}, err
	}
	return out[0], nil
}

// RoundFilter selects a page of history.
type RoundFilter struct {
	Tournament string
	Player     string
	Before     string // cursor "playedAt.id" from a previous page
	Limit      int
}

// ListRounds returns a page of a game's rounds, newest first, and the cursor of
// the next page ("" at the end).
func (s *Store) ListRounds(ctx context.Context, groupID, gameID string, f RoundFilter) ([]Round, string, error) {
	if _, err := s.GetGame(ctx, groupID, gameID); err != nil {
		return nil, "", err
	}
	size := f.Limit
	if size == 0 {
		size = 50
	}
	size = max(1, min(size, 200))
	q := `SELECT ` + roundCols + ` FROM rounds r`
	var args []any
	if f.Player != "" {
		q += ` JOIN round_players rp ON rp.round_id = r.id AND rp.player_id = ?`
		args = append(args, f.Player)
	}
	q += ` WHERE r.game_id = ? AND r.deleted_at IS NULL`
	args = append(args, gameID)
	if at, id, ok := strings.Cut(f.Before, "."); ok && at != "" && id != "" {
		ms, err := strconv.ParseInt(at, 10, 64)
		if err == nil {
			q += ` AND (r.played_at < ? OR (r.played_at = ? AND r.id < ?))`
			args = append(args, ms, ms, id)
		}
	}
	if f.Tournament != "" {
		q += ` AND r.tournament_id = ?`
		args = append(args, f.Tournament)
	}
	q += ` ORDER BY r.played_at DESC, r.id DESC LIMIT ?`
	args = append(args, size+1)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, "", err
	}
	rounds, err := s.scanRounds(ctx, rows)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(rounds) > size {
		rounds = rounds[:size]
		last := rounds[size-1]
		next = fmt.Sprintf("%d.%s", last.PlayedAt, last.ID)
	}
	return rounds, next, nil
}

// PlayerRating is a leaderboard row.
type PlayerRating struct {
	PlayerID    string  `json:"playerId"`
	Mu          float64 `json:"mu"`
	Sigma       float64 `json:"sigma"`
	Rounds      int     `json:"rounds"`
	Wins        int     `json:"wins"`
	Display     int     `json:"display"`
	Provisional bool    `json:"provisional"`
	Today       *int    `json:"today"` // display change since `since`; nil if they didn't play
	Week        *int    `json:"week"`  // the same since `weekSince`
}

// HandicapOut is a learned handicap, for the browser's win odds.
type HandicapOut struct {
	Format string  `json:"format"`
	Mu     float64 `json:"mu"`
	Sigma  float64 `json:"sigma"`
}

// GameView is everything the game page needs in one read.
type GameView struct {
	Game        Game           `json:"game"`
	Version     int64          `json:"version"`
	Ratings     []PlayerRating `json:"ratings"`
	Handicaps   []HandicapOut  `json:"handicaps"`
	Tournaments []Tournament   `json:"tournaments"`
	Rounds      []Round        `json:"rounds"`
}

// GetGameView returns the leaderboard, handicaps, tournaments and recent
// rounds. Rounds since `since` (ms, the start of the viewer's day) are always
// included, plus the last 20, at most 200. Each rating's Today and Week are the
// display change since `since` and `weekSince`.
func (s *Store) GetGameView(ctx context.Context, groupID, gameID string, since, weekSince int64) (GameView, error) {
	game, err := s.GetGame(ctx, groupID, gameID)
	if err != nil {
		return GameView{}, err
	}
	v := GameView{Game: game, Version: game.Version, Ratings: []PlayerRating{}, Handicaps: []HandicapOut{}}

	rows, err := s.db.QueryContext(ctx, `SELECT player_id, mu, sigma, rounds, wins FROM ratings WHERE game_id = ?`, gameID)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var p PlayerRating
		if err := rows.Scan(&p.PlayerID, &p.Mu, &p.Sigma, &p.Rounds, &p.Wins); err != nil {
			rows.Close()
			return v, err
		}
		p.Display = rating.Display(rating.Rating{Mu: p.Mu, Sigma: p.Sigma})
		p.Provisional = p.Rounds < rating.ProvisionalRounds
		v.Ratings = append(v.Ratings, p)
	}
	rows.Close()

	for _, d := range []struct {
		since int64
		set   func(*PlayerRating, int)
	}{
		{since, func(r *PlayerRating, d int) { r.Today = &d }},
		{weekSince, func(r *PlayerRating, d int) { r.Week = &d }},
	} {
		startMu, err := s.muSince(ctx, gameID, d.since)
		if err != nil {
			return v, err
		}
		for i := range v.Ratings {
			if mu, ok := startMu[v.Ratings[i].PlayerID]; ok {
				d.set(&v.Ratings[i], rating.Delta(rating.Rating{Mu: mu}, rating.Rating{Mu: v.Ratings[i].Mu}))
			}
		}
	}

	hs, err := loadHandicaps(ctx, s.db, gameID)
	if err != nil {
		return v, err
	}
	for f, h := range hs {
		v.Handicaps = append(v.Handicaps, HandicapOut{f, h.Mu, h.Sigma})
	}
	sort.Slice(v.Handicaps, func(i, j int) bool { return v.Handicaps[i].Format < v.Handicaps[j].Format })

	if v.Tournaments, err = s.ListTournaments(ctx, gameID, 50); err != nil {
		return v, err
	}
	rows, err = s.db.QueryContext(ctx, `
		SELECT `+roundCols+` FROM rounds r WHERE r.game_id = ?1 AND r.deleted_at IS NULL AND r.played_at >= ?2
		UNION SELECT * FROM (SELECT `+roundCols+` FROM rounds r WHERE r.game_id = ?1 AND r.deleted_at IS NULL ORDER BY r.played_at DESC LIMIT 20)
		ORDER BY played_at DESC, id DESC LIMIT 200`, gameID, since)
	if err != nil {
		return v, err
	}
	v.Rounds, err = s.scanRounds(ctx, rows)
	return v, err
}

// muSince is each player's skill before their first round since `since`, so
// the change since then is the current skill minus this. Players without a
// round since then are missing.
func (s *Store) muSince(ctx context.Context, gameID string, since int64) (map[string]float64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT rp.player_id, rp.mu_before FROM round_players rp JOIN rounds r ON r.id = rp.round_id
		WHERE r.game_id = ? AND r.deleted_at IS NULL AND r.played_at >= ? AND rp.mu_before IS NOT NULL ORDER BY r.played_at, r.id`, gameID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var id string
		var mu float64
		if err := rows.Scan(&id, &mu); err != nil {
			return nil, err
		}
		if _, ok := out[id]; !ok {
			out[id] = mu
		}
	}
	return out, rows.Err()
}

// PairStat is a head-to-head tally.
type PairStat struct {
	ID    string `json:"id"`
	Games int    `json:"games"`
	Wins  int    `json:"wins"`
}

// PlayerStats is a player's history in a game.
type PlayerStats struct {
	// History is [playedAt, displayRating, won(0/1)] for every round, oldest first.
	History [][3]int64 `json:"history"`
	With    []PairStat `json:"with"`
	Against []PairStat `json:"against"`
}

// GetPlayerStats returns a player's rating history and head-to-head records.
func (s *Store) GetPlayerStats(ctx context.Context, groupID, gameID, playerID string) (PlayerStats, error) {
	if _, err := s.GetGame(ctx, groupID, gameID); err != nil {
		return PlayerStats{}, err
	}
	out := PlayerStats{History: [][3]int64{}, With: []PairStat{}, Against: []PairStat{}}
	rows, err := s.db.QueryContext(ctx, `SELECT r.played_at, r.winner, rp.team, rp.mu_after, rp.sigma_after
		FROM round_players rp JOIN rounds r ON r.id = rp.round_id
		WHERE rp.player_id = ? AND r.game_id = ? AND r.deleted_at IS NULL ORDER BY r.played_at, r.id`, playerID, gameID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var at int64
		var winner, team int
		var mu, sigma sql.NullFloat64
		if err := rows.Scan(&at, &winner, &team, &mu, &sigma); err != nil {
			rows.Close()
			return out, err
		}
		d := int64(1000)
		if mu.Valid {
			d = int64(rating.Display(rating.Rating{Mu: mu.Float64, Sigma: sigma.Float64}))
		}
		out.History = append(out.History, [3]int64{at, d, int64(b2i(team == winner))})
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `SELECT o.player_id, o.team = me.team, COUNT(*), SUM(me.team = r.winner)
		FROM round_players me JOIN rounds r ON r.id = me.round_id
		JOIN round_players o ON o.round_id = me.round_id AND o.player_id != me.player_id
		WHERE me.player_id = ? AND r.game_id = ? AND r.deleted_at IS NULL
		GROUP BY o.player_id, o.team = me.team`, playerID, gameID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var p PairStat
		var same bool
		if err := rows.Scan(&p.ID, &same, &p.Games, &p.Wins); err != nil {
			return out, err
		}
		if same {
			out.With = append(out.With, p)
		} else {
			out.Against = append(out.Against, p)
		}
	}
	return out, rows.Err()
}
