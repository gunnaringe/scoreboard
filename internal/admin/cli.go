package admin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	pb "github.com/gunnaringe/scoreboard/gen/scoreboard/admin/v1"
	"github.com/gunnaringe/scoreboard/gen/scoreboard/admin/v1/adminv1connect"
)

// Usage is the help text of `scoreboard admin`.
const Usage = `scoreboard admin: manage a running scoreboard through its admin port.

Usage: scoreboard admin [options] <command>

Commands (add --group <id or name> when the instance has several groups):
  stats                              totals for the whole instance
  config                             the running configuration
  groups list                        every group with its links
  groups create <name> [--player NAME] [--game NAME]
                                     make a group (prints its owner link once)
  groups rename <new name>
  groups delete --yes
  links show                         office and dashboard links
  links rotate office|dashboard|owner
                                     replace a link; the old one stops working
                                     (rotating "owner" prints the new owner link:
                                     this is how you recover a lost one)
  devices list
  devices owner <device id> [--off]  make a device an owner (or not)
  devices remove <device id>
  players list
  players rename <player> <new name>
  players archive|unarchive <player>
  players merge <from> <into>        the same person entered twice
  games list
  games rename <game> <new name>
  games archive|unarchive <game>
  games recalc [<game>]              recalculate all ratings from the rounds
  export [-o file]                   a group as JSON (to stdout without -o)
  import <file> [--name NAME]        make a new group from an export
  backup <file>                      consistent copy of the database

Options:
  --url URL      admin address     (env SCOREBOARD_ADMIN_URL, default http://127.0.0.1:8081)
  --token T      admin token       (env SCOREBOARD_ADMIN_TOKEN, if the server needs one)
  -g, --group G  which group
  --json         print the raw JSON answer
`

type options struct {
	url, token, group, player, game, name, output string
	json, yes, off                                bool
	args                                          []string
}

func parse(args []string, env func(string) string) (options, error) {
	o := options{url: env("SCOREBOARD_ADMIN_URL"), token: env("SCOREBOARD_ADMIN_TOKEN")}
	if o.url == "" {
		o.url = "http://127.0.0.1:8081"
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		value := func() (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", a)
			}
			i++
			return args[i], nil
		}
		var err error
		switch a {
		case "--url":
			o.url, err = value()
		case "--token":
			o.token, err = value()
		case "-g", "--group":
			o.group, err = value()
		case "--player":
			o.player, err = value()
		case "--game":
			o.game, err = value()
		case "--name":
			o.name, err = value()
		case "-o", "--output":
			o.output, err = value()
		case "--json":
			o.json = true
		case "--yes":
			o.yes = true
		case "--off":
			o.off = true
		case "-h", "--help", "help":
			return o, flagHelp{}
		default:
			if strings.HasPrefix(a, "-") && len(a) > 1 {
				return o, fmt.Errorf("unknown option %s", a)
			}
			o.args = append(o.args, a)
		}
		if err != nil {
			return o, err
		}
	}
	return o, nil
}

type flagHelp struct{}

func (flagHelp) Error() string { return "help" }

type client struct {
	o   options
	rpc adminv1connect.AdminServiceClient
}

func newClient(o options) *client {
	// Every request carries the marker header (and the token, if any).
	headers := connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
			r.Header().Set(Header, "cli")
			if o.token != "" {
				r.Header().Set("Authorization", "Bearer "+o.token)
			}
			return next(ctx, r)
		}
	})
	return &client{o: o, rpc: adminv1connect.NewAdminServiceClient(&http.Client{Timeout: 5 * time.Minute}, strings.TrimRight(o.url, "/"), connect.WithInterceptors(headers))}
}

// explain makes an RPC error readable on a terminal.
func (c *client) explain(err error) error {
	var ce *connect.Error
	if !errors.As(err, &ce) {
		return err
	}
	switch ce.Code() {
	case connect.CodeUnavailable, connect.CodeUnknown:
		return fmt.Errorf("cannot reach the admin port at %s: %v\n(is `scoreboard serve` running? is --admin-listen set?)", c.o.url, ce.Message())
	case connect.CodeInvalidArgument, connect.CodeNotFound, connect.CodeFailedPrecondition, connect.CodeAlreadyExists:
		return errors.New(ce.Message())
	}
	return fmt.Errorf("%s: %s", ce.Code(), ce.Message())
}

