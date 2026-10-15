package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/gunnaringe/scoreboard/gen/scoreboard/v1"
	"github.com/gunnaringe/scoreboard/gen/scoreboard/v1/scoreboardv1connect"
	"github.com/gunnaringe/scoreboard/internal/branding"
	"github.com/gunnaringe/scoreboard/internal/config"
	"github.com/gunnaringe/scoreboard/internal/store"
)

type env struct {
	t   *testing.T
	srv *httptest.Server
	st  *store.Store
	c   scoreboardv1connect.ScoreboardServiceClient
}

func newEnv(t *testing.T, mut func(*config.Config), brand *branding.Branding) *env {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.JoinLimit, cfg.WriteLimit = 0, 0
	if mut != nil {
		mut(&cfg)
	}
	if brand == nil {
		brand, _ = branding.Load("")
	}
	app, err := New(st, cfg, brand)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.Handler())
	t.Cleanup(func() { srv.Close(); st.Close() })
	// The web app speaks Connect's JSON encoding, so the tests do too.
	return &env{t: t, srv: srv, st: st, c: scoreboardv1connect.NewScoreboardServiceClient(http.DefaultClient, srv.URL, connect.WithProtoJSON())}
}

// call makes one RPC with a device token.
func call[Q, R any](e *env, fn func(context.Context, *connect.Request[Q]) (*connect.Response[R], error), token string, msg *Q) (*R, error) {
	r := connect.NewRequest(msg)
	if token != "" {
		r.Header().Set("Authorization", "Bearer "+token)
	}
	r.Header().Set("User-Agent", "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/120.0")
	res, err := fn(context.Background(), r)
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

// must is call that fails the test on error.
func must[Q, R any](e *env, fn func(context.Context, *connect.Request[Q]) (*connect.Response[R], error), token string, msg *Q) *R {
	e.t.Helper()
	out, err := call(e, fn, token, msg)
	if err != nil {
		e.t.Fatalf("%v", err)
	}
	return out
}

func wantCode(t *testing.T, err error, want connect.Code) {
	t.Helper()
	if err == nil {
		t.Fatalf("no error, want %s", want)
	}
	if got := connect.CodeOf(err); got != want {
		t.Fatalf("code %s (%v), want %s", got, err, want)
	}
}

func ptr[T any](v T) *T { return &v }

// office is a multi-mode group with an owner device and a game.
type office struct {
	gid, game, owner, ownerLink, code, dash string
}

func (e *env) office() office {
	e.t.Helper()
	r := must(e, e.c.CreateGroup, "", &pb.CreateGroupRequest{Name: "Office", GameName: "Rocket League"})
	o := office{gid: r.GroupId, game: r.GameId, owner: r.DeviceToken, ownerLink: r.OwnerToken}
	e.player(o.owner, "Ada")
	g := must(e, e.c.GetGroup, o.owner, &pb.GetGroupRequest{})
	o.code, o.dash = g.Group.OfficeCode, g.Group.DashboardToken
	return o
}

func (e *env) join(o office) string {
	e.t.Helper()
	return must(e, e.c.Join, "", &pb.JoinRequest{Code: strings.ToLower(o.code)}).DeviceToken
}

func (e *env) player(token, name string) string {
	e.t.Helper()
	return must(e, e.c.CreatePlayer, token, &pb.CreatePlayerRequest{Name: name}).Player.Id
}

func (e *env) round(o office, token string, a, b []string, winner int32) (*pb.CreateRoundResponse, error) {
	return call(e, e.c.CreateRound, token, &pb.CreateRoundRequest{GameId: o.game, TeamA: a, TeamB: b, Winner: winner})
}

func TestMultiLinksAndPermissions(t *testing.T) {
	e := newEnv(t, nil, nil)
	o := e.office()
	member := e.join(o)

	// Not joined, wrong group, and no token are all unauthenticated.
	_, err := call(e, e.c.GetGroup, "", &pb.GetGroupRequest{})
	wantCode(t, err, connect.CodeUnauthenticated)
	_, err = call(e, e.c.GetGroup, "nope", &pb.GetGroupRequest{})
	wantCode(t, err, connect.CodeUnauthenticated)
	_, err = call(e, e.c.Join, "", &pb.JoinRequest{Code: "AAAA-AAAA"})
	wantCode(t, err, connect.CodeNotFound)
	other := e.office()
	g := must(e, e.c.GetGroup, other.owner, &pb.GetGroupRequest{})
	if g.Group.Id == o.gid {
		t.Fatal("tokens must be per group")
	}

	// Members run the games; only owners touch links, group settings and devices.
	if must(e, e.c.GetGroup, member, &pb.GetGroupRequest{}).Me.Owner {
		t.Fatal("member is an owner")
	}
	must(e, e.c.UpdateGame, member, &pb.UpdateGameRequest{GameId: o.game, TeamA: &pb.Team{Name: "Lions"}})
	_, err = call(e, e.c.UpdateGroup, member, &pb.UpdateGroupRequest{Name: ptr("x")})
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = call(e, e.c.DeleteGroup, member, &pb.DeleteGroupRequest{})
	wantCode(t, err, connect.CodePermissionDenied)
	for _, kind := range []pb.LinkKind{pb.LinkKind_LINK_KIND_OFFICE, pb.LinkKind_LINK_KIND_DASHBOARD, pb.LinkKind_LINK_KIND_OWNER} {
		_, err = call(e, e.c.RotateLink, member, &pb.RotateLinkRequest{Kind: kind})
		wantCode(t, err, connect.CodePermissionDenied)
	}
	_, err = call(e, e.c.ListDevices, member, &pb.ListDevicesRequest{})
	wantCode(t, err, connect.CodePermissionDenied)

	// Owners see devices; anyone can leave with their own, but not remove others.
	devs := must(e, e.c.ListDevices, o.owner, &pb.ListDevicesRequest{}).Devices
	if len(devs) != 2 {
		t.Fatalf("%d devices", len(devs))
	}
	var memberDevice, ownerDevice string
	for _, d := range devs {
		if d.Owner {
			ownerDevice = d.Id
			if !d.IsMe {
				t.Fatal("is_me missing")
			}
		} else {
			memberDevice = d.Id
		}
	}
	_, err = call(e, e.c.RemoveDevice, member, &pb.RemoveDeviceRequest{DeviceId: ownerDevice})
	wantCode(t, err, connect.CodePermissionDenied)
	must(e, e.c.RemoveDevice, member, &pb.RemoveDeviceRequest{DeviceId: memberDevice})
	_, err = call(e, e.c.GetGroup, member, &pb.GetGroupRequest{})
	wantCode(t, err, connect.CodeUnauthenticated)

	// Dashboard: read-only, no device.
	must(e, e.c.GetDashboard, "", &pb.GetDashboardRequest{Token: o.dash})
	must(e, e.c.GetDashboardGame, "", &pb.GetDashboardGameRequest{Token: o.dash, GameId: o.game})
	_, err = call(e, e.c.GetDashboard, "", &pb.GetDashboardRequest{Token: "wrongtoken"})
	wantCode(t, err, connect.CodeNotFound)
	_, err = call(e, e.c.GetDashboardGame, "", &pb.GetDashboardGameRequest{Token: o.dash, GameId: "someone-elses"})
	wantCode(t, err, connect.CodeNotFound)

	// Owner link: a member browser becomes an owner; new links replace old ones.
	m2 := e.join(o)
	r := must(e, e.c.ClaimOwner, "", &pb.ClaimOwnerRequest{Token: o.ownerLink, KnownTokens: []string{m2}})
	if r.DeviceToken != "" {
		t.Fatal("promoting a known device must not issue a new token")
	}
	must(e, e.c.ListDevices, m2, &pb.ListDevicesRequest{})
	fresh := must(e, e.c.ClaimOwner, "", &pb.ClaimOwnerRequest{Token: o.ownerLink}).DeviceToken
	must(e, e.c.ListDevices, fresh, &pb.ListDevicesRequest{})
	_, err = call(e, e.c.ClaimOwner, "", &pb.ClaimOwnerRequest{Token: "wrong"})
	wantCode(t, err, connect.CodeNotFound)

	newCode := must(e, e.c.RotateLink, o.owner, &pb.RotateLinkRequest{Kind: pb.LinkKind_LINK_KIND_OFFICE}).OfficeCode
	if newCode == o.code {
		t.Fatal("office code did not change")
	}
	_, err = call(e, e.c.Join, "", &pb.JoinRequest{Code: o.code})
	wantCode(t, err, connect.CodeNotFound)
	must(e, e.c.Join, "", &pb.JoinRequest{Code: newCode})
	newDash := must(e, e.c.RotateLink, o.owner, &pb.RotateLinkRequest{Kind: pb.LinkKind_LINK_KIND_DASHBOARD}).DashboardToken
	_, err = call(e, e.c.GetDashboard, "", &pb.GetDashboardRequest{Token: o.dash})
	wantCode(t, err, connect.CodeNotFound)
	must(e, e.c.GetDashboard, "", &pb.GetDashboardRequest{Token: newDash})
	newOwner := must(e, e.c.RotateLink, o.owner, &pb.RotateLinkRequest{Kind: pb.LinkKind_LINK_KIND_OWNER}).OwnerToken
	_, err = call(e, e.c.ClaimOwner, "", &pb.ClaimOwnerRequest{Token: o.ownerLink})
	wantCode(t, err, connect.CodeNotFound)
	must(e, e.c.ClaimOwner, "", &pb.ClaimOwnerRequest{Token: newOwner})
	_, err = call(e, e.c.RotateLink, o.owner, &pb.RotateLinkRequest{})
	wantCode(t, err, connect.CodeInvalidArgument)

	must(e, e.c.UpdateGroup, o.owner, &pb.UpdateGroupRequest{Name: ptr("Renamed")})
	if must(e, e.c.GetGroup, o.owner, &pb.GetGroupRequest{}).Group.Name != "Renamed" {
		t.Fatal("rename lost")
	}
	must(e, e.c.DeleteGroup, o.owner, &pb.DeleteGroupRequest{})
	_, err = call(e, e.c.GetGroup, o.owner, &pb.GetGroupRequest{})
	wantCode(t, err, connect.CodeUnauthenticated)
}

func TestRoundsThroughTheAPI(t *testing.T) {
	e := newEnv(t, nil, nil)
	o := e.office()
	bob := e.player(o.owner, "Bob")
	cy := e.player(o.owner, "Cy")
	g := must(e, e.c.GetGroup, o.owner, &pb.GetGroupRequest{})
	ada := ""
	for _, p := range g.Players {
		if p.Name == "Ada" {
			ada = p.Id
		}
	}

	// A taken name returns the existing player instead of failing.
	dup := must(e, e.c.CreatePlayer, o.owner, &pb.CreatePlayerRequest{Name: " bob "})
	if !dup.Existed || dup.Player.Id != bob {
		t.Fatalf("%+v", dup)
	}

	r, err := e.round(o, o.owner, []string{ada}, []string{bob, cy}, 0)
	if err != nil {
		t.Fatal(err)
	}
	round := r.Round
	if len(round.Players) != 3 {
		t.Fatalf("%+v", round)
	}
	for _, p := range round.Players {
		if p.Before == nil || p.After == nil {
			t.Fatal("ratings missing")
		}
	}
	for name, req := range map[string]*pb.CreateRoundRequest{
		"same player on both teams": {GameId: o.game, TeamA: []string{ada}, TeamB: []string{ada}},
		"empty team":                {GameId: o.game, TeamA: []string{ada}},
		"unknown player":            {GameId: o.game, TeamA: []string{ada}, TeamB: []string{"nope"}},
		"bad winner":                {GameId: o.game, TeamA: []string{ada}, TeamB: []string{bob}, Winner: 2},
		"bad score":                 {GameId: o.game, TeamA: []string{ada}, TeamB: []string{bob}, ScoreA: ptr(int32(1000))},
		"unknown tournament":        {GameId: o.game, TeamA: []string{ada}, TeamB: []string{bob}, TournamentId: ptr("nope")},
	} {
		if _, err := call(e, e.c.CreateRound, o.owner, req); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}

	// The game view carries what the page shows, already computed.
	view := must(e, e.c.GetGame, o.owner, &pb.GetGameRequest{GameId: o.game, Since: timestamppb.New(time.UnixMilli(1))}).View
	if len(view.Ratings) != 3 || len(view.Handicaps) != 1 || view.Handicaps[0].Format != "2v1" {
		t.Fatalf("%+v", view)
	}
	for _, pr := range view.Ratings {
		if pr.Display == 0 || !pr.Provisional || pr.Today == nil {
			t.Errorf("%+v", pr)
		}
	}
	v1 := view.Version

	// Patches tell "unchanged" from "clear".
	first := func() *pb.Round {
		return must(e, e.c.ListRounds, o.owner, &pb.ListRoundsRequest{GameId: o.game}).Rounds[0]
	}
	must(e, e.c.UpdateRound, o.owner, &pb.UpdateRoundRequest{RoundId: round.Id, Score: &pb.RoundScore{A: ptr(int32(3)), B: ptr(int32(1))}})
	if got := first(); got.GetScoreA() != 3 || got.GetScoreB() != 1 {
		t.Fatalf("%+v", got)
	}
	must(e, e.c.UpdateRound, o.owner, &pb.UpdateRoundRequest{RoundId: round.Id, Score: &pb.RoundScore{B: ptr(int32(1))}})
	if got := first(); got.ScoreA != nil || got.GetScoreB() != 1 {
		t.Fatalf("an absent score should clear: %+v", got)
	}
	must(e, e.c.UpdateRound, o.owner, &pb.UpdateRoundRequest{RoundId: round.Id, Score: &pb.RoundScore{}})
	if got := first(); got.ScoreA != nil || got.ScoreB != nil {
		t.Fatalf("{} should clear both: %+v", got)
	}
	tour := must(e, e.c.CreateTournament, o.owner, &pb.CreateTournamentRequest{GameId: o.game, Name: "Cup"}).Tournament
	must(e, e.c.UpdateRound, o.owner, &pb.UpdateRoundRequest{RoundId: round.Id, Tournament: &pb.RoundTournament{Id: &tour.Id}})
	if first().GetTournamentId() != tour.Id {
		t.Fatal("tournament not set")
	}
	must(e, e.c.UpdateRound, o.owner, &pb.UpdateRoundRequest{RoundId: round.Id, Tournament: &pb.RoundTournament{}})
	if first().TournamentId != nil {
		t.Fatal("tournament not cleared")
	}
	must(e, e.c.UpdateTournament, o.owner, &pb.UpdateTournamentRequest{TournamentId: tour.Id, Ended: ptr(true)})
	// Teams: a name and a colour each. New games are blue and orange, unnamed.
	game := must(e, e.c.GetGroup, o.owner, &pb.GetGroupRequest{}).Games[0]
	if game.TeamA.GetName() != "" || game.TeamA.GetColor() != pb.TeamColor_TEAM_COLOR_BLUE || game.TeamB.GetColor() != pb.TeamColor_TEAM_COLOR_ORANGE {
		t.Fatalf("default teams: %+v", game)
	}
	must(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game,
		TeamA: &pb.Team{Name: "Lions", Color: pb.TeamColor_TEAM_COLOR_RED}, TeamB: &pb.Team{Name: "Tigers", Color: pb.TeamColor_TEAM_COLOR_GREEN}})
	// UNSPECIFIED keeps the colour; an empty name means "goes by its colour".
	must(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game, TeamA: &pb.Team{Name: " "}})
	game = must(e, e.c.GetGroup, o.owner, &pb.GetGroupRequest{}).Games[0]
	if game.TeamA.GetName() != "" || game.TeamA.GetColor() != pb.TeamColor_TEAM_COLOR_RED ||
		game.TeamB.GetName() != "Tigers" || game.TeamB.GetColor() != pb.TeamColor_TEAM_COLOR_GREEN {
		t.Fatalf("teams: %+v", game)
	}
	// The two teams can't share a colour, and only known colours are taken.
	_, err = call(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game, TeamB: &pb.Team{Color: pb.TeamColor_TEAM_COLOR_RED}})
	wantCode(t, err, connect.CodeInvalidArgument)
	_, err = call(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game, TeamB: &pb.Team{Color: pb.TeamColor(99)}})
	wantCode(t, err, connect.CodeInvalidArgument)
	if game.Format != pb.GameFormat_GAME_FORMAT_TEAMS {
		t.Fatalf("format: %v", game.Format)
	}
	_, err = call(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game, Format: pb.GameFormat_GAME_FORMAT_UNSPECIFIED.Enum()})
	wantCode(t, err, connect.CodeInvalidArgument)
	tt := must(e, e.c.CreateGame, o.owner, &pb.CreateGameRequest{Name: "Table tennis", Format: pb.GameFormat_GAME_FORMAT_ONE_VS_ONE}).Game
	if tt.Format != pb.GameFormat_GAME_FORMAT_ONE_VS_ONE || tt.RatingSpeed != pb.RatingSpeed_RATING_SPEED_FAST {
		t.Fatalf("1v1 game: %+v", tt)
	}
	g2 := must(e, e.c.CreateGame, o.owner, &pb.CreateGameRequest{Name: "Pool", TeamB: &pb.Team{Color: pb.TeamColor_TEAM_COLOR_PURPLE}}).Game
	if g2.TeamA.GetColor() != pb.TeamColor_TEAM_COLOR_BLUE || g2.TeamB.GetColor() != pb.TeamColor_TEAM_COLOR_PURPLE {
		t.Fatalf("create with a colour: %+v", g2)
	}
	if game.RatingSpeed != pb.RatingSpeed_RATING_SPEED_STEADY {
		t.Fatalf("speed: %v", game.RatingSpeed)
	}
	vs := must(e, e.c.GetGameVersion, o.owner, &pb.GetGameVersionRequest{GameId: o.game}).Version
	must(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game, RatingSpeed: pb.RatingSpeed_RATING_SPEED_FAST.Enum()})
	if g := must(e, e.c.GetGroup, o.owner, &pb.GetGroupRequest{}).Games[0]; g.RatingSpeed != pb.RatingSpeed_RATING_SPEED_FAST {
		t.Fatalf("speed not set: %v", g.RatingSpeed)
	}
	if v := must(e, e.c.GetGameVersion, o.owner, &pb.GetGameVersionRequest{GameId: o.game}).Version; v <= vs {
		t.Fatal("changing the speed did not bump the version")
	}
	_, err = call(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game, RatingSpeed: pb.RatingSpeed_RATING_SPEED_UNSPECIFIED.Enum()})
	wantCode(t, err, connect.CodeInvalidArgument)
	must(e, e.c.UpdateGame, o.owner, &pb.UpdateGameRequest{GameId: o.game, RatingSpeed: pb.RatingSpeed_RATING_SPEED_STEADY.Enum()})

	// Every change bumps the version polling screens watch.
	must(e, e.c.UpdateRound, o.owner, &pb.UpdateRoundRequest{RoundId: round.Id, Winner: ptr(int32(1))})
	if v2 := must(e, e.c.GetGameVersion, o.owner, &pb.GetGameVersionRequest{GameId: o.game}).Version; v2 <= v1 {
		t.Fatal("version did not move")
	}
	must(e, e.c.DeleteRound, o.owner, &pb.DeleteRoundRequest{RoundId: round.Id})
	must(e, e.c.RestoreRound, o.owner, &pb.RestoreRoundRequest{RoundId: round.Id})
	_, err = call(e, e.c.UpdateRound, o.owner, &pb.UpdateRoundRequest{RoundId: "nope", Winner: ptr(int32(1))})
	wantCode(t, err, connect.CodeNotFound)

	// History paging clamps silly sizes instead of returning everything.
	for i := 0; i < 5; i++ {
		if _, err := e.round(o, o.owner, []string{ada}, []string{bob}, int32(i%2)); err != nil {
			t.Fatal(err)
		}
	}
	one := must(e, e.c.ListRounds, o.owner, &pb.ListRoundsRequest{GameId: o.game, Limit: -2})
	if len(one.Rounds) != 1 || one.NextCursor == "" {
		t.Fatalf("limit=-2: %+v", one)
	}
	page := must(e, e.c.ListRounds, o.owner, &pb.ListRoundsRequest{GameId: o.game, Limit: 3, Before: one.NextCursor})
	if len(page.Rounds) != 3 {
		t.Fatalf("%+v", page)
	}
	if huge := must(e, e.c.ListRounds, o.owner, &pb.ListRoundsRequest{GameId: o.game, Limit: 100000}); len(huge.Rounds) != 6 {
		t.Fatalf("%d rounds", len(huge.Rounds))
	}
	stats := must(e, e.c.GetPlayerStats, o.owner, &pb.GetPlayerStatsRequest{GameId: o.game, PlayerId: ada})
	if len(stats.History) != 6 || stats.History[0].PlayedAt == nil || stats.History[0].Display == 0 {
		t.Fatalf("%+v", stats)
	}
	if len(stats.With)+len(stats.Against) == 0 {
		t.Fatal("no head-to-head")
	}
}

