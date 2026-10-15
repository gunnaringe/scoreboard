package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"

	"github.com/gunnaringe/scoreboard/internal/rating"
)

var ctx = context.Background()

// fixture is a store with one group, a game and a few players.
type fixture struct {
	t       *testing.T
	s       *Store
	group   Group
	gameID  string
	players []string // ids
	names   map[string]string
	clock   time.Time
}

func newFixture(t *testing.T, nPlayers int) *fixture {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	f := &fixture{t: t, s: s, names: map[string]string{}, clock: time.Date(2026, 10, 10, 8, 0, 0, 0, time.UTC)}
	s.Now = func() time.Time { return f.clock }
	cg, err := s.CreateGroup(ctx, "Office", "Rocket League", false, "")
	if err != nil {
		t.Fatal(err)
	}
	f.group, f.gameID = cg.Group, cg.GameID
	for i := 0; i < nPlayers; i++ {
		name := fmt.Sprintf("P%d", i)
		p, err := s.CreatePlayer(ctx, f.group.ID, name)
		if err != nil {
			t.Fatal(err)
		}
		f.players = append(f.players, p.ID)
		f.names[p.ID] = name
	}
	return f
}

func (f *fixture) round(a, b []string, winner int) Round {
	f.t.Helper()
	f.clock = f.clock.Add(time.Minute)
	r, err := f.s.CreateRound(ctx, f.group.ID, f.gameID, "", RoundInput{Teams: [2][]string{a, b}, Winner: winner})
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}

