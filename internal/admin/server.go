// Package admin is the operator's side door: a Connect service on its own port
// (loopback by default) and the CLI that drives it. It can do everything the
// owner link can, plus what no browser may: list and delete any group, make
// groups when public creation is off, recover a lost owner link, merge players,
// move data between instances and take backups.
package admin

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"connectrpc.com/connect"

	pb "github.com/gunnaringe/scoreboard/gen/scoreboard/admin/v1"
	"github.com/gunnaringe/scoreboard/gen/scoreboard/admin/v1/adminv1connect"
	"github.com/gunnaringe/scoreboard/internal/config"
	"github.com/gunnaringe/scoreboard/internal/store"
)

// Header every request must carry: a page in the operator's browser cannot set
// custom headers cross-origin, so it can never reach this port.
const Header = "X-Scoreboard-Admin"

// Server is the admin API.
type Server struct {
	Store *store.Store
	Cfg   config.Config
}

// Handler serves the AdminService.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	path, h := adminv1connect.NewAdminServiceHandler(&service{s: s}, connect.WithReadMaxBytes(64<<20)) // exports can be big
	mux.Handle(path, h)
	return s.guard(mux)
}

func (s *Server) guard(next http.Handler) http.Handler {
	deny := func(w http.ResponseWriter, code int, msg string) { http.Error(w, msg, code) }
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(Header) == "" {
			deny(w, http.StatusBadRequest, "missing "+Header+" header")
			return
		}
		if s.Cfg.AdminToken != "" {
			token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(token), []byte(s.Cfg.AdminToken)) != 1 {
				deny(w, http.StatusUnauthorized, "wrong or missing admin token")
				return
			}
		}
		next.ServeHTTP(w, r)
		if method, ok := strings.CutPrefix(r.URL.Path, "/scoreboard.admin.v1.AdminService/"); ok &&
			!strings.HasPrefix(method, "Get") && !strings.HasPrefix(method, "List") {
			slog.Info("admin", "method", method)
		}
	})
}

type service struct{ s *Server }

func fail(code connect.Code, msg string) error { return connect.NewError(code, errors.New(msg)) }

func rpcErr(err error) error {
	var ce *connect.Error
	var bad store.BadRequest
	var taken *store.NameTakenError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &ce):
		return err
	case errors.As(err, &bad):
		return fail(connect.CodeInvalidArgument, bad.Error())
	case errors.As(err, &taken):
		return fail(connect.CodeAlreadyExists, "that name is already taken")
	case errors.Is(err, store.ErrNotFound):
		return fail(connect.CodeNotFound, "not found")
	case errors.Is(err, store.ErrLimit):
		return fail(connect.CodeResourceExhausted, "limit reached")
	default:
		slog.Error("admin request failed", "err", err)
		return fail(connect.CodeInternal, err.Error())
	}
}

// group resolves a group reference (id or name); empty means the only group.
func (v *service) group(ctx context.Context, ref string) (store.Group, error) {
	if ref != "" {
		g, err := v.s.Store.FindGroup(ctx, ref)
		return g, rpcErr(err)
	}
	all, err := v.s.Store.ListGroups(ctx)
	if err != nil {
		return store.Group{}, rpcErr(err)
	}
	switch len(all) {
	case 0:
		return store.Group{}, fail(connect.CodeNotFound, "there are no groups yet")
	case 1:
		return all[0].Group, nil
	}
	return store.Group{}, fail(connect.CodeInvalidArgument, "there are several groups: say which with --group (id or name)")
}

// ---- links -----------------------------------------------------------------------------

func (v *service) links(g store.Group, ownerToken string) *pb.Links {
	base := strings.TrimRight(v.s.Cfg.PublicURL, "/")
	l := &pb.Links{Office: base + "/j/" + g.InviteCode, OfficeCode: store.FormatCode(g.InviteCode), Dashboard: base + "/d/" + g.DashboardToken}
	if v.s.Cfg.Mode == config.ModeSingle {
		l.Office, l.OfficeCode, l.Dashboard = base+"/", "", base+"/d"
	}
	if ownerToken != "" {
		l.Owner = base + "/o/" + ownerToken
	}
	return l
}

func (v *service) groupPB(g store.Group, ownerToken string) *pb.Group {
	return &pb.Group{Id: g.ID, Name: g.Name, CreatedAtMs: g.CreatedAt, Links: v.links(g, ownerToken)}
}

// ---- instance --------------------------------------------------------------------------------

func (v *service) GetStats(ctx context.Context, _ *connect.Request[pb.GetStatsRequest]) (*connect.Response[pb.GetStatsResponse], error) {
	st, err := v.s.Store.GetStats(ctx)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.GetStatsResponse{
		Groups: int32(st.Groups), Players: int32(st.Players), Games: int32(st.Games), Rounds: int32(st.Rounds),
		Devices: int32(st.Devices), DatabaseBytes: st.DatabaseBytes,
	}), nil
}

func (v *service) GetConfig(ctx context.Context, _ *connect.Request[pb.GetConfigRequest]) (*connect.Response[pb.GetConfigResponse], error) {
	c := v.s.Cfg
	if c.AdminToken != "" {
		c.AdminToken = "(set)"
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.GetConfigResponse{Json: string(data)}), nil
}