func TestPreviewAndSuggest(t *testing.T) {
	e := newEnv(t, nil, nil)
	o := e.office()
	var ids []string
	for _, n := range []string{"Bob", "Cy", "Dee", "Eve"} {
		ids = append(ids, e.player(o.owner, n))
	}
	ada := e.player(o.owner, "Ada") // already exists: returns her id
	// Ada beats everyone, repeatedly: she becomes the favourite.
	for i := 0; i < 12; i++ {
		if _, err := e.round(o, o.owner, []string{ada}, []string{ids[i%4]}, 0); err != nil {
			t.Fatal(err)
		}
	}
	prob := func(a, b []string) float64 {
		return must(e, e.c.PreviewRound, o.owner, &pb.PreviewRoundRequest{GameId: o.game, TeamA: a, TeamB: b}).WinProbabilityA
	}
	if p := prob([]string{ada}, []string{ids[0]}); p < 0.6 {
		t.Fatalf("the winner should be the favourite: %.2f", p)
	}
	if p, q := prob([]string{ada}, []string{ids[0]}), prob([]string{ids[0]}, []string{ada}); p+q < 0.999 || p+q > 1.001 {
		t.Fatalf("odds should be complementary: %v %v", p, q)
	}
	if p := prob([]string{ids[0], ids[1]}, []string{ids[2], ids[3]}); p < 0.2 || p > 0.8 {
		t.Fatalf("%v", p)
	}
	_, err := call(e, e.c.PreviewRound, o.owner, &pb.PreviewRoundRequest{GameId: o.game, TeamA: []string{ada}, TeamB: []string{ada}})
	wantCode(t, err, connect.CodeInvalidArgument)

	// Suggested teams are fair and use everyone exactly once.
	all := append([]string{ada}, ids...)
	s := must(e, e.c.SuggestTeams, o.owner, &pb.SuggestTeamsRequest{GameId: o.game, PlayerIds: all})
	if len(s.TeamA)+len(s.TeamB) != 5 || len(s.TeamA) < 2 || len(s.TeamA) > 3 {
		t.Fatalf("%+v", s)
	}
	seen := map[string]bool{}
	for _, id := range append(append([]string{}, s.TeamA...), s.TeamB...) {
		if seen[id] {
			t.Fatalf("%s twice", id)
		}
		seen[id] = true
	}
	// It is as fair as any split can be (within the 3 points of random variety it allows).
	best := 1.0
	for mask := 1; mask < 1<<5; mask++ {
		var a, b []string
		for i, id := range all {
			if mask&(1<<i) != 0 {
				a = append(a, id)
			} else {
				b = append(b, id)
			}
		}
		if len(a) < 2 || len(a) > 3 || len(b) < 2 || len(b) > 3 {
			continue
		}
		if gap := abs(prob(a, b) - 0.5); gap < best {
			best = gap
		}
	}
	if gap := abs(s.WinProbabilityA - 0.5); gap > best+0.03+1e-9 {
		t.Fatalf("suggested split is %.3f from even, the best possible is %.3f", gap, best)
	}
	// With Ada far ahead, she shouldn't end up alone against the weakest.
	two := must(e, e.c.SuggestTeams, o.owner, &pb.SuggestTeamsRequest{GameId: o.game, PlayerIds: all[:4]})
	if len(two.TeamA) != 2 || len(two.TeamB) != 2 {
		t.Fatalf("%+v", two)
	}
	for _, bad := range [][]string{{ada}, nil, make([]string, 15), {ada, "nope"}, {ada, ada}} {
		_, err := call(e, e.c.SuggestTeams, o.owner, &pb.SuggestTeamsRequest{GameId: o.game, PlayerIds: bad})
		wantCode(t, err, connect.CodeInvalidArgument)
	}
	_, err = call(e, e.c.SuggestTeams, "", &pb.SuggestTeamsRequest{GameId: o.game, PlayerIds: all})
	wantCode(t, err, connect.CodeUnauthenticated)
}