func (f *fixture) allRounds() []Round {
	f.t.Helper()
	var out []Round
	cursor := ""
	for {
		page, next, err := f.s.ListRounds(ctx, f.group.ID, f.gameID, RoundFilter{Before: cursor, Limit: 200})
		if err != nil {
			f.t.Fatal(err)
		}
		out = append(out, page...)
		if next == "" {
			break
		}
		cursor = next
	}
	// oldest first
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// verify recomputes everything from the surviving rounds with the rating
// package and compares it with what the store holds.
func (f *fixture) verify() {
	f.t.Helper()
	ratings := map[string]rating.Rating{}
	handicaps := map[string]rating.Rating{}
	tally := map[string]counts{}
	game, err := f.s.GetGame(ctx, f.group.ID, f.gameID)
	if err != nil {
		f.t.Fatal(err)
	}
	for _, r := range f.allRounds() {
		var teams [2][]string
		for _, p := range r.Players {
			teams[p.Team] = append(teams[p.Team], p.ID)
		}
		res := rating.Apply(ratings, handicaps, teams, r.Winner, game.RatingSpeed)
		for _, p := range r.Players {
			c := res.Players[p.ID]
			if p.Before == nil || !near(p.Before.Mu, c.Before.Mu) || !near(p.After.Mu, c.After.Mu) || !near(p.After.Sigma, c.After.Sigma) {
				f.t.Fatalf("round %s player %s: stored %+v/%+v, want %+v", r.ID, f.names[p.ID], p.Before, p.After, c)
			}
			k := tally[p.ID]
			k.rounds++
			if p.Team == r.Winner {
				k.wins++
			}
			tally[p.ID] = k
		}
	}
	v, err := f.s.GetGameView(ctx, f.group.ID, f.gameID, 0, 0)
	if err != nil {
		f.t.Fatal(err)
	}
	if len(v.Ratings) != len(ratings) {
		f.t.Fatalf("%d rating rows, want %d", len(v.Ratings), len(ratings))
	}
	for _, r := range v.Ratings {
		want := ratings[r.PlayerID]
		if !near(r.Mu, want.Mu) || !near(r.Sigma, want.Sigma) {
			f.t.Fatalf("%s: stored %v/%v, want %+v", f.names[r.PlayerID], r.Mu, r.Sigma, want)
		}
		if r.Rounds != tally[r.PlayerID].rounds || r.Wins != tally[r.PlayerID].wins {
			f.t.Fatalf("%s: tally %d/%d, want %+v", f.names[r.PlayerID], r.Rounds, r.Wins, tally[r.PlayerID])
		}
	}
	if len(v.Handicaps) != len(handicaps) {
		f.t.Fatalf("%d handicaps, want %d", len(v.Handicaps), len(handicaps))
	}
	for _, h := range v.Handicaps {
		if want := handicaps[h.Format]; !near(h.Mu, want.Mu) || !near(h.Sigma, want.Sigma) {
			f.t.Fatalf("handicap %s: %+v, want %+v", h.Format, h, want)
		}
	}
}

func TestIncrementalEqualsReplay(t *testing.T) {
	f := newFixture(t, 6)
	p := f.players
	f.round(p[0:1], p[1:2], 0)
	f.round(p[0:2], p[2:4], 1)
	f.round(p[0:2], p[2:3], 0) // 2v1
	f.round(p[3:4], p[4:6], 1) // 1v2
	f.verify()
	before, _ := f.s.GetGameView(ctx, f.group.ID, f.gameID, 0, 0)
	if err := f.s.Recalculate(ctx, f.group.ID, f.gameID); err != nil {
		t.Fatal(err)
	}
	after, _ := f.s.GetGameView(ctx, f.group.ID, f.gameID, 0, 0)
	for i := range before.Ratings {
		for _, r := range after.Ratings {
			if r.PlayerID == before.Ratings[i].PlayerID && !near(r.Mu, before.Ratings[i].Mu) {
				t.Fatalf("recalc moved %s", f.names[r.PlayerID])
			}
		}
	}
}

func TestRatingSpeedReratesTheGame(t *testing.T) {
	f := newFixture(t, 3)
	p := f.players
	for i := 0; i < 30; i++ {
		f.round(p[i%3:i%3+1], p[(i+1)%3:(i+1)%3+1], i%2)
	}
	speedOf := func() rating.Speed {
		g, err := f.s.GetGame(ctx, f.group.ID, f.gameID)
		if err != nil {
			t.Fatal(err)
		}
		return g.RatingSpeed
	}
	sigma := func() float64 {
		v, _ := f.s.GetGameView(ctx, f.group.ID, f.gameID, 0, 0)
		return v.Ratings[0].Sigma
	}
	if speedOf() != rating.Steady {
		t.Fatalf("new games must be steady, got %q", speedOf())
	}
	steadySigma := sigma()
	version, _ := f.s.GameVersion(ctx, f.group.ID, f.gameID)
	fast := "fast"
	if err := f.s.UpdateGame(ctx, f.group.ID, f.gameID, GamePatch{RatingSpeed: &fast}); err != nil {
		t.Fatal(err)
	}
	if speedOf() != rating.Fast || !(sigma() > steadySigma) {
		t.Fatalf("speed %q sigma %v (steady %v)", speedOf(), sigma(), steadySigma)
	}
	if v, _ := f.s.GameVersion(ctx, f.group.ID, f.gameID); v == version {
		t.Fatal("version not bumped, screens would not reload")
	}
	f.verify()                 // replayed with the new speed
	f.round(p[0:1], p[1:2], 0) // and new rounds use it too
	f.verify()

	steady := "steady"
	if err := f.s.UpdateGame(ctx, f.group.ID, f.gameID, GamePatch{RatingSpeed: &steady}); err != nil {
		t.Fatal(err)
	}
	f.verify()
	for _, bad := range []string{"", "ludicrous"} {
		if err := f.s.UpdateGame(ctx, f.group.ID, f.gameID, GamePatch{RatingSpeed: &bad}); err == nil {
			t.Fatalf("speed %q accepted", bad)
		}
	}
}

// Random creates, edits, deletes and restores always leave exactly what a
// from-scratch replay gives.
func TestRandomOperationsMatchReplay(t *testing.T) {
	for _, seed := range []int64{1, 2, 3} {
		t.Run(fmt.Sprint(seed), func(t *testing.T) {
			f := newFixture(t, 7)
			rnd := rand.New(rand.NewSource(seed))
			randomTeams := func() [2][]string {
				ids := append([]string(nil), f.players...)
				rnd.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
				sizes := [][2]int{{1, 1}, {2, 2}, {2, 2}, {3, 3}, {2, 1}, {1, 2}, {3, 2}}[rnd.Intn(7)]
				return [2][]string{ids[:sizes[0]], ids[sizes[0] : sizes[0]+sizes[1]]}
			}
			var live, dead []string
			for i := 0; i < 160; i++ {
				f.clock = f.clock.Add(time.Duration(rnd.Intn(3)) * time.Minute) // sometimes the same minute
				op := "create"
				if len(live) >= 5 {
					op = []string{"create", "create", "create", "winner", "teams", "delete", "restore", "score"}[rnd.Intn(8)]
				}
				pick := func() string {
					if rnd.Intn(2) == 0 {
						return live[len(live)-1]
					}
					return live[rnd.Intn(len(live))]
				}
				switch op {
				case "create":
					tm := randomTeams()
					r, err := f.s.CreateRound(ctx, f.group.ID, f.gameID, "", RoundInput{Teams: tm, Winner: rnd.Intn(2)})
					if err != nil {
						t.Fatal(err)
					}
					live = append(live, r.ID)
				case "winner":
					w := rnd.Intn(2)
					if _, err := f.s.UpdateRound(ctx, f.group.ID, pick(), RoundPatch{Winner: &w}); err != nil {
						t.Fatal(err)
					}
				case "teams":
					tm := randomTeams()
					if _, err := f.s.UpdateRound(ctx, f.group.ID, pick(), RoundPatch{Teams: &tm}); err != nil {
						t.Fatal(err)
					}
				case "score":
					if _, err := f.s.UpdateRound(ctx, f.group.ID, pick(), RoundPatch{ScoreA: Some(1), ScoreB: Some(2)}); err != nil {
						t.Fatal(err)
					}
				case "delete":
					k := rnd.Intn(len(live))
					id := live[k]
					live = append(live[:k], live[k+1:]...)
					dead = append(dead, id)
					if err := f.s.SetRoundDeleted(ctx, f.group.ID, id, true); err != nil {
						t.Fatal(err)
					}
				case "restore":
					if len(dead) == 0 {
						continue
					}
					k := rnd.Intn(len(dead))
					id := dead[k]
					dead = append(dead[:k], dead[k+1:]...)
					live = append(live, id)
					if err := f.s.SetRoundDeleted(ctx, f.group.ID, id, false); err != nil {
						t.Fatal(err)
					}
				}
				if i%20 == 0 {
					f.verify()
				}
			}
			// Editing a deleted round's teams, then restoring it, must also be consistent.
			if len(dead) > 0 {
				tm := randomTeams()
				if _, err := f.s.UpdateRound(ctx, f.group.ID, dead[0], RoundPatch{Teams: &tm}); err != nil {
					t.Fatal(err)
				}
				if err := f.s.SetRoundDeleted(ctx, f.group.ID, dead[0], false); err != nil {
					t.Fatal(err)
				}
			}
			f.verify()
		})
	}
}

func TestRoundsNeverShareATimestamp(t *testing.T) {
	f := newFixture(t, 4)
	p := f.players
	var ids []string
	for i := 0; i < 5; i++ { // the clock never moves
		r, err := f.s.CreateRound(ctx, f.group.ID, f.gameID, "", RoundInput{Teams: [2][]string{p[0:1], p[1:2]}, Winner: i % 2})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, r.ID)
	}
	f.verify()
	seen := map[int64]bool{}
	for _, r := range f.allRounds() {
		if seen[r.PlayedAt] {
			t.Fatalf("two rounds at %d", r.PlayedAt)
		}
		seen[r.PlayedAt] = true
	}
	// Paging by (played_at, id) returns every round exactly once.
	var got []string
	cursor := ""
	for {
		page, next, err := f.s.ListRounds(ctx, f.group.ID, f.gameID, RoundFilter{Before: cursor, Limit: 2})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range page {
			got = append(got, r.ID)
		}
		if next == "" {
			break
		}
		cursor = next
	}
	if len(got) != len(ids) {
		t.Fatalf("paged %d rounds, want %d", len(got), len(ids))
	}
}

