package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/gunnaringe/scoreboard/gen/scoreboard/v1"
	"github.com/gunnaringe/scoreboard/internal/config"
	"github.com/gunnaringe/scoreboard/internal/rating"
	"github.com/gunnaringe/scoreboard/internal/store"
)

// service implements scoreboardv1connect.ScoreboardServiceHandler.
type service struct{ s *Server }

type (
	req[T any] = *connect.Request[T]
	res[T any] = *connect.Response[T]
)

// ---- authentication ---------------------------------------------------------------------

// device finds the device a request's bearer token belongs to. Changing calls
// are rate limited per device.
func (v *service) device(ctx context.Context, h http.Header, changes bool) (store.Device, error) {
	token, ok := strings.CutPrefix(h.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		return store.Device{}, fail(connect.CodeUnauthenticated, "not joined")
	}
	dev, err := v.s.Store.Authenticate(ctx, token)
	if err != nil {
		return store.Device{}, fail(connect.CodeUnauthenticated, "not joined")
	}
	if changes && !v.s.write.allow(dev.ID) {
		return store.Device{}, fail(connect.CodeResourceExhausted, msgRateLimited)
	}
	return dev, nil
}

// owner is device() for calls only owners may make. Single mode has no owners:
// the operator administers through the admin port.
func (v *service) owner(ctx context.Context, h http.Header) (store.Device, error) {
	dev, err := v.device(ctx, h, true)
	if err != nil {
		return dev, err
	}
	if !dev.Owner || v.s.single() {
		return dev, fail(connect.CodePermissionDenied, "forbidden")
	}
	return dev, nil
}

// limitJoin applies the per-IP limit used by joining, owner links and group creation.
func (v *service) limitJoin(r interface {
	Header() http.Header
	Peer() connect.Peer
}) error {
	if !v.s.join.allow(v.s.clientIP(r.Header(), r.Peer().Addr)) {
		return fail(connect.CodeResourceExhausted, msgJoinLimited)
	}
	return nil
}

// ---- conversions (store -> protobuf) --------------------------------------------------------

func ptrIf[T any](set bool, v T) *T {
	if !set {
		return nil
	}
	return &v
}

func groupPB(g store.Group, single bool) *pb.Group {
	out := &pb.Group{Id: g.ID, Name: g.Name, OfficeCode: store.FormatCode(g.InviteCode), DashboardToken: g.DashboardToken, CreatedAt: ts(g.CreatedAt)}
	if single { // no secret links: the dashboard is /d, there is no code
		out.OfficeCode, out.DashboardToken = "", config.SingleGroupID
	}
	return out
}

func playerPB(p store.Player) *pb.Player {
	return &pb.Player{Id: p.ID, Name: p.Name, Archived: p.Archived}
}

func playersPB(ps []store.Player) []*pb.Player {
	out := make([]*pb.Player, len(ps))
	for i, p := range ps {
		out[i] = playerPB(p)
	}
	return out
}

func gamePB(g store.Game) *pb.Game {
	return &pb.Game{Id: g.ID, Name: g.Name, TeamA: g.TeamA, TeamB: g.TeamB, Archived: g.Archived, CreatedAt: ts(g.CreatedAt),
		RatingSpeed: speedPB[g.RatingSpeed]}
}

var speedPB = map[rating.Speed]pb.RatingSpeed{
	rating.Steady: pb.RatingSpeed_RATING_SPEED_STEADY,
	rating.Medium: pb.RatingSpeed_RATING_SPEED_MEDIUM,
	rating.Fast:   pb.RatingSpeed_RATING_SPEED_FAST,
}

// speedPatch is the store value of an optional speed; UNSPECIFIED becomes ""
// (refused by the store).
func speedPatch(v *pb.RatingSpeed) *string {
	if v == nil {
		return nil
	}
	s := ""
	for k, p := range speedPB {
		if p == *v {
			s = string(k)
		}
	}
	return &s
}

func gamesPB(gs []store.Game) []*pb.Game {
	out := make([]*pb.Game, len(gs))
	for i, g := range gs {
		out[i] = gamePB(g)
	}
	return out
}

func tournamentPB(t store.Tournament) *pb.Tournament {
	return &pb.Tournament{Id: t.ID, GameId: t.GameID, Name: t.Name, CreatedAt: ts(t.CreatedAt), EndedAt: tsOpt(t.EndedAt)}
}