func TestRateLimits(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.JoinLimit = 3 }, nil)
	for i := 0; i < 3; i++ {
		must(e, e.c.CreateGroup, "", &pb.CreateGroupRequest{Name: fmt.Sprint("G", i)})
	}
	_, err := call(e, e.c.CreateGroup, "", &pb.CreateGroupRequest{Name: "one too many"})
	wantCode(t, err, connect.CodeResourceExhausted)
	if !strings.Contains(err.Error(), msgJoinLimited) {
		t.Fatal(err)
	}

	e2 := newEnv(t, func(c *config.Config) { c.WriteLimit = 2 }, nil)
	o := e2.office() // adds Ada: one write
	e2.player(o.owner, "A")
	_, err = call(e2, e2.c.CreatePlayer, o.owner, &pb.CreatePlayerRequest{Name: "C"})
	wantCode(t, err, connect.CodeResourceExhausted)
	if !strings.Contains(err.Error(), msgRateLimited) {
		t.Fatal(err)
	}
	must(e2, e2.c.GetGroup, o.owner, &pb.GetGroupRequest{}) // reading is never limited
}

func TestGroupCreationCanBeSwitchedOff(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.AllowGroupCreation = false }, nil)
	_, err := call(e, e.c.CreateGroup, "", &pb.CreateGroupRequest{Name: "Nope"})
	wantCode(t, err, connect.CodePermissionDenied)
	if must(e, e.c.GetInstance, "", &pb.GetInstanceRequest{}).AllowGroupCreation {
		t.Fatal("instance still says creation is allowed")
	}
	// The operator can still make groups, and people join them.
	cg, err := e.st.CreateGroup(context.Background(), "Made by operator", "RL", false, "")
	if err != nil {
		t.Fatal(err)
	}
	must(e, e.c.Join, "", &pb.JoinRequest{Code: cg.Group.InviteCode})
}

