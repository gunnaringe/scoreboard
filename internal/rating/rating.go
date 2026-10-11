// Package rating implements the scoreboard's rating model: Weng-Lin
// (Bradley-Terry, full pairing), the open TrueSkill-style model behind
// OpenSkill. Weng & Lin, "A Bayesian Approximation Method for Online Ranking",
// JMLR 12 (2011), Algorithm 1.
//
// Each player has a skill estimate Mu and an uncertainty Sigma; each player's
// share of an update is scaled by their own variance, so new players move fast
// and established players stay stable.
//
// Tuned for a small office group after simulating seasons:
//   - Team strength is the sum of (Mu - 25), so team size alone is worth
//     nothing; instead each uneven format ("2v1", "3v2") has its own learned
//     handicap, a pseudo-player on the bigger team updated by the same rule.
//   - Starting sigma 6 and display mu - sigma, so the number tracks skill
//     rather than how many rounds someone has played.
//
// The browser keeps a small copy of WinProbability (web/rating.js) for the
// odds shown while picking teams; testdata/golden.json is checked by both.
package rating

import (
	"fmt"
	"math"
)

const (
	Mu     = 25.0
	Sigma  = 6.0
	Beta   = 25.0 / 6.0
	Kappa  = 0.0001
	Tau    = Mu / 300 // keeps ratings from freezing (OpenSkill's default)
	Scale  = 25.0     // display points per unit of mu
	Offset = Mu - Sigma

	// ProvisionalRounds is how many rounds a player needs before they are ranked.
	ProvisionalRounds = 10

	// Prior for a format's handicap: the bigger team wins roughly 70 % between equals.
	HandicapMu    = 6.0
	HandicapSigma = 4.0
)

// Rating is a skill estimate.
type Rating struct {
	Mu    float64 `json:"mu"`
	Sigma float64 `json:"sigma"`
}

// New is a brand-new player.
func New() Rating { return Rating{Mu, Sigma} }

// NewHandicap is the prior for a format nobody has played yet.
func NewHandicap() Rating { return Rating{HandicapMu, HandicapSigma} }

// round matches JavaScript's Math.round (halves go up), which the reference
// implementation and the golden vectors use.
func round(x float64) int { return int(math.Floor(x + 0.5)) }

// Display is the Elo-looking number: 1000 for a brand-new player.
func Display(r Rating) int { return round(1000 + Scale*(r.Mu-r.Sigma-Offset)) }

// Delta is the change shown for a round: how far the skill estimate moved.
func Delta(before, after Rating) int { return round(Scale * (after.Mu - before.Mu)) }

// Format is "2v1" for uneven team sizes and "" for even ones. The handicap
// belongs to the bigger team.
func Format(a, b int) string {
	if a == b {
		return ""
	}
	return fmt.Sprintf("%dv%d", max(a, b), min(a, b))
}

// member is a team member: it adds (Mu - Base) to its team's strength. Players
// have base Mu; the handicap pseudo-player has base 0.
type member struct{ mu, sigma, base float64 }

func teamStats(team []member) (mu, s2 float64) {
	for _, p := range team {
		mu += p.mu - p.base
		s2 += p.sigma * p.sigma
	}
	return
}

// rate returns the new ratings for teams ranked by ranks (lower is better,
// equal ranks draw).
func rate(teams [][]member, ranks []int) [][]Rating {
	decayed := make([][]member, len(teams))
	for i, team := range teams {
		decayed[i] = make([]member, len(team))
		for j, p := range team {
			decayed[i][j] = member{p.mu, math.Sqrt(p.sigma*p.sigma + Tau*Tau), p.base}
		}
	}
	mus := make([]float64, len(teams))
	s2s := make([]float64, len(teams))
	for i, team := range decayed {
		mus[i], s2s[i] = teamStats(team)
	}
	out := make([][]Rating, len(teams))
	for i, team := range decayed {
		var omega, delta float64
		for q := range decayed {
			if q == i {
				continue
			}
			c := math.Sqrt(s2s[i] + s2s[q] + 2*Beta*Beta)
			p := 1 / (1 + math.Exp((mus[q]-mus[i])/c))
			s := 0.0
			switch {
			case ranks[q] > ranks[i]:
				s = 1
			case ranks[q] == ranks[i]:
				s = 0.5
			}
			omega += (s2s[i] / c) * (s - p)
			gamma := math.Sqrt(s2s[i]) / c
			delta += ((gamma * s2s[i]) / (c * c)) * p * (1 - p)
		}
		out[i] = make([]Rating, len(team))
		for j, p := range team {
			share := (p.sigma * p.sigma) / s2s[i]
			out[i][j] = Rating{
				Mu:    p.mu + share*omega,
				Sigma: p.sigma * math.Sqrt(math.Max(1-share*delta, Kappa)),
			}
		}
	}
	return out
}

// withHandicap adds the format's handicap to the bigger team.
func withHandicap(teams [][]member, handicaps map[string]Rating) (out [][]member, format string, side int) {
	format = Format(len(teams[0]), len(teams[1]))
	if format == "" {
		return teams, "", -1
	}
	side = 1
	if len(teams[0]) > len(teams[1]) {
		side = 0
	}
	h, ok := handicaps[format]
	if !ok {
		h = NewHandicap()
	}
	out = [][]member{teams[0], teams[1]}
	out[side] = append(append([]member{}, teams[side]...), member{h.Mu, h.Sigma, 0})
	return out, format, side
}

func members(rs []Rating) []member {
	out := make([]member, len(rs))
	for i, r := range rs {
		out[i] = member{r.Mu, r.Sigma, Mu}
	}
	return out
}

// WinProbability is the chance that team a beats team b.
func WinProbability(a, b []Rating, handicaps map[string]Rating) float64 {
	teams, _, _ := withHandicap([][]member{members(a), members(b)}, handicaps)
	ma, sa := teamStats(teams[0])
	mb, sb := teamStats(teams[1])
	c := math.Sqrt(sa + sb + 2*Beta*Beta)
	return 1 / (1 + math.Exp((mb-ma)/c))
}

// Change is one rating before and after a round.
type Change struct{ Before, After Rating }

// Result is what applying a round did.
type Result struct {
	Players  map[string]Change
	Format   string  // "" for even teams
	Handicap *Change // nil for even teams
}

// Apply applies one two-team round in place: ratings (player id -> rating) and
// handicaps (format -> rating) are updated, players not yet in ratings start
// as New. teams holds the player ids of each team; winner is 0 or 1.
func Apply(ratings, handicaps map[string]Rating, teams [2][]string, winner int) Result {
	get := func(id string) Rating {
		if r, ok := ratings[id]; ok {
			return r
		}
		return New()
	}
	before := [2][]Rating{}
	ms := make([][]member, 2)
	for i, team := range teams {
		before[i] = make([]Rating, len(team))
		for j, id := range team {
			before[i][j] = get(id)
		}
		ms[i] = members(before[i])
	}
	withH, format, side := withHandicap(ms, handicaps)
	ranks := []int{1, 1}
	ranks[winner] = 0
	after := rate(withH, ranks)

	res := Result{Players: make(map[string]Change, len(teams[0])+len(teams[1])), Format: format}
	for i, team := range teams {
		for j, id := range team {
			ratings[id] = after[i][j]
			res.Players[id] = Change{before[i][j], after[i][j]}
		}
	}
	if format != "" {
		last := len(after[side]) - 1
		h := withH[side][last]
		c := Change{Rating{h.mu, h.sigma}, after[side][last]}
		handicaps[format] = c.After
		res.Handicap = &c
	}
	return res
}