func (v *service) Backup(ctx context.Context, r *connect.Request[pb.BackupRequest]) (*connect.Response[pb.BackupResponse], error) {
	if r.Msg.Path == "" {
		return nil, fail(connect.CodeInvalidArgument, "path required")
	}
	if err := v.s.Store.Backup(ctx, r.Msg.Path); err != nil {
		return nil, fail(connect.CodeInvalidArgument, err.Error())
	}
	return connect.NewResponse(&pb.BackupResponse{Path: r.Msg.Path}), nil
}

// ---- groups --------------------------------------------------------------------------------------

func (v *service) ListGroups(ctx context.Context, _ *connect.Request[pb.ListGroupsRequest]) (*connect.Response[pb.ListGroupsResponse], error) {
	all, err := v.s.Store.ListGroups(ctx)
	if err != nil {
		return nil, rpcErr(err)
	}
	out := &pb.ListGroupsResponse{}
	for _, g := range all {
		pg := v.groupPB(g.Group, "")
		pg.Players, pg.Games, pg.Rounds, pg.Devices = int32(g.Players), int32(g.Games), int32(g.Rounds), int32(g.Devices)
		out.Groups = append(out.Groups, pg)
	}
	return connect.NewResponse(out), nil
}

func (v *service) CreateGroup(ctx context.Context, r *connect.Request[pb.CreateGroupRequest]) (*connect.Response[pb.CreateGroupResponse], error) {
	m := r.Msg
	created, err := v.s.Store.CreateGroup(ctx, m.Name, m.Player, m.Game, false, "")
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.CreateGroupResponse{Group: v.groupPB(created.Group, created.OwnerToken)}), nil
}

func (v *service) GetGroup(ctx context.Context, r *connect.Request[pb.GetGroupRequest]) (*connect.Response[pb.GetGroupResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&pb.GetGroupResponse{Group: v.groupPB(g, "")}), nil
}

func (v *service) RenameGroup(ctx context.Context, r *connect.Request[pb.RenameGroupRequest]) (*connect.Response[pb.RenameGroupResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.RenameGroup(ctx, g.ID, r.Msg.Name); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.RenameGroupResponse{}), nil
}

func (v *service) DeleteGroup(ctx context.Context, r *connect.Request[pb.DeleteGroupRequest]) (*connect.Response[pb.DeleteGroupResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	if g.ID == config.SingleGroupID && v.s.Cfg.Mode == config.ModeSingle {
		return nil, fail(connect.CodeInvalidArgument, "the group of a single-mode instance cannot be deleted")
	}
	if err := v.s.Store.DeleteGroup(ctx, g.ID); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.DeleteGroupResponse{}), nil
}