func TestSingleMode(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.Mode = config.ModeSingle; c.GroupName = "Oslo" }, nil)
	inst := must(e, e.c.GetInstance, "", &pb.GetInstanceRequest{})
	if inst.Mode != pb.Mode_MODE_SINGLE || inst.GroupId != "main" || !inst.DashboardEnabled || inst.AllowGroupCreation {
		t.Fatalf("%+v", inst)
	}
	// No groups, no owner links; joining needs no code.
	_, err := call(e, e.c.CreateGroup, "", &pb.CreateGroupRequest{Name: "X"})
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = call(e, e.c.ClaimOwner, "", &pb.ClaimOwnerRequest{Token: "x"})
	wantCode(t, err, connect.CodeNotFound)
	j := must(e, e.c.Join, "", &pb.JoinRequest{})
	tok := j.DeviceToken
	if j.GroupId != "main" || j.Name != "Oslo" {
		t.Fatalf("%+v", j)
	}
	g := must(e, e.c.GetGroup, tok, &pb.GetGroupRequest{})
	if g.Group.DashboardToken != "main" || g.Group.OfficeCode != "" {
		t.Fatalf("%+v", g.Group)
	}
	// Members manage players and games; nobody is an owner (the CLI administers).
	game := must(e, e.c.CreateGame, tok, &pb.CreateGameRequest{Name: "Table tennis"}).Game.Id
	a := must(e, e.c.CreatePlayer, tok, &pb.CreatePlayerRequest{Name: "Ada"}).Player.Id
	b := must(e, e.c.CreatePlayer, tok, &pb.CreatePlayerRequest{Name: "Bob"}).Player.Id
	must(e, e.c.CreateRound, tok, &pb.CreateRoundRequest{GameId: game, TeamA: []string{a}, TeamB: []string{b}})
	_, err = call(e, e.c.UpdateGroup, tok, &pb.UpdateGroupRequest{Name: ptr("x")})
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = call(e, e.c.DeleteGroup, tok, &pb.DeleteGroupRequest{})
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = call(e, e.c.RotateLink, tok, &pb.RotateLinkRequest{Kind: pb.LinkKind_LINK_KIND_OFFICE})
	wantCode(t, err, connect.CodePermissionDenied)
	_, err = call(e, e.c.ListDevices, tok, &pb.ListDevicesRequest{})
	wantCode(t, err, connect.CodePermissionDenied)
	// The dashboard is open at /d (token "main").
	d := must(e, e.c.GetDashboard, "", &pb.GetDashboardRequest{Token: "main"})
	if d.GroupName != "Oslo" || len(d.Games) != 1 {
		t.Fatalf("%+v", d)
	}
	must(e, e.c.GetDashboardGame, "", &pb.GetDashboardGameRequest{Token: "main", GameId: game})
	_, err = call(e, e.c.GetDashboard, "", &pb.GetDashboardRequest{Token: "other"})
	wantCode(t, err, connect.CodeNotFound)
}

