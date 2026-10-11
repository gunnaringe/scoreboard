package rating

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

type goldenRound struct {
	Teams  [2][]string `json:"teams"`
	Winner int         `json:"winner"`
}

type goldenResult struct {
	Players  map[string]Change `json:"players"`
	Format   string            `json:"format"`
	Handicap *Change           `json:"handicap"`
}

type golden struct {
	Sequences []struct {
		Name      string            `json:"name"`
		Rounds    []goldenRound     `json:"rounds"`
		Results   []goldenResult    `json:"results"`
		Ratings   map[string]Rating `json:"ratings"`
		Handicaps map[string]Rating `json:"handicaps"`
	} `json:"sequences"`
	Odds []struct {
		A         []Rating          `json:"a"`
		B         []Rating          `json:"b"`
		Handicaps map[string]Rating `json:"handicaps"`
		P         float64           `json:"p"`
	} `json:"odds"`
	Display []struct {
		Before  Rating `json:"before"`
		After   Rating `json:"after"`
		Display int    `json:"display"`
		Delta   int    `json:"delta"`
	} `json:"display"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func checkRating(t *testing.T, what string, got, want Rating) {
	t.Helper()
	if !near(got.Mu, want.Mu) || !near(got.Sigma, want.Sigma) {
		t.Fatalf("%s: got %+v, want %+v", what, got, want)
	}
}

// The Go model must reproduce the reference implementation exactly.
func TestGoldenSequences(t *testing.T) {
	g := loadGolden(t)
	for _, seq := range g.Sequences {
		t.Run(seq.Name, func(t *testing.T) {
			ratings := map[string]Rating{}
			handicaps := map[string]Rating{}
			for i, round := range seq.Rounds {
				res := Apply(ratings, handicaps, round.Teams, round.Winner)
				want := seq.Results[i]
				if res.Format != want.Format {
					t.Fatalf("round %d: format %q, want %q", i, res.Format, want.Format)
				}
				for id, c := range want.Players {
					got, ok := res.Players[id]
					if !ok {
						t.Fatalf("round %d: missing player %s", i, id)
					}
					checkRating(t, "before", got.Before, c.Before)
					checkRating(t, "after", got.After, c.After)
				}
				if (res.Handicap == nil) != (want.Handicap == nil) {
					t.Fatalf("round %d: handicap presence differs", i)
				}
				if want.Handicap != nil {
					checkRating(t, "handicap before", res.Handicap.Before, want.Handicap.Before)
					checkRating(t, "handicap after", res.Handicap.After, want.Handicap.After)
				}
			}
			for id, want := range seq.Ratings {
				checkRating(t, "final "+id, ratings[id], want)
			}
			for f, want := range seq.Handicaps {
				checkRating(t, "handicap "+f, handicaps[f], want)
			}
		})
	}
}

func TestGoldenOdds(t *testing.T) {
	for i, c := range loadGolden(t).Odds {
		if got := WinProbability(c.A, c.B, c.Handicaps); !near(got, c.P) {
			t.Fatalf("case %d: got %v, want %v", i, got, c.P)
		}
	}
}

func TestGoldenDisplay(t *testing.T) {
	for i, c := range loadGolden(t).Display {
		if got := Display(c.After); got != c.Display {
			t.Fatalf("case %d: display %d, want %d", i, got, c.Display)
		}
		if got := Delta(c.Before, c.After); got != c.Delta {
			t.Fatalf("case %d: delta %d, want %d", i, got, c.Delta)
		}
	}
}

func TestNewPlayerDisplaysAs1000(t *testing.T) {
	if got := Display(New()); got != 1000 {
		t.Fatalf("got %d", got)
	}
}

func TestFormat(t *testing.T) {
	for _, c := range []struct {
		a, b int
		want string
	}{{1, 1, ""}, {2, 2, ""}, {2, 1, "2v1"}, {1, 2, "2v1"}, {3, 2, "3v2"}} {
		if got := Format(c.a, c.b); got != c.want {
			t.Fatalf("Format(%d,%d) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}

func TestSoloWinGainsMoreThanLossCosts(t *testing.T) {
	win := Apply(map[string]Rating{}, map[string]Rating{}, [2][]string{{"solo"}, {"x", "y"}}, 0).Players["solo"]
	loss := Apply(map[string]Rating{}, map[string]Rating{}, [2][]string{{"solo"}, {"x", "y"}}, 1).Players["solo"]
	if !(win.After.Mu-Mu > Mu-loss.After.Mu) {
		t.Fatalf("win %+v loss %+v", win, loss)
	}
}

func TestHandicapLearnsFromResults(t *testing.T) {
	ratings := map[string]Rating{}
	handicaps := map[string]Rating{}
	for i := 0; i < 60; i++ {
		Apply(ratings, handicaps, [2][]string{{"a", "b"}, {"c"}}, 1)
	}
	if !(handicaps["2v1"].Mu < HandicapMu) {
		t.Fatalf("handicap did not drop: %+v", handicaps["2v1"])
	}
}

func TestBalance(t *testing.T) {
	players := []Candidate{
		{"a", Rating{40, 2}}, {"b", Rating{10, 2}}, {"c", Rating{26, 2}}, {"d", Rating{24, 2}},
	}
	zero := func() float64 { return 0 }
	a, b := Balance(players, nil, zero)
	if len(a) != 2 || len(b) != 2 {
		t.Fatalf("sizes %d/%d", len(a), len(b))
	}
	rs := func(cs []Candidate) []Rating {
		out := make([]Rating, len(cs))
		for i, c := range cs {
			out[i] = c.Rating
		}
		return out
	}
	if p := WinProbability(rs(a), rs(b), nil); math.Abs(p-0.5) > 0.05 {
		t.Fatalf("not balanced: %.3f", p)
	}
	// Odd numbers: sizes differ by one, every player is placed once.
	odd := players[:3]
	x, y := Balance(odd, nil, func() float64 { return 0.9 })
	if len(x)+len(y) != 3 || abs(len(x)-len(y)) != 1 {
		t.Fatalf("%d/%d", len(x), len(y))
	}
	// Two players are always one against one; one player (or too many) is refused.
	if x, y := Balance(players[:2], nil, zero); len(x) != 1 || len(y) != 1 {
		t.Fatal("1v1")
	}
	if x, _ := Balance(players[:1], nil, zero); x != nil {
		t.Fatal("one player")
	}
	if x, _ := Balance(make([]Candidate, MaxBalance+1), nil, zero); x != nil {
		t.Fatal("too many")
	}
}

func TestBalanceVariesAmongNearTies(t *testing.T) {
	var players []Candidate
	for i := 0; i < 6; i++ {
		players = append(players, Candidate{string(rune('a' + i)), New()}) // all equal: many equally fair splits
	}
	seen := map[string]bool{}
	for i := 0; i < 40; i++ {
		r := float64(i) / 40
		a, _ := Balance(players, nil, func() float64 { r = math.Mod(r+0.37, 1); return r })
		key := ""
		for _, c := range a {
			key += c.ID
		}
		seen[key] = true
	}
	if len(seen) < 3 {
		t.Fatalf("only %d different splits", len(seen))
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