func (v *service) RotateLink(ctx context.Context, r *connect.Request[pb.RotateLinkRequest]) (*connect.Response[pb.RotateLinkResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	kind := map[pb.LinkKind]string{pb.LinkKind_LINK_KIND_OFFICE: "office", pb.LinkKind_LINK_KIND_DASHBOARD: "dashboard", pb.LinkKind_LINK_KIND_OWNER: "owner"}[r.Msg.Kind]
	if kind == "" {
		return nil, fail(connect.CodeInvalidArgument, "kind required")
	}
	value, err := v.s.Store.RotateLink(ctx, g.ID, kind)
	if err != nil {
		return nil, rpcErr(err)
	}
	g, err = v.s.Store.GetGroup(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	owner := ""
	if kind == "owner" {
		owner = value
	}
	return connect.NewResponse(&pb.RotateLinkResponse{Group: v.groupPB(g, owner)}), nil
}

// ---- devices ---------------------------------------------------------------------------------------

func (v *service) ListDevices(ctx context.Context, r *connect.Request[pb.ListDevicesRequest]) (*connect.Response[pb.ListDevicesResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	devices, err := v.s.Store.ListDevices(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	players, err := v.s.Store.ListPlayers(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	names := map[string]string{}
	for _, p := range players {
		names[p.ID] = p.Name
	}
	out := &pb.ListDevicesResponse{}
	for _, d := range devices {
		pd := &pb.Device{Id: d.ID, Owner: d.Owner, Label: d.Label, CreatedAtMs: d.CreatedAt, LastSeenMs: d.LastSeen}
		if d.PlayerID != nil {
			pd.Player = names[*d.PlayerID]
		}
		out.Devices = append(out.Devices, pd)
	}
	return connect.NewResponse(out), nil
}

func (v *service) SetDeviceOwner(ctx context.Context, r *connect.Request[pb.SetDeviceOwnerRequest]) (*connect.Response[pb.SetDeviceOwnerResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.SetOwner(ctx, g.ID, r.Msg.DeviceId, r.Msg.Owner); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.SetDeviceOwnerResponse{}), nil
}

func (v *service) RemoveDevice(ctx context.Context, r *connect.Request[pb.RemoveDeviceRequest]) (*connect.Response[pb.RemoveDeviceResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.DeleteDevice(ctx, g.ID, r.Msg.DeviceId); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.RemoveDeviceResponse{}), nil
}

// ---- players ------------------------------------------------------------------------------------------

// player finds a player by id or (case-insensitive) name.
func (v *service) player(ctx context.Context, groupID, ref string) (store.Player, error) {
	players, err := v.s.Store.ListPlayers(ctx, groupID)
	if err != nil {
		return store.Player{}, rpcErr(err)
	}
	for _, p := range players {
		if p.ID == ref {
			return p, nil
		}
	}
	for _, p := range players {
		if strings.EqualFold(p.Name, ref) {
			return p, nil
		}
	}
	return store.Player{}, fail(connect.CodeNotFound, "no player "+ref)
}

func (v *service) ListPlayers(ctx context.Context, r *connect.Request[pb.ListPlayersRequest]) (*connect.Response[pb.ListPlayersResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	players, err := v.s.Store.ListPlayers(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	out := &pb.ListPlayersResponse{}
	for _, p := range players {
		out.Players = append(out.Players, &pb.Player{Id: p.ID, Name: p.Name, Archived: p.Archived})
	}
	return connect.NewResponse(out), nil
}

func (v *service) UpdatePlayer(ctx context.Context, r *connect.Request[pb.UpdatePlayerRequest]) (*connect.Response[pb.UpdatePlayerResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	p, err := v.player(ctx, g.ID, r.Msg.Player)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.UpdatePlayer(ctx, g.ID, p.ID, store.PlayerPatch{Name: r.Msg.Name, Archived: r.Msg.Archived}); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.UpdatePlayerResponse{}), nil
}

func (v *service) MergePlayers(ctx context.Context, r *connect.Request[pb.MergePlayersRequest]) (*connect.Response[pb.MergePlayersResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	from, err := v.player(ctx, g.ID, r.Msg.From)
	if err != nil {
		return nil, err
	}
	into, err := v.player(ctx, g.ID, r.Msg.Into)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.MergePlayers(ctx, g.ID, from.ID, into.ID); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.MergePlayersResponse{}), nil
}

// ---- games ------------------------------------------------------------------------------------------------

// game finds a game by id or name; empty means the only game.
func (v *service) game(ctx context.Context, groupID, ref string) (store.Game, error) {
	games, err := v.s.Store.ListGames(ctx, groupID)
	if err != nil {
		return store.Game{}, rpcErr(err)
	}
	if ref == "" && len(games) == 1 {
		return games[0], nil
	}
	for _, g := range games {
		if g.ID == ref || strings.EqualFold(g.Name, ref) {
			return g, nil
		}
	}
	return store.Game{}, fail(connect.CodeNotFound, "no game "+ref)
}

func (v *service) ListGames(ctx context.Context, r *connect.Request[pb.ListGamesRequest]) (*connect.Response[pb.ListGamesResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	games, err := v.s.Store.ListGames(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	out := &pb.ListGamesResponse{}
	for _, game := range games {
		out.Games = append(out.Games, &pb.Game{Id: game.ID, Name: game.Name, Archived: game.Archived})
	}
	return connect.NewResponse(out), nil
}

func (v *service) UpdateGame(ctx context.Context, r *connect.Request[pb.UpdateGameRequest]) (*connect.Response[pb.UpdateGameResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	game, err := v.game(ctx, g.ID, r.Msg.Game)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.UpdateGame(ctx, g.ID, game.ID, store.GamePatch{Name: r.Msg.Name, Archived: r.Msg.Archived}); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.UpdateGameResponse{}), nil
}

func (v *service) Recalculate(ctx context.Context, r *connect.Request[pb.RecalculateRequest]) (*connect.Response[pb.RecalculateResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	game, err := v.game(ctx, g.ID, r.Msg.Game)
	if err != nil {
		return nil, err
	}
	if err := v.s.Store.Recalculate(ctx, g.ID, game.ID); err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.RecalculateResponse{}), nil
}

// ---- export / import --------------------------------------------------------------------------------------------

func (v *service) ExportGroup(ctx context.Context, r *connect.Request[pb.ExportGroupRequest]) (*connect.Response[pb.ExportGroupResponse], error) {
	g, err := v.group(ctx, r.Msg.Group)
	if err != nil {
		return nil, err
	}
	data, err := v.s.Store.Export(ctx, g.ID)
	if err != nil {
		return nil, rpcErr(err)
	}
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.ExportGroupResponse{Json: string(out)}), nil
}

func (v *service) ImportGroup(ctx context.Context, r *connect.Request[pb.ImportGroupRequest]) (*connect.Response[pb.ImportGroupResponse], error) {
	var data store.ExportedGroup
	if err := json.Unmarshal([]byte(r.Msg.Json), &data); err != nil {
		return nil, fail(connect.CodeInvalidArgument, "not an export document: "+err.Error())
	}
	created, err := v.s.Store.Import(ctx, data, r.Msg.Name)
	if err != nil {
		return nil, rpcErr(err)
	}
	return connect.NewResponse(&pb.ImportGroupResponse{Group: v.groupPB(created.Group, created.OwnerToken)}), nil
}