func TestSingleModeDashboardOff(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.Mode = config.ModeSingle; c.Dashboard = "off" }, nil)
	_, err := call(e, e.c.GetDashboard, "", &pb.GetDashboardRequest{Token: "main"})
	wantCode(t, err, connect.CodeNotFound)
	if must(e, e.c.GetInstance, "", &pb.GetInstanceRequest{}).DashboardEnabled {
		t.Fatal("dashboard still enabled")
	}
}

// The JSON the browser sends and receives: field names, defaults, int64 as strings.
func TestJSONWireFormat(t *testing.T) {
	e := newEnv(t, nil, nil)
	post := func(method, token, body string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", e.srv.URL+"/scoreboard.v1.ScoreboardService/"+method, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("%s: %s", method, raw)
		}
		return res.StatusCode, m
	}
	status, g := post("CreateGroup", "", `{"name":"Wire","gameName":"RL"}`)
	if status != 200 {
		t.Fatalf("%d %v", status, g)
	}
	token, game := g["deviceToken"].(string), g["gameId"].(string)
	status, p := post("CreatePlayer", token, `{"name":"Bob"}`)
	if status != 200 || p["existed"] != false {
		t.Fatalf("existed:false must be sent explicitly: %v", p)
	}
	bob := p["player"].(map[string]any)["id"].(string)
	if p["player"].(map[string]any)["archived"] != false {
		t.Fatalf("archived:false must be sent explicitly: %v", p)
	}
	_, a := post("CreatePlayer", token, `{"name":"Ada"}`)
	ada := a["player"].(map[string]any)["id"].(string)
	status, r := post("CreateRound", token, fmt.Sprintf(`{"gameId":%q,"teamA":[%q],"teamB":[%q],"winner":0}`, game, ada, bob))
	if status != 200 {
		t.Fatalf("%d %v", status, r)
	}
	round := r["round"].(map[string]any)
	// Times are google.protobuf.Timestamp: RFC 3339 in UTC.
	if s, _ := round["playedAt"].(string); !strings.HasSuffix(s, "Z") {
		t.Fatalf("playedAt should be an RFC 3339 string: %v", round["playedAt"])
	} else if at, err := time.Parse(time.RFC3339Nano, s); err != nil || time.Since(at) > time.Minute {
		t.Fatalf("playedAt %q: %v", s, err)
	}
	// An unset Timestamp (a running tournament's endedAt) is left out, not null.
	status, tour := post("CreateTournament", token, fmt.Sprintf(`{"gameId":%q,"name":"Cup"}`, game))
	if status != 200 {
		t.Fatalf("%d %v", status, tour)
	}
	if _, present := tour["tournament"].(map[string]any)["endedAt"]; present {
		t.Fatalf("an unset timestamp must be left out: %v", tour)
	}
	// Requests take timestamps as RFC 3339 strings too.
	if status, view := post("GetGame", token, fmt.Sprintf(`{"gameId":%q,"since":"2020-01-01T00:00:00Z"}`, game)); status != 200 {
		t.Fatalf("%d %v", status, view)
	}
	if round["winner"] != float64(0) {
		t.Fatalf("a zero winner must be sent explicitly: %v", round)
	}
	if _, present := round["scoreA"]; present {
		t.Fatalf("an unset optional score must be left out: %v", round)
	}
	if _, present := round["tournamentId"]; present {
		t.Fatal("an unset optional id must be left out")
	}
	// Errors: Connect's JSON shape, with the HTTP status the client maps.
	status, bad := post("GetGroup", "nope", `{}`)
	if status != 401 || bad["code"] != "unauthenticated" || bad["message"] != "not joined" {
		t.Fatalf("%d %v", status, bad)
	}
	status, bad = post("Join", "", `{"code":"ZZZZ-ZZZZ"}`)
	if status != 404 || bad["code"] != "not_found" {
		t.Fatalf("%d %v", status, bad)
	}
	status, bad = post("CreateRound", token, fmt.Sprintf(`{"gameId":%q,"teamA":[%q],"teamB":[%q],"winner":0}`, game, ada, ada))
	if status != 400 || bad["code"] != "invalid_argument" {
		t.Fatalf("%d %v", status, bad)
	}
	status, bad = post("GetGroup", token, `not json`)
	if status != 400 {
		t.Fatalf("%d %v", status, bad)
	}
	// Only POST: the API is not browsable from a link in an email.
	res, _ := http.Get(e.srv.URL + "/scoreboard.v1.ScoreboardService/GetInstance")
	res.Body.Close()
	if res.StatusCode == 200 {
		t.Fatal("GET answered an RPC")
	}
}