func ratingPB(r *rating.Rating) *pb.Rating {
	if r == nil {
		return nil
	}
	return &pb.Rating{Mu: r.Mu, Sigma: r.Sigma}
}

func roundPB(r store.Round) *pb.Round {
	out := &pb.Round{
		Id: r.ID, GameId: r.GameID, TournamentId: r.TournamentID, PlayedAt: ts(r.PlayedAt), Winner: int32(r.Winner),
		CreatedBy: r.CreatedBy, Deleted: r.Deleted,
	}
	if r.ScoreA != nil {
		v := int32(*r.ScoreA)
		out.ScoreA = &v
	}
	if r.ScoreB != nil {
		v := int32(*r.ScoreB)
		out.ScoreB = &v
	}
	for _, p := range r.Players {
		out.Players = append(out.Players, &pb.RoundPlayer{
			PlayerId: p.ID, Team: int32(p.Team), Before: ratingPB(p.Before), After: ratingPB(p.After), Delta: int32(p.Delta),
		})
	}
	return out
}

func roundsPB(rs []store.Round) []*pb.Round {
	out := make([]*pb.Round, len(rs))
	for i, r := range rs {
		out[i] = roundPB(r)
	}
	return out
}

func gameViewPB(v store.GameView) *pb.GameView {
	out := &pb.GameView{Game: gamePB(v.Game), Version: v.Version, Rounds: roundsPB(v.Rounds)}
	for _, r := range v.Ratings {
		pr := &pb.PlayerRating{
			PlayerId: r.PlayerID, Mu: r.Mu, Sigma: r.Sigma, Rounds: int32(r.Rounds), Wins: int32(r.Wins),
			Display: int32(r.Display), Provisional: r.Provisional,
		}
		if r.Today != nil {
			t := int32(*r.Today)
			pr.Today = &t
		}
		if r.Week != nil {
			w := int32(*r.Week)
			pr.Week = &w
		}
		out.Ratings = append(out.Ratings, pr)
	}
	for _, h := range v.Handicaps {
		out.Handicaps = append(out.Handicaps, &pb.Handicap{Format: h.Format, Mu: h.Mu, Sigma: h.Sigma})
	}
	for _, t := range v.Tournaments {
		out.Tournaments = append(out.Tournaments, tournamentPB(t))
	}
	return out
}

func teamsOf(a, b []string) [2][]string { return [2][]string{a, b} }

func intPtr(v *int32) *int {
	if v == nil {
		return nil
	}
	n := int(*v)
	return &n
}

// ---- instance and access --------------------------------------------------------------------------

// instance describes this server; /config.json serves the same message.
func (s *Server) instance() *pb.GetInstanceResponse {
	out := &pb.GetInstanceResponse{
		Mode:               pb.Mode_MODE_MULTI,
		AllowGroupCreation: s.Cfg.AllowGroupCreation,
		DashboardEnabled:   true,
		ProvisionalRounds:  rating.ProvisionalRounds,
		Branding: &pb.Branding{
			Name: s.Brand.Name, ShortName: s.Brand.ShortName, Logo: s.Brand.HasLogo, Footer: s.Brand.Footer,
			DefaultTheme: s.Brand.DefaultTheme, DefaultLanguage: s.Brand.DefaultLanguage,
		},
	}
	if s.single() {
		out.Mode, out.GroupId, out.AllowGroupCreation = pb.Mode_MODE_SINGLE, config.SingleGroupID, false
		out.DashboardEnabled = s.Cfg.Dashboard == "open"
	}
	return out
}

func (v *service) GetInstance(ctx context.Context, r req[pb.GetInstanceRequest]) (res[pb.GetInstanceResponse], error) {
	return connect.NewResponse(v.s.instance()), nil
}

func (v *service) CreateGroup(ctx context.Context, r req[pb.CreateGroupRequest]) (res[pb.CreateGroupResponse], error) {
	if v.s.single() || !v.s.Cfg.AllowGroupCreation {
		return nil, fail(connect.CodePermissionDenied, "group creation is disabled")
	}
	if err := v.limitJoin(r); err != nil {
		return nil, err
	}
	m := r.Msg
	created, err := v.s.Store.CreateGroup(ctx, m.Name, "", m.GameName, true, r.Header().Get("User-Agent"))
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.CreateGroupResponse{
		DeviceToken: created.DeviceToken, GroupId: created.Group.ID, Name: created.Group.Name,
		GameId: created.GameID, OwnerToken: created.OwnerToken,
	}), nil
}