func TestNamesAreUniqueIgnoringCaseAndInvisibleCharacters(t *testing.T) {
	f := newFixture(t, 1)
	for _, name := range []string{"p0", " P0 ", "P​0", "Ｐ０"} { // fullwidth letters normalise to P0
		_, err := f.s.CreatePlayer(ctx, f.group.ID, name)
		var taken *NameTakenError
		if !errors.As(err, &taken) {
			t.Fatalf("%q: got %v, want name taken", name, err)
		}
		if taken.Existing.ID != f.players[0] {
			t.Fatalf("%q: wrong existing player", name)
		}
	}
	if _, err := f.s.CreatePlayer(ctx, f.group.ID, "   "); err == nil {
		t.Fatal("blank name accepted")
	}
}

func TestLimits(t *testing.T) {
	f := newFixture(t, 2)
	f.s.Limits = Limits{Players: 3, RoundsPerDay: 2, Games: 1, Tournaments: 1}.withDefaults()
	if _, err := f.s.CreatePlayer(ctx, f.group.ID, "Third"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreatePlayer(ctx, f.group.ID, "Fourth"); !errors.Is(err, ErrLimit) {
		t.Fatalf("got %v", err)
	}
	if _, err := f.s.CreateGame(ctx, f.group.ID, "Another", [2]Team{}, ""); !errors.Is(err, ErrLimit) {
		t.Fatalf("got %v", err)
	}
	f.round(f.players[0:1], f.players[1:2], 0)
	f.round(f.players[0:1], f.players[1:2], 1)
	_, err := f.s.CreateRound(ctx, f.group.ID, f.gameID, "", RoundInput{Teams: [2][]string{f.players[0:1], f.players[1:2]}})
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("got %v", err)
	}
}