func TestStaticFilesAndBranding(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "branding.json"), []byte(`{"name":"Acme Games","accent":"#e4572e","defaultTheme":"hacker","footer":"Hi"}`), 0o600)
	os.WriteFile(filepath.Join(dir, "logo.svg"), []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), 0o600)
	brand, err := branding.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, nil, brand)
	get := func(path string) (int, []byte, http.Header) {
		res, err := http.Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, raw, res.Header
	}

	// The app answers every route it handles itself in the browser.
	for _, p := range []string{"/", "/j/ABCD-EFGH", "/g/abc/game/def", "/d/token", "/o/token", "/settings"} {
		status, raw, h := get(p)
		page := string(raw)
		if status != 200 || !strings.Contains(page, "<title>Acme Games</title>") || strings.Contains(page, "{{") {
			t.Fatalf("%s: %d, placeholders not filled in:\n%s", p, status, page)
		}
		if !strings.Contains(page, `content="hacker"`) || !strings.HasPrefix(h.Get("Content-Type"), "text/html") {
			t.Errorf("%s: theme or type wrong (%s)", p, h.Get("Content-Type"))
		}
	}
	// Unknown files are 404, not the app.
	if status, _, _ := get("/nothing.png"); status != 404 {
		t.Fatalf("%d", status)
	}
	res, _ := http.Post(e.srv.URL+"/", "text/plain", nil)
	res.Body.Close()
	if res.StatusCode != 405 {
		t.Fatalf("%d", res.StatusCode)
	}

	// Real files carry an ETag, so an unchanged file costs a 304.
	status, _, h := get("/app.js")
	if status != 200 || !strings.HasPrefix(h.Get("Content-Type"), "text/javascript") || h.Get("ETag") == "" {
		t.Fatalf("app.js: %d %v", status, h)
	}
	req, _ := http.NewRequest("GET", e.srv.URL+"/app.js", nil)
	req.Header.Set("If-None-Match", h.Get("ETag"))
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 304 {
		t.Fatalf("revalidation: %d", res.StatusCode)
	}
	if _, _, h := get("/fonts/vt323-latin.woff2"); h.Get("Content-Type") != "font/woff2" {
		t.Fatalf("font type %q", h.Get("Content-Type"))
	}

	// Branding: config (the same message as GetInstance), stylesheet, logo, manifest.
	_, raw, _ := get("/config.json")
	var cfg struct {
		Mode              string
		ProvisionalRounds int
		Branding          struct {
			Name, Footer, DefaultTheme string
			Logo                       bool
		}
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "MODE_MULTI" || cfg.ProvisionalRounds != 10 || cfg.Branding.Name != "Acme Games" || !cfg.Branding.Logo || cfg.Branding.Footer != "Hi" || cfg.Branding.DefaultTheme != "hacker" {
		t.Fatalf("%s", raw)
	}
	inst := must(e, e.c.GetInstance, "", &pb.GetInstanceRequest{})
	if inst.Branding.Name != "Acme Games" || !inst.Branding.Logo || inst.Mode != pb.Mode_MODE_MULTI {
		t.Fatalf("%+v", inst)
	}
	if _, css, _ := get("/branding.css"); !strings.Contains(string(css), "--accent: #e4572e") {
		t.Fatalf("css: %s", css)
	}
	status, _, h = get("/branding/logo")
	if status != 200 || !strings.HasPrefix(h.Get("Content-Type"), "image/svg") || !strings.Contains(h.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("logo: %d %v", status, h)
	}
	if status, _, _ := get("/branding/favicon"); status != 404 {
		t.Fatalf("%d", status)
	}
	_, raw, _ = get("/manifest.webmanifest")
	if !strings.Contains(string(raw), `"name": "Acme Games"`) {
		t.Fatalf("%s", raw)
	}
	// Every response carries the security headers.
	for _, name := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"} {
		if h.Get(name) == "" {
			t.Errorf("missing %s", name)
		}
	}
	if _, raw, _ := get("/healthz"); string(raw) != "ok\n" {
		t.Error("healthz")
	}
}