func (v *service) Join(ctx context.Context, r req[pb.JoinRequest]) (res[pb.JoinResponse], error) {
	if err := v.limitJoin(r); err != nil {
		return nil, err
	}
	var g store.Group
	var token string
	var err error
	if v.s.single() {
		g, token, err = v.s.Store.JoinGroup(ctx, config.SingleGroupID, r.Header().Get("User-Agent"))
	} else {
		g, token, err = v.s.Store.Join(ctx, r.Msg.Code, r.Header().Get("User-Agent"))
	}
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.JoinResponse{DeviceToken: token, GroupId: g.ID, Name: g.Name}), nil
}

func (v *service) ClaimOwner(ctx context.Context, r req[pb.ClaimOwnerRequest]) (res[pb.ClaimOwnerResponse], error) {
	if v.s.single() {
		return nil, fail(connect.CodeNotFound, "not found")
	}
	if err := v.limitJoin(r); err != nil {
		return nil, err
	}
	g, token, err := v.s.Store.ClaimOwner(ctx, r.Msg.Token, r.Msg.KnownTokens, r.Header().Get("User-Agent"))
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.ClaimOwnerResponse{GroupId: g.ID, Name: g.Name, DeviceToken: token}), nil
}

// ---- the group -----------------------------------------------------------------------------------------

func (v *service) GetGroup(ctx context.Context, r req[pb.GetGroupRequest]) (res[pb.GetGroupResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	g, err := v.s.Store.GetGroup(ctx, dev.GroupID)
	if err != nil {
		return nil, rpcErr(err)
	}
	players, err := v.s.Store.ListPlayers(ctx, dev.GroupID)
	if err != nil {
		return nil, rpcErr(err)
	}
	games, err := v.s.Store.ListGames(ctx, dev.GroupID)
	if err != nil {
		return nil, rpcErr(err)
	}
	owners, err := v.s.Store.ListOwners(ctx, dev.GroupID)
	if err != nil {
		return nil, rpcErr(err)
	}
	out := &pb.GetGroupResponse{
		Group:   groupPB(g, v.s.single()),
		Me:      &pb.Me{DeviceId: dev.ID, Owner: dev.Owner},
		Players: playersPB(players),
		Games:   gamesPB(games),
	}
	for _, o := range owners {
		out.Owners = append(out.Owners, &pb.Owner{Label: o.Label})
	}
	return connect.NewResponse(out), nil
}

func (v *service) UpdateGroup(ctx context.Context, r req[pb.UpdateGroupRequest]) (res[pb.UpdateGroupResponse], error) {
	dev, err := v.owner(ctx, r.Header())
	if err != nil {
		return nil, err
	}
	if r.Msg.Name != nil {
		if err := v.s.Store.RenameGroup(ctx, dev.GroupID, *r.Msg.Name); err != nil {
			return nil, rpcErr(err)
		}
	}
	return connect.NewResponse(&pb.UpdateGroupResponse{}), nil
}

func (v *service) DeleteGroup(ctx context.Context, r req[pb.DeleteGroupRequest]) (res[pb.DeleteGroupResponse], error) {
	dev, err := v.owner(ctx, r.Header())
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.DeleteGroup(ctx, dev.GroupID); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.DeleteGroupResponse{}), nil
}

func (v *service) RotateLink(ctx context.Context, r req[pb.RotateLinkRequest]) (res[pb.RotateLinkResponse], error) {
	dev, err := v.owner(ctx, r.Header())
	if err != nil {
		return nil, err
	}
	kind := map[pb.LinkKind]string{pb.LinkKind_LINK_KIND_OFFICE: "office", pb.LinkKind_LINK_KIND_DASHBOARD: "dashboard", pb.LinkKind_LINK_KIND_OWNER: "owner"}[r.Msg.Kind]
	if kind == "" {
		return nil, fail(connect.CodeInvalidArgument, "kind required")
	}
	value, err := v.s.Store.RotateLink(ctx, dev.GroupID, kind)
	if err != nil {
		return nil, rpcErr(err)
	}
	out := &pb.RotateLinkResponse{}
	switch kind {
	case "office":
		out.OfficeCode = value
	case "dashboard":
		out.DashboardToken = value
	case "owner":
		out.OwnerToken = value
	}
	return connect.NewResponse(out), nil
}

