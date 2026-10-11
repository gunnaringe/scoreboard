package store

import (
	"context"
	"math/rand/v2"

	"github.com/gunnaringe/scoreboard/internal/rating"
)

// teamRatings loads the current ratings of the players (new players count as New).
func (s *Store) teamRatings(ctx context.Context, gameID string, teams ...[]string) ([][]rating.Rating, map[string]rating.Rating, error) {
	var ids []string
	for _, t := range teams {
		ids = append(ids, t...)
	}
	known, _, err := loadRatings(ctx, s.db, gameID, ids)
	if err != nil {
		return nil, nil, err
	}
	out := make([][]rating.Rating, len(teams))
	for i, t := range teams {
		for _, id := range t {
			r, ok := known[id]
			if !ok {
				r = rating.New()
			}
			out[i] = append(out[i], r)
		}
	}
	handicaps, err := loadHandicaps(ctx, s.db, gameID)
	return out, handicaps, err
}

// PreviewRound is the chance that team A beats team B with today's ratings.
func (s *Store) PreviewRound(ctx context.Context, groupID, gameID string, teamA, teamB []string) (float64, error) {
	if _, err := s.GetGame(ctx, groupID, gameID); err != nil {
		return 0, err
	}
	teams, err := validateTeams(ctx, s.db, groupID, [2][]string{teamA, teamB})
	if err != nil {
		return 0, err
	}
	rs, handicaps, err := s.teamRatings(ctx, gameID, teams[0], teams[1])
	if err != nil {
		return 0, err
	}
	return rating.WinProbability(rs[0], rs[1], handicaps), nil
}

// SuggestTeams splits the players into the two fairest teams.
func (s *Store) SuggestTeams(ctx context.Context, groupID, gameID string, players []string) (a, b []string, probA float64, err error) {
	if _, err := s.GetGame(ctx, groupID, gameID); err != nil {
		return nil, nil, 0, err
	}
	if len(players) < 2 || len(players) > rating.MaxBalance {
		return nil, nil, 0, BadRequest("pick between 2 and 14 players")
	}
	// validateTeams wants two non-empty teams; checking all at once is the same as one team of everyone.
	if _, err := validateTeams(ctx, s.db, groupID, [2][]string{players[:1], players[1:]}); err != nil {
		return nil, nil, 0, err
	}
	rs, handicaps, err := s.teamRatings(ctx, gameID, players)
	if err != nil {
		return nil, nil, 0, err
	}
	cands := make([]rating.Candidate, len(players))
	for i, id := range players {
		cands[i] = rating.Candidate{ID: id, Rating: rs[0][i]}
	}
	ta, tb := rating.Balance(cands, handicaps, rand.Float64)
	ra, rb := make([]rating.Rating, len(ta)), make([]rating.Rating, len(tb))
	for i, c := range ta {
		a, ra[i] = append(a, c.ID), c.Rating
	}
	for i, c := range tb {
		b, rb[i] = append(b, c.ID), c.Rating
	}
	return a, b, rating.WinProbability(ra, rb, handicaps), nil
}