// RunCLI runs `scoreboard admin ...` and returns the exit code.
func RunCLI(args []string, env func(string) string, stdout, stderr io.Writer) int {
	o, err := parse(args, env)
	if _, help := err.(flagHelp); help || (err == nil && len(o.args) == 0) {
		fmt.Fprint(stdout, Usage)
		return 0
	}
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	c := newClient(o)
	if err := c.run(context.Background(), stdout); err != nil {
		fmt.Fprintln(stderr, "error:", c.explain(err))
		return 1
	}
	return 0
}

func (c *client) need(n int, usage string) error {
	if len(c.o.args)-1 < n {
		return fmt.Errorf("usage: scoreboard admin %s", usage)
	}
	return nil
}

func (c *client) run(ctx context.Context, w io.Writer) error {
	a := c.o.args
	cmd, sub := a[0], ""
	if len(a) > 1 {
		sub = a[1]
	}
	g := c.o.group
	rest := func(from int) string { return strings.Join(a[from:], " ") }
	// show prints the raw JSON answer with --json, else what render makes of it.
	show := func(msg proto.Message, render func()) {
		if c.o.json {
			out, _ := protojson.MarshalOptions{Multiline: true, Indent: "  ", EmitDefaultValues: true}.Marshal(msg)
			fmt.Fprintln(w, string(out))
			return
		}
		render()
	}
	done := func(msg string) func() { return func() { fmt.Fprintln(w, msg) } }
	date := func(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02") }
	table := func() *tabwriter.Writer { return tabwriter.NewWriter(w, 0, 4, 2, ' ', 0) }

	switch cmd {
	case "stats":
		r, err := c.rpc.GetStats(ctx, connect.NewRequest(&pb.GetStatsRequest{}))
		if err != nil {
			return err
		}
		show(r.Msg, func() {
			fmt.Fprintf(w, "groups %d, players %d, games %d, rounds %d, devices %d, database %.1f MB\n",
				r.Msg.Groups, r.Msg.Players, r.Msg.Games, r.Msg.Rounds, r.Msg.Devices, float64(r.Msg.DatabaseBytes)/1e6)
		})
	case "config":
		r, err := c.rpc.GetConfig(ctx, connect.NewRequest(&pb.GetConfigRequest{}))
		if err != nil {
			return err
		}
		fmt.Fprintln(w, r.Msg.Json)
	case "backup":
		if err := c.need(1, "backup <file>"); err != nil {
			return err
		}
		r, err := c.rpc.Backup(ctx, connect.NewRequest(&pb.BackupRequest{Path: a[1]}))
		if err != nil {
			return err
		}
		show(r.Msg, done("backup written to "+a[1]+" (on the server's disk)"))
	case "export":
		r, err := c.rpc.ExportGroup(ctx, connect.NewRequest(&pb.ExportGroupRequest{Group: g}))
		if err != nil {
			return err
		}
		if c.o.output == "" {
			fmt.Fprintln(w, r.Msg.Json)
			return nil
		}
		if err := os.WriteFile(c.o.output, []byte(r.Msg.Json+"\n"), 0o600); err != nil {
			return err
		}
		fmt.Fprintln(w, "exported to", c.o.output)
	case "import":
		if err := c.need(1, "import <file> [--name NAME]"); err != nil {
			return err
		}
		data, err := os.ReadFile(a[1])
		if err != nil {
			return err
		}
		r, err := c.rpc.ImportGroup(ctx, connect.NewRequest(&pb.ImportGroupRequest{Json: string(data), Name: c.o.name}))
		if err != nil {
			return err
		}
		c.printGroup(w, r.Msg.Group, "imported", true, r.Msg)
	case "groups":
		switch sub {
		case "list", "":
			r, err := c.rpc.ListGroups(ctx, connect.NewRequest(&pb.ListGroupsRequest{}))
			if err != nil {
				return err
			}
			show(r.Msg, func() {
				tw := table()
				fmt.Fprintln(tw, "ID\tNAME\tPLAYERS\tGAMES\tROUNDS\tDEVICES\tOFFICE LINK")
				for _, gr := range r.Msg.Groups {
					fmt.Fprintf(tw, "%s\t%s\t%d\t%d\t%d\t%d\t%s\n", gr.Id, gr.Name, gr.Players, gr.Games, gr.Rounds, gr.Devices, gr.Links.Office)
				}
				tw.Flush()
			})
		case "create":
			if err := c.need(2, "groups create <name> [--player NAME] [--game NAME]"); err != nil {
				return err
			}
			r, err := c.rpc.CreateGroup(ctx, connect.NewRequest(&pb.CreateGroupRequest{Name: rest(2), Player: c.o.player, Game: c.o.game}))
			if err != nil {
				return err
			}
			c.printGroup(w, r.Msg.Group, "created", true, r.Msg)
		case "rename":
			if err := c.need(2, "groups rename <new name>"); err != nil {
				return err
			}
			r, err := c.rpc.RenameGroup(ctx, connect.NewRequest(&pb.RenameGroupRequest{Group: g, Name: rest(2)}))
			if err != nil {
				return err
			}
			show(r.Msg, done("renamed"))
		case "delete":
			if !c.o.yes {
				return fmt.Errorf("this deletes the group and all its rounds for good: add --yes to confirm")
			}
			r, err := c.rpc.DeleteGroup(ctx, connect.NewRequest(&pb.DeleteGroupRequest{Group: g}))
			if err != nil {
				return err
			}
			show(r.Msg, done("deleted"))
		default:
			return fmt.Errorf("unknown command: groups %s", sub)
		}
	case "links":
		switch sub {
		case "show", "":
			r, err := c.rpc.GetGroup(ctx, connect.NewRequest(&pb.GetGroupRequest{Group: g}))
			if err != nil {
				return err
			}
			c.printGroup(w, r.Msg.Group, "", false, r.Msg)
		case "rotate":
			if err := c.need(2, "links rotate office|dashboard|owner"); err != nil {
				return err
			}
			kind, ok := map[string]pb.LinkKind{"office": pb.LinkKind_LINK_KIND_OFFICE, "dashboard": pb.LinkKind_LINK_KIND_DASHBOARD, "owner": pb.LinkKind_LINK_KIND_OWNER}[a[2]]
			if !ok {
				return fmt.Errorf("links rotate: office, dashboard or owner")
			}
			r, err := c.rpc.RotateLink(ctx, connect.NewRequest(&pb.RotateLinkRequest{Group: g, Kind: kind}))
			if err != nil {
				return err
			}
			c.printGroup(w, r.Msg.Group, "new "+a[2]+" link made; the old one no longer works", true, r.Msg)
		default:
			return fmt.Errorf("unknown command: links %s", sub)
		}
	case "devices":
		switch sub {
		case "list", "":
			r, err := c.rpc.ListDevices(ctx, connect.NewRequest(&pb.ListDevicesRequest{Group: g}))
			if err != nil {
				return err
			}
			show(r.Msg, func() {
				tw := table()
				fmt.Fprintln(tw, "ID\tPLAYER\tOWNER\tDEVICE\tJOINED\tLAST SEEN")
				for _, d := range r.Msg.Devices {
					seen := "-"
					if d.LastSeenMs != nil {
						seen = date(*d.LastSeenMs)
					}
					fmt.Fprintf(tw, "%s\t%s\t%v\t%s\t%s\t%s\n", d.Id, d.Player, d.Owner, d.Label, date(d.CreatedAtMs), seen)
				}
				tw.Flush()
			})
		case "owner":
			if err := c.need(2, "devices owner <device id> [--off]"); err != nil {
				return err
			}
			r, err := c.rpc.SetDeviceOwner(ctx, connect.NewRequest(&pb.SetDeviceOwnerRequest{Group: g, DeviceId: a[2], Owner: !c.o.off}))
			if err != nil {
				return err
			}
			show(r.Msg, done("done"))
		case "remove":
			if err := c.need(2, "devices remove <device id>"); err != nil {
				return err
			}
			r, err := c.rpc.RemoveDevice(ctx, connect.NewRequest(&pb.RemoveDeviceRequest{Group: g, DeviceId: a[2]}))
			if err != nil {
				return err
			}
			show(r.Msg, done("removed"))
		default:
			return fmt.Errorf("unknown command: devices %s", sub)
		}
	case "players":
		switch sub {
		case "list", "":
			r, err := c.rpc.ListPlayers(ctx, connect.NewRequest(&pb.ListPlayersRequest{Group: g}))
			if err != nil {
				return err
			}
			show(r.Msg, func() {
				tw := table()
				fmt.Fprintln(tw, "ID\tNAME\tARCHIVED")
				for _, p := range r.Msg.Players {
					fmt.Fprintf(tw, "%s\t%s\t%v\n", p.Id, p.Name, p.Archived)
				}
				tw.Flush()
			})
		case "rename":
			if err := c.need(3, "players rename <player> <new name>"); err != nil {
				return err
			}
			name := rest(3)
			r, err := c.rpc.UpdatePlayer(ctx, connect.NewRequest(&pb.UpdatePlayerRequest{Group: g, Player: a[2], Name: &name}))
			if err != nil {
				return err
			}
			show(r.Msg, done("renamed"))
		case "archive", "unarchive":
			if err := c.need(2, "players "+sub+" <player>"); err != nil {
				return err
			}
			archived := sub == "archive"
			r, err := c.rpc.UpdatePlayer(ctx, connect.NewRequest(&pb.UpdatePlayerRequest{Group: g, Player: rest(2), Archived: &archived}))
			if err != nil {
				return err
			}
			show(r.Msg, done(sub+"d"))
		case "merge":
			if err := c.need(3, "players merge <from> <into>"); err != nil {
				return err
			}
			r, err := c.rpc.MergePlayers(ctx, connect.NewRequest(&pb.MergePlayersRequest{Group: g, From: a[2], Into: a[3]}))
			if err != nil {
				return err
			}
			show(r.Msg, done("merged "+a[2]+" into "+a[3]+" and recalculated the ratings"))
		default:
			return fmt.Errorf("unknown command: players %s", sub)
		}
	case "games":
		switch sub {
		case "list", "":
			r, err := c.rpc.ListGames(ctx, connect.NewRequest(&pb.ListGamesRequest{Group: g}))
			if err != nil {
				return err
			}
			show(r.Msg, func() {
				tw := table()
				fmt.Fprintln(tw, "ID\tNAME\tARCHIVED")
				for _, gm := range r.Msg.Games {
					fmt.Fprintf(tw, "%s\t%s\t%v\n", gm.Id, gm.Name, gm.Archived)
				}
				tw.Flush()
			})
		case "rename":
			if err := c.need(3, "games rename <game> <new name>"); err != nil {
				return err
			}
			name := rest(3)
			r, err := c.rpc.UpdateGame(ctx, connect.NewRequest(&pb.UpdateGameRequest{Group: g, Game: a[2], Name: &name}))
			if err != nil {
				return err
			}
			show(r.Msg, done("renamed"))
		case "archive", "unarchive":
			if err := c.need(2, "games "+sub+" <game>"); err != nil {
				return err
			}
			archived := sub == "archive"
			r, err := c.rpc.UpdateGame(ctx, connect.NewRequest(&pb.UpdateGameRequest{Group: g, Game: rest(2), Archived: &archived}))
			if err != nil {
				return err
			}
			show(r.Msg, done(sub+"d"))
		case "recalc":
			game := ""
			if len(a) > 2 {
				game = rest(2)
			}
			r, err := c.rpc.Recalculate(ctx, connect.NewRequest(&pb.RecalculateRequest{Group: g, Game: game}))
			if err != nil {
				return err
			}
			show(r.Msg, done("ratings recalculated"))
		default:
			return fmt.Errorf("unknown command: games %s", sub)
		}
	default:
		return fmt.Errorf("unknown command %q (try: scoreboard admin help)", cmd)
	}
	return nil
}

// printGroup prints a group's links (or the raw message with --json).
func (c *client) printGroup(w io.Writer, g *pb.Group, headline string, showOwner bool, raw proto.Message) {
	if c.o.json {
		out, _ := protojson.MarshalOptions{Multiline: true, Indent: "  ", EmitDefaultValues: true}.Marshal(raw)
		fmt.Fprintln(w, string(out))
		return
	}
	if headline != "" {
		fmt.Fprintf(w, "%s: %s (%s)\n", headline, g.Name, g.Id)
	}
	if g.Links.OfficeCode != "" {
		fmt.Fprintf(w, "office link:    %s   (code %s)\n", g.Links.Office, g.Links.OfficeCode)
	} else {
		fmt.Fprintf(w, "site:           %s\n", g.Links.Office)
	}
	fmt.Fprintf(w, "dashboard link: %s\n", g.Links.Dashboard)
	if g.Links.Owner != "" && showOwner {
		fmt.Fprintf(w, "owner link:     %s\n", g.Links.Owner)
		fmt.Fprintln(w, "  (shown only now: only a fingerprint is stored. Whoever opens it becomes an owner.)")
	}
}