func (v *service) ListDevices(ctx context.Context, r req[pb.ListDevicesRequest]) (res[pb.ListDevicesResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	if !dev.Owner || v.s.single() {
		return nil, fail(connect.CodePermissionDenied, "forbidden")
	}
	devices, err := v.s.Store.ListDevices(ctx, dev.GroupID)
	if err != nil {
		return nil, rpcErr(err)
	}
	out := &pb.ListDevicesResponse{}
	for _, d := range devices {
		out.Devices = append(out.Devices, &pb.Device{
			Id: d.ID, Owner: d.Owner, Label: d.Label, CreatedAt: ts(d.CreatedAt), LastSeenAt: tsOpt(d.LastSeen), IsMe: d.ID == dev.ID,
		})
	}
	return connect.NewResponse(out), nil
}

// Owners can remove any device; anyone can remove (leave with) their own.
func (v *service) RemoveDevice(ctx context.Context, r req[pb.RemoveDeviceRequest]) (res[pb.RemoveDeviceResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	if r.Msg.DeviceId != dev.ID && (!dev.Owner || v.s.single()) {
		return nil, fail(connect.CodePermissionDenied, "forbidden")
	}
	if err := v.s.Store.DeleteDevice(ctx, dev.GroupID, r.Msg.DeviceId); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.RemoveDeviceResponse{}), nil
}

// ---- players, games, tournaments -----------------------------------------------------------------------------

func (v *service) CreatePlayer(ctx context.Context, r req[pb.CreatePlayerRequest]) (res[pb.CreatePlayerResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	p, err := v.s.Store.CreatePlayer(ctx, dev.GroupID, r.Msg.Name)
	var taken *store.NameTakenError
	if errors.As(err, &taken) && taken.Existing.ID != "" {
		return connect.NewResponse(&pb.CreatePlayerResponse{Player: playerPB(taken.Existing), Existed: true}), nil
	}
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.CreatePlayerResponse{Player: playerPB(p)}), nil
}

func (v *service) UpdatePlayer(ctx context.Context, r req[pb.UpdatePlayerRequest]) (res[pb.UpdatePlayerResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	err = v.s.Store.UpdatePlayer(ctx, dev.GroupID, r.Msg.PlayerId, store.PlayerPatch{Name: r.Msg.Name, Archived: r.Msg.Archived})
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.UpdatePlayerResponse{}), nil
}

func (v *service) CreateGame(ctx context.Context, r req[pb.CreateGameRequest]) (res[pb.CreateGameResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	g, err := v.s.Store.CreateGame(ctx, dev.GroupID, r.Msg.Name, r.Msg.TeamA, r.Msg.TeamB)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.CreateGameResponse{Game: gamePB(g)}), nil
}

// nullableName is the patch value of an optional team name: absent leaves it,
// "" (or only spaces) resets it to the default.
func nullableName(v *string) store.Nullable[string] {
	if v == nil {
		return store.Nullable[string]{}
	}
	if strings.TrimSpace(*v) == "" {
		return store.Clear[string]()
	}
	return store.Some(*v)
}

func (v *service) UpdateGame(ctx context.Context, r req[pb.UpdateGameRequest]) (res[pb.UpdateGameResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	m := r.Msg
	err = v.s.Store.UpdateGame(ctx, dev.GroupID, m.GameId, store.GamePatch{
		Name: m.Name, TeamA: nullableName(m.TeamA), TeamB: nullableName(m.TeamB), Archived: m.Archived,
		RatingSpeed: speedPatch(m.RatingSpeed),
	})
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.UpdateGameResponse{}), nil
}

// sinceOrDefault is `since` in Unix ms, or `days` days ago when it is unset.
func (v *service) sinceOrDefault(since *timestamppb.Timestamp, days int64) int64 {
	if since == nil || since.AsTime().UnixMilli() <= 0 {
		return v.s.Store.Now().UnixMilli() - days*86400000
	}
	return since.AsTime().UnixMilli()
}

// ts and tsOpt turn the store's Unix milliseconds into API timestamps; nil
// (never) stays unset.
func ts(ms int64) *timestamppb.Timestamp { return timestamppb.New(time.UnixMilli(ms)) }

func tsOpt(ms *int64) *timestamppb.Timestamp {
	if ms == nil {
		return nil
	}
	return ts(*ms)
}

func (v *service) GetGame(ctx context.Context, r req[pb.GetGameRequest]) (res[pb.GetGameResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	view, err := v.s.Store.GetGameView(ctx, dev.GroupID, r.Msg.GameId, v.sinceOrDefault(r.Msg.Since, 1), v.sinceOrDefault(r.Msg.WeekSince, 7))
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.GetGameResponse{View: gameViewPB(view)}), nil
}

func (v *service) GetGameVersion(ctx context.Context, r req[pb.GetGameVersionRequest]) (res[pb.GetGameVersionResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	version, err := v.s.Store.GameVersion(ctx, dev.GroupID, r.Msg.GameId)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.GetGameVersionResponse{Version: version}), nil
}

func (v *service) CreateTournament(ctx context.Context, r req[pb.CreateTournamentRequest]) (res[pb.CreateTournamentResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	t, err := v.s.Store.CreateTournament(ctx, dev.GroupID, r.Msg.GameId, r.Msg.Name)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.CreateTournamentResponse{Tournament: tournamentPB(t)}), nil
}

func (v *service) UpdateTournament(ctx context.Context, r req[pb.UpdateTournamentRequest]) (res[pb.UpdateTournamentResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	err = v.s.Store.UpdateTournament(ctx, dev.GroupID, r.Msg.TournamentId, store.TournamentPatch{Name: r.Msg.Name, Ended: r.Msg.Ended})
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.UpdateTournamentResponse{}), nil
}

// ---- rounds ------------------------------------------------------------------------------------------------------

func (v *service) ListRounds(ctx context.Context, r req[pb.ListRoundsRequest]) (res[pb.ListRoundsResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	m := r.Msg
	f := store.RoundFilter{Before: m.Before, Limit: int(m.Limit)}
	if m.TournamentId != nil {
		f.Tournament = *m.TournamentId
	}
	if m.PlayerId != nil {
		f.Player = *m.PlayerId
	}
	rounds, next, err := v.s.Store.ListRounds(ctx, dev.GroupID, m.GameId, f)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.ListRoundsResponse{Rounds: roundsPB(rounds), NextCursor: next}), nil
}

func (v *service) CreateRound(ctx context.Context, r req[pb.CreateRoundRequest]) (res[pb.CreateRoundResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	m := r.Msg
	if m.Winner != 0 && m.Winner != 1 {
		return nil, fail(connect.CodeInvalidArgument, "winner required")
	}
	tournament := m.TournamentId
	if tournament != nil && *tournament == "" {
		tournament = nil
	}
	round, err := v.s.Store.CreateRound(ctx, dev.GroupID, m.GameId, dev.ID, store.RoundInput{
		Teams: teamsOf(m.TeamA, m.TeamB), Winner: int(m.Winner), ScoreA: intPtr(m.ScoreA), ScoreB: intPtr(m.ScoreB), TournamentID: tournament,
	})
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.CreateRoundResponse{Round: roundPB(round)}), nil
}

func (v *service) UpdateRound(ctx context.Context, r req[pb.UpdateRoundRequest]) (res[pb.UpdateRoundResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	m := r.Msg
	var p store.RoundPatch
	if m.Winner != nil {
		w := int(*m.Winner)
		p.Winner = &w
	}
	if m.Teams != nil {
		t := teamsOf(m.Teams.TeamA, m.Teams.TeamB)
		p.Teams = &t
	}
	if m.Score != nil {
		p.ScoreA = store.Nullable[int]{Set: true, Val: intPtr(m.Score.A)}
		p.ScoreB = store.Nullable[int]{Set: true, Val: intPtr(m.Score.B)}
	}
	if m.Tournament != nil {
		id := m.Tournament.Id
		if id != nil && *id == "" {
			id = nil
		}
		p.TournamentID = store.Nullable[string]{Set: true, Val: id}
	}
	round, err := v.s.Store.UpdateRound(ctx, dev.GroupID, m.RoundId, p)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.UpdateRoundResponse{Round: roundPB(round)}), nil
}

func (v *service) DeleteRound(ctx context.Context, r req[pb.DeleteRoundRequest]) (res[pb.DeleteRoundResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.SetRoundDeleted(ctx, dev.GroupID, r.Msg.RoundId, true); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.DeleteRoundResponse{}), nil
}

func (v *service) RestoreRound(ctx context.Context, r req[pb.RestoreRoundRequest]) (res[pb.RestoreRoundResponse], error) {
	dev, err := v.device(ctx, r.Header(), true)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.SetRoundDeleted(ctx, dev.GroupID, r.Msg.RoundId, false); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.RestoreRoundResponse{}), nil
}