func TestWithoutBrandingTheAppKeepsItsName(t *testing.T) {
	e := newEnv(t, nil, nil)
	res, _ := http.Get(e.srv.URL + "/")
	page, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(page), "<title>Scoreboard</title>") {
		t.Fatalf("%s", page)
	}
	res, _ = http.Get(e.srv.URL + "/branding.css")
	css, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if len(css) != 0 {
		t.Fatalf("css should be empty: %s", css)
	}
	res, _ = http.Get(e.srv.URL + "/branding/logo")
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatal("logo without branding")
	}
}

func TestClientIPBehindAProxy(t *testing.T) {
	e := newEnv(t, func(c *config.Config) { c.JoinLimit = 1; c.TrustProxy = true }, nil)
	post := func(ip string) connect.Code {
		r := connect.NewRequest(&pb.CreateGroupRequest{Name: "G"})
		r.Header().Set("X-Forwarded-For", ip+", 10.0.0.1")
		_, err := e.c.CreateGroup(context.Background(), r)
		if err == nil {
			return 0
		}
		return connect.CodeOf(err)
	}
	if post("1.1.1.1") != 0 || post("2.2.2.2") != 0 || post("1.1.1.1") != connect.CodeResourceExhausted {
		t.Fatal("limits should be per forwarded client address")
	}
}

func TestRequestTooLarge(t *testing.T) {
	e := newEnv(t, nil, nil)
	o := e.office()
	_, err := call(e, e.c.CreatePlayer, o.owner, &pb.CreatePlayerRequest{Name: strings.Repeat("x", maxBody)})
	if err == nil {
		t.Fatal("a huge request was accepted")
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