func TestRoundValidation(t *testing.T) {
	f := newFixture(t, 4)
	p := f.players
	other, err := f.s.CreateGroup(ctx, "Other", "", false, "")
	if err != nil {
		t.Fatal(err)
	}
	stranger, _ := f.s.CreatePlayer(ctx, other.Group.ID, "Stranger")
	strangers := []Player{stranger}
	cases := map[string]RoundInput{
		"same player on both teams": {Teams: [2][]string{p[0:1], p[0:1]}},
		"empty team":                {Teams: [2][]string{p[0:1], nil}},
		"unknown player":            {Teams: [2][]string{p[0:1], {"nope"}}},
		"player from another group": {Teams: [2][]string{p[0:1], {strangers[0].ID}}},
		"no winner":                 {Teams: [2][]string{p[0:1], p[1:2]}, Winner: 2},
		"bad score":                 {Teams: [2][]string{p[0:1], p[1:2]}, ScoreA: ptr(1000)},
		"unknown tournament":        {Teams: [2][]string{p[0:1], p[1:2]}, TournamentID: ptr("nope")},
	}
	for name, in := range cases {
		if _, err := f.s.CreateRound(ctx, f.group.ID, f.gameID, "", in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := f.s.CreateRound(ctx, other.Group.ID, f.gameID, "", RoundInput{Teams: [2][]string{{strangers[0].ID}, p[1:2]}}); !errors.Is(err, ErrNotFound) {
		t.Errorf("game of another group: got %v", err)
	}
}

func ptr[T any](v T) *T { return &v }

func TestGroupsAreIsolated(t *testing.T) {
	f := newFixture(t, 2)
	r := f.round(f.players[0:1], f.players[1:2], 0)
	other, _ := f.s.CreateGroup(ctx, "Other", "Game", false, "")
	if _, err := f.s.GetRound(ctx, other.Group.ID, r.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if err := f.s.SetRoundDeleted(ctx, other.Group.ID, r.ID, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if _, err := f.s.UpdateRound(ctx, other.Group.ID, r.ID, RoundPatch{Winner: ptr(1)}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if _, err := f.s.GetGameView(ctx, other.Group.ID, f.gameID, 0, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestLinks(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cg, err := s.CreateGroup(ctx, "Office", "RL", true, "Mozilla/5.0 (iPhone) Safari/604.1")
	if err != nil {
		t.Fatal(err)
	}
	owner, err := s.Authenticate(ctx, cg.DeviceToken)
	if err != nil || !owner.Owner || owner.Label != "iPhone · Safari" {
		t.Fatalf("creator device: %+v %v", owner, err)
	}

	// Office link: joining makes a member.
	g, token, err := s.Join(ctx, " "+FormatCode(cg.Group.InviteCode)+" ", "")
	if err != nil || g.ID != cg.Group.ID {
		t.Fatalf("join: %v", err)
	}
	member, _ := s.Authenticate(ctx, token)
	if member.Owner {
		t.Fatal("a member must not be an owner")
	}
	if _, _, err := s.Join(ctx, "AAAAAAAA", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown code: %v", err)
	}

	// Owner link: promotes a known device, or makes a new one.
	if _, nt, err := s.ClaimOwner(ctx, cg.OwnerToken, []string{token}, ""); err != nil || nt != "" {
		t.Fatalf("claim with known device: %q %v", nt, err)
	}
	if d, _ := s.Authenticate(ctx, token); !d.Owner {
		t.Fatal("known device not promoted")
	}
	_, nt, err := s.ClaimOwner(ctx, cg.OwnerToken, []string{"unknown"}, "")
	if err != nil || nt == "" {
		t.Fatalf("claim from a new browser: %q %v", nt, err)
	}
	if _, _, err := s.ClaimOwner(ctx, "wrong", nil, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong owner token: %v", err)
	}

	// Rotating replaces a link; the old one stops working.
	newCode, err := s.RotateLink(ctx, cg.Group.ID, "office")
	if err != nil || newCode == FormatCode(cg.Group.InviteCode) {
		t.Fatalf("rotate office: %v", err)
	}
	if _, _, err := s.Join(ctx, cg.Group.InviteCode, ""); !errors.Is(err, ErrNotFound) {
		t.Fatal("old office code still works")
	}
	newDash, _ := s.RotateLink(ctx, cg.Group.ID, "dashboard")
	if _, err := s.GroupByDashboardToken(ctx, cg.Group.DashboardToken); !errors.Is(err, ErrNotFound) {
		t.Fatal("old dashboard link still works")
	}
	if g, err := s.GroupByDashboardToken(ctx, newDash); err != nil || g.ID != cg.Group.ID {
		t.Fatal("new dashboard link broken")
	}
	newOwner, _ := s.RotateLink(ctx, cg.Group.ID, "owner")
	if _, _, err := s.ClaimOwner(ctx, cg.OwnerToken, nil, ""); !errors.Is(err, ErrNotFound) {
		t.Fatal("old owner link still works")
	}
	if _, _, err := s.ClaimOwner(ctx, newOwner, nil, ""); err != nil {
		t.Fatalf("new owner link: %v", err)
	}
	if _, err := s.RotateLink(ctx, cg.Group.ID, "bogus"); !errors.Is(err, ErrNotFound) {
		t.Fatal("unknown link kind accepted")
	}

	// Device cap.
	s.Limits.Devices = 1
	if _, _, err := s.Join(ctx, newCode, ""); !errors.Is(err, ErrLimit) {
		t.Fatalf("device cap: %v", err)
	}
}

func TestTodayWeekAndDisplay(t *testing.T) {
	f := newFixture(t, 3)
	p := f.players
	weekSince := f.clock.UnixMilli()
	f.round(p[0:1], p[1:2], 0) // yesterday: counts for the week, not today
	f.clock = f.clock.Add(24 * time.Hour)
	since := f.clock.UnixMilli()
	f.round(p[0:1], p[2:3], 0)
	f.round(p[0:1], p[1:2], 1)
	v, err := f.s.GetGameView(ctx, f.group.ID, f.gameID, since, weekSince)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]PlayerRating{}
	for _, r := range v.Ratings {
		byID[r.PlayerID] = r
	}
	if byID[p[0]].Today == nil || byID[p[2]].Today == nil || byID[p[1]].Today == nil {
		t.Fatal("everyone played today")
	}
	if !byID[p[0]].Provisional || byID[p[0]].Display == 0 {
		t.Fatalf("display/provisional not filled in: %+v", byID[p[0]])
	}
	// p[2] lost one round today, so today must be negative; and equals the sum of their deltas.
	if *byID[p[2]].Today >= 0 {
		t.Fatalf("p2 today = %d", *byID[p[2]].Today)
	}
	// The week starts before yesterday's round, so it differs from today for
	// the two who played it, and equals today for p[2] (who only played today).
	if byID[p[0]].Week == nil || *byID[p[0]].Week == *byID[p[0]].Today || *byID[p[2]].Week != *byID[p[2]].Today {
		t.Fatalf("week: %+v", byID)
	}
	one, _ := f.s.GetGameView(ctx, f.group.ID, f.gameID, since+365*86400000, since+365*86400000) // nothing since then
	for _, r := range one.Ratings {
		if r.Today != nil || r.Week != nil {
			t.Fatal("today/week set for a period without rounds")
		}
	}
}

func TestMergePlayers(t *testing.T) {
	f := newFixture(t, 4)
	p := f.players
	f.round(p[0:1], p[1:2], 0)
	f.round(p[2:3], p[1:2], 1) // p2 is "p0 under another name"
	f.round(p[2:3], p[3:4], 0)
	if err := f.s.MergePlayers(ctx, f.group.ID, p[0], p[2]); err != nil {
		t.Fatal(err)
	}
	f.verify()
	ps, _ := f.s.ListPlayers(ctx, f.group.ID)
	if len(ps) != 3 {
		t.Fatalf("%d players left", len(ps))
	}
	v, _ := f.s.GetGameView(ctx, f.group.ID, f.gameID, 0, 0)
	for _, r := range v.Ratings {
		if r.PlayerID == p[2] && r.Rounds != 3 {
			t.Fatalf("merged player has %d rounds", r.Rounds)
		}
	}
	// Two people who played together cannot be merged.
	f.round(p[2:3], p[1:2], 0)
	if err := f.s.MergePlayers(ctx, f.group.ID, p[1], p[2]); err == nil {
		t.Fatal("merged players that played in the same round")
	}
	if err := f.s.MergePlayers(ctx, f.group.ID, p[1], p[1]); err == nil {
		t.Fatal("merged a player with themselves")
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	f := newFixture(t, 5)
	p := f.players
	tour, _ := f.s.CreateTournament(ctx, f.group.ID, f.gameID, "Cup")
	medium := "medium"
	if err := f.s.UpdateGame(ctx, f.group.ID, f.gameID, GamePatch{RatingSpeed: &medium,
		Teams: [2]*Team{{Name: "Lions", Color: "red"}, {Color: "teal"}}}); err != nil {
		t.Fatal(err)
	}
	f.round(p[0:1], p[1:2], 0)
	r := f.round(p[0:2], p[2:3], 1)
	f.round(p[3:5], p[0:2], 0)
	gone := f.round(p[0:1], p[4:5], 1)
	if _, err := f.s.UpdateRound(ctx, f.group.ID, r.ID, RoundPatch{TournamentID: Some(tour.ID), ScoreA: Some(1), ScoreB: Some(3)}); err != nil {
		t.Fatal(err)
	}
	if err := f.s.SetRoundDeleted(ctx, f.group.ID, gone.ID, true); err != nil {
		t.Fatal(err)
	}
	exp, err := f.s.Export(ctx, f.group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(exp.Games) != 1 || len(exp.Games[0].Rounds) != 3 {
		t.Fatalf("export: %+v", exp.Games)
	}
	created, err := f.s.Import(ctx, exp, "Copy")
	if err != nil {
		t.Fatal(err)
	}
	games, _ := f.s.ListGames(ctx, created.Group.ID)
	if want := [2]Team{{"Lions", "red"}, {"", "teal"}}; len(games) != 1 || games[0].Teams != want {
		t.Fatalf("teams after import: %+v", games)
	}
	if len(games) != 1 || games[0].RatingSpeed != rating.Medium {
		t.Fatalf("game not imported: %+v", games)
	}
	orig, _ := f.s.GetGameView(ctx, f.group.ID, f.gameID, 0, 0)
	copy, err := f.s.GetGameView(ctx, created.Group.ID, games[0].ID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(copy.Ratings) != len(orig.Ratings) || len(copy.Rounds) != 3 || len(copy.Tournaments) != 1 {
		t.Fatalf("copy: %d ratings, %d rounds, %d tournaments", len(copy.Ratings), len(copy.Rounds), len(copy.Tournaments))
	}
	byName := func(g string, view GameView) map[string]float64 {
		ps, _ := f.s.ListPlayers(ctx, g)
		names := map[string]string{}
		for _, p := range ps {
			names[p.ID] = p.Name
		}
		out := map[string]float64{}
		for _, r := range view.Ratings {
			out[names[r.PlayerID]] = r.Mu
		}
		return out
	}
	a, b := byName(f.group.ID, orig), byName(created.Group.ID, copy)
	for name, mu := range a {
		if !near(mu, b[name]) {
			t.Fatalf("%s: %v in the copy, %v originally", name, b[name], mu)
		}
	}
	if _, err := f.s.Import(ctx, ExportedGroup{Format: 99}, ""); err == nil {
		t.Fatal("unknown format accepted")
	}
}

func TestBackupAndStats(t *testing.T) {
	f := newFixture(t, 2)
	f.round(f.players[0:1], f.players[1:2], 0)
	st, err := f.s.GetStats(ctx)
	if err != nil || st.Groups != 1 || st.Players != 2 || st.Rounds != 1 || st.DatabaseBytes == 0 {
		t.Fatalf("%+v %v", st, err)
	}
	path := t.TempDir() + "/backup.db"
	if err := f.s.Backup(ctx, path); err != nil {
		t.Fatal(err)
	}
	copy, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	if st, _ := copy.GetStats(ctx); st.Rounds != 1 {
		t.Fatalf("backup has %+v", st)
	}
	if err := f.s.Backup(ctx, path); err == nil {
		t.Fatal("overwrote an existing backup")
	}
}

func TestOneVsOneGames(t *testing.T) {
	f := newFixture(t, 3)
	p := f.players
	tt, err := f.s.CreateGame(ctx, f.group.ID, "Table tennis", [2]Team{}, FormatOneVsOne)
	if err != nil || tt.Format != FormatOneVsOne || tt.RatingSpeed != rating.Fast {
		t.Fatalf("1v1 games start fast: %+v %v", tt, err)
	}
	if _, err := f.s.CreateGame(ctx, f.group.ID, "Darts", [2]Team{}, "3v3"); err == nil {
		t.Fatal("unknown format accepted")
	}
	// Only one against one rounds, also when editing.
	round := func(a, b []string) error {
		_, err := f.s.CreateRound(ctx, f.group.ID, tt.ID, "", RoundInput{Teams: [2][]string{a, b}})
		return err
	}
	if err := round(p[0:2], p[2:3]); err == nil {
		t.Fatal("a 2v1 round in a 1v1 game")
	}
	if err := round(p[0:1], p[1:2]); err != nil {
		t.Fatal(err)
	}
	r, _, _ := f.s.ListRounds(ctx, f.group.ID, tt.ID, RoundFilter{})
	teams := [2][]string{p[0:2], p[2:3]}
	if _, err := f.s.UpdateRound(ctx, f.group.ID, r[0].ID, RoundPatch{Teams: &teams}); err == nil {
		t.Fatal("edited into a team round")
	}
	// The fixture's teams game has a 2v1 round (deleted): it can't become 1v1,
	// because the round could be restored.
	team := f.round(p[0:2], p[2:3], 0)
	if err := f.s.SetRoundDeleted(ctx, f.group.ID, team.ID, true); err != nil {
		t.Fatal(err)
	}
	oneVsOne, teamsFormat := FormatOneVsOne, FormatTeams
	if err := f.s.UpdateGame(ctx, f.group.ID, f.gameID, GamePatch{Format: &oneVsOne}); err == nil {
		t.Fatal("switched a game with team rounds to 1v1")
	}
	// Teams is always possible, and back to 1v1 while all rounds are 1v1.
	if err := f.s.UpdateGame(ctx, f.group.ID, tt.ID, GamePatch{Format: &teamsFormat}); err != nil {
		t.Fatal(err)
	}
	if err := f.s.UpdateGame(ctx, f.group.ID, tt.ID, GamePatch{Format: &oneVsOne}); err != nil {
		t.Fatal(err)
	}
	// Export and import keep the format.
	exp, _ := f.s.Export(ctx, f.group.ID)
	created, err := f.s.Import(ctx, exp, "Copy")
	if err != nil {
		t.Fatal(err)
	}
	games, _ := f.s.ListGames(ctx, created.Group.ID)
	formats := map[string]string{}
	for _, g := range games {
		formats[g.Name] = g.Format
	}
	if formats["Rocket League"] != FormatTeams || formats["Table tennis"] != FormatOneVsOne {
		t.Fatalf("formats after import: %v", formats)
	}
}