func (v *service) GetPlayerStats(ctx context.Context, r req[pb.GetPlayerStatsRequest]) (res[pb.GetPlayerStatsResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	st, err := v.s.Store.GetPlayerStats(ctx, dev.GroupID, r.Msg.GameId, r.Msg.PlayerId)
	if err != nil {
		return nil, rpcErr(err)
	}
	out := &pb.GetPlayerStatsResponse{}
	for _, h := range st.History {
		out.History = append(out.History, &pb.HistoryPoint{PlayedAt: ts(h[0]), Display: int32(h[1]), Won: h[2] == 1})
	}
	pairs := func(in []store.PairStat) (out []*pb.PairStat) {
		for _, p := range in {
			out = append(out, &pb.PairStat{PlayerId: p.ID, Games: int32(p.Games), Wins: int32(p.Wins)})
		}
		return
	}
	out.With, out.Against = pairs(st.With), pairs(st.Against)
	return connect.NewResponse(out), nil
}

// ---- rating helpers --------------------------------------------------------------------------------------------------

func (v *service) PreviewRound(ctx context.Context, r req[pb.PreviewRoundRequest]) (res[pb.PreviewRoundResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	p, err := v.s.Store.PreviewRound(ctx, dev.GroupID, r.Msg.GameId, r.Msg.TeamA, r.Msg.TeamB)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.PreviewRoundResponse{WinProbabilityA: p}), nil
}

func (v *service) SuggestTeams(ctx context.Context, r req[pb.SuggestTeamsRequest]) (res[pb.SuggestTeamsResponse], error) {
	dev, err := v.device(ctx, r.Header(), false)
	if err != nil {
		return nil, err
	}
	a, b, p, err := v.s.Store.SuggestTeams(ctx, dev.GroupID, r.Msg.GameId, r.Msg.PlayerIds)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.SuggestTeamsResponse{TeamA: a, TeamB: b, WinProbabilityA: p}), nil
}

// ---- dashboard -------------------------------------------------------------------------------------------------------------

// dashboardGroup finds the group a dashboard link shows.
func (v *service) dashboardGroup(ctx context.Context, token string) (store.Group, error) {
	if v.s.single() {
		if v.s.Cfg.Dashboard != "open" || token != config.SingleGroupID {
			return store.Group{}, fail(connect.CodeNotFound, "not found")
		}
		g, err := v.s.Store.GetGroup(ctx, config.SingleGroupID)
		return g, rpcErr(err)
	}
	g, err := v.s.Store.GroupByDashboardToken(ctx, token)
	return g, rpcErr(err)
}

func (v *service) GetDashboard(ctx context.Context, r req[pb.GetDashboardRequest]) (res[pb.GetDashboardResponse], error) {
	g, err := v.dashboardGroup(ctx, r.Msg.Token)
	if err != nil {
		return nil, err
	}
	games, err := v.s.Store.ListGames(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	open := make([]store.Game, 0, len(games))
	for _, game := range games {
		if !game.Archived {
			open = append(open, game)
		}
	}
	players, err := v.s.Store.ListPlayers(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.GetDashboardResponse{GroupName: g.Name, Games: gamesPB(open), Players: playersPB(players)}), nil
}

func (v *service) GetDashboardGame(ctx context.Context, r req[pb.GetDashboardGameRequest]) (res[pb.GetDashboardGameResponse], error) {
	g, err := v.dashboardGroup(ctx, r.Msg.Token)
	if err != nil {
		return nil, err
	}
	view, err := v.s.Store.GetGameView(ctx, g.ID, r.Msg.GameId, v.sinceOrDefault(r.Msg.Since, 1), v.sinceOrDefault(r.Msg.WeekSince, 7))
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.GetDashboardGameResponse{View: gameViewPB(view)}), nil
}

func (v *service) GetDashboardGameVersion(ctx context.Context, r req[pb.GetDashboardGameVersionRequest]) (res[pb.GetDashboardGameVersionResponse], error) {
	g, err := v.dashboardGroup(ctx, r.Msg.Token)
	if err != nil {
		return nil, err
	}
	version, err := v.s.Store.GameVersion(ctx, g.ID, r.Msg.GameId)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.GetDashboardGameVersionResponse{Version: version}), nil
}
