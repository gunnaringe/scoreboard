package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gunnaringe/scoreboard/internal/config"
	"github.com/gunnaringe/scoreboard/internal/store"
)

type fixture struct {
	t   *testing.T
	st  *store.Store
	srv *httptest.Server
	cfg config.Config
}

func newFixture(t *testing.T, mut func(*config.Config)) *fixture {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.PublicURL = "https://score.example.com"
	if mut != nil {
		mut(&cfg)
	}
	srv := httptest.NewServer((&Server{Store: st, Cfg: cfg}).Handler())
	t.Cleanup(func() { srv.Close(); st.Close() })
	return &fixture{t: t, st: st, srv: srv, cfg: cfg}
}

// run is `scoreboard admin <args>` against the fixture; it returns stdout, stderr and the exit code.
func (f *fixture) run(args ...string) (string, string, int) {
	f.t.Helper()
	var out, errb bytes.Buffer
	env := func(k string) string {
		if k == "SCOREBOARD_ADMIN_TOKEN" {
			return f.cfg.AdminToken
		}
		return ""
	}
	code := RunCLI(append([]string{"--url", f.srv.URL}, args...), env, &out, &errb)
	return out.String(), errb.String(), code
}

func (f *fixture) ok(args ...string) string {
	f.t.Helper()
	out, errs, code := f.run(args...)
	if code != 0 {
		f.t.Fatalf("%v: exit %d: %s", args, code, errs)
	}
	return out
}

func (f *fixture) fails(contains string, args ...string) {
	f.t.Helper()
	out, errs, code := f.run(args...)
	if code == 0 || !strings.Contains(errs, contains) {
		f.t.Fatalf("%v: exit %d, stdout %q, stderr %q (want error containing %q)", args, code, out, errs, contains)
	}
}

func TestGroupsAndLinks(t *testing.T) {
	f := newFixture(t, nil)
	out := f.ok("groups", "create", "Oslo", "office", "--player", "Ada", "--game", "Rocket League")
	for _, want := range []string{"created: Oslo office", "https://score.example.com/j/", "https://score.example.com/d/", "https://score.example.com/o/", "shown only now"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	ownerLink := ""
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "owner link:") {
			ownerLink = strings.TrimSpace(strings.TrimPrefix(line, "owner link:"))
		}
	}
	// The printed owner link really works: its token is what the store knows.
	if _, _, err := f.st.ClaimOwner(context.Background(), strings.TrimPrefix(ownerLink, "https://score.example.com/o/"), nil, ""); err != nil {
		t.Fatalf("printed owner link does not work: %v", err)
	}

	list := f.ok("groups", "list")
	if !strings.Contains(list, "Oslo office") || !strings.Contains(list, "PLAYERS") {
		t.Fatal(list)
	}
	f.ok("groups", "rename", "Oslo", "HQ")
	if !strings.Contains(f.ok("links", "show"), "office link:") {
		t.Fatal("links show")
	}
	// Rotating the owner link prints a new one (lost-link recovery); the old one dies.
	rot := f.ok("links", "rotate", "owner")
	if !strings.Contains(rot, "new owner link made") || !strings.Contains(rot, "/o/") {
		t.Fatal(rot)
	}
	if _, _, err := f.st.ClaimOwner(context.Background(), strings.TrimPrefix(ownerLink, "https://score.example.com/o/"), nil, ""); err == nil {
		t.Fatal("old owner link still works")
	}
	before := f.ok("links", "show")
	f.ok("links", "rotate", "office")
	f.ok("links", "rotate", "dashboard")
	if after := f.ok("links", "show"); after == before {
		t.Fatal("links did not change")
	}
	f.fails("office, dashboard or owner", "links", "rotate", "bogus")

	// Deleting needs --yes.
	f.fails("--yes", "groups", "delete")
	f.ok("groups", "delete", "--yes")
	f.fails("no groups yet", "links", "show")
}

func TestSeveralGroupsNeedAReference(t *testing.T) {
	f := newFixture(t, nil)
	f.ok("groups", "create", "One")
	f.ok("groups", "create", "Two")
	f.fails("several groups", "players", "list")
	f.ok("players", "list", "--group", "Two")
	f.ok("players", "list", "-g", "one") // names are case-insensitive
	f.fails("not found", "players", "list", "-g", "Three")
}

func TestPlayersGamesAndDevices(t *testing.T) {
	f := newFixture(t, nil)
	f.ok("groups", "create", "Office", "--player", "Ada", "--game", "Rocket League")
	g, _ := f.st.FindGroup(context.Background(), "Office")
	ctx := context.Background()
	bob, _ := f.st.CreatePlayer(ctx, g.ID, "Bob", "")
	bobby, _ := f.st.CreatePlayer(ctx, g.ID, "Bobby", "")
	games, _ := f.st.ListGames(ctx, g.ID)
	ada, _ := f.st.ListPlayers(ctx, g.ID)
	var adaID string
	for _, p := range ada {
		if p.Name == "Ada" {
			adaID = p.ID
		}
	}
	if _, err := f.st.CreateRound(ctx, g.ID, games[0].ID, "", store.RoundInput{Teams: [2][]string{{adaID}, {bob.ID}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.CreateRound(ctx, g.ID, games[0].ID, "", store.RoundInput{Teams: [2][]string{{adaID}, {bobby.ID}}, Winner: 1}); err != nil {
		t.Fatal(err)
	}

	if out := f.ok("players", "list"); !strings.Contains(out, "Bobby") {
		t.Fatal(out)
	}
	f.ok("players", "rename", "bobby", "Robert")
	f.fails("already taken", "players", "rename", "Robert", "ada")
	f.ok("players", "archive", "Robert")
	if out := f.ok("players", "list"); !strings.Contains(out, "true") {
		t.Fatal("archive lost:", out)
	}
	f.ok("players", "unarchive", "Robert")
	f.fails("no player", "players", "archive", "Nobody")
	// Merge: Robert is Bob under another name.
	f.ok("players", "merge", "Robert", "Bob")
	if out := f.ok("players", "list"); strings.Contains(out, "Robert") {
		t.Fatalf("merged player still listed:\n%s", out)
	}
	stats := f.ok("stats")
	if !strings.Contains(stats, "players 2") || !strings.Contains(stats, "rounds 2") {
		t.Fatal(stats)
	}
	f.fails("pick two different", "players", "merge", "Bob", "Bob")

	f.ok("games", "rename", "Rocket League", "RL")
	f.ok("games", "archive", "RL")
	f.ok("games", "unarchive", "RL")
	f.ok("games", "recalc")
	f.ok("games", "speed", "RL", "fast")
	f.fails("steady, medium or fast", "games", "speed", "RL", "ludicrous")
	if out := f.ok("games", "list"); !strings.Contains(out, "RL") || !strings.Contains(out, "fast") {
		t.Fatal(out)
	}

	// Devices: join, promote, remove.
	_, tok, _ := f.st.Join(ctx, g.InviteCode, "Mozilla/5.0 (iPhone) Safari/604.1")
	dev, _ := f.st.Authenticate(ctx, tok)
	if out := f.ok("devices", "list"); !strings.Contains(out, "iPhone · Safari") {
		t.Fatal(out)
	}
	f.ok("devices", "owner", dev.ID)
	if d, _ := f.st.Authenticate(ctx, tok); !d.Owner {
		t.Fatal("not promoted")
	}
	f.ok("devices", "owner", dev.ID, "--off")
	f.ok("devices", "remove", dev.ID)
	if _, err := f.st.Authenticate(ctx, tok); err == nil {
		t.Fatal("device still there")
	}
}

func TestExportImportAndBackup(t *testing.T) {
	f := newFixture(t, nil)
	f.ok("groups", "create", "Source", "--player", "Ada", "--game", "RL")
	ctx := context.Background()
	g, _ := f.st.FindGroup(ctx, "Source")
	bob, _ := f.st.CreatePlayer(ctx, g.ID, "Bob", "")
	games, _ := f.st.ListGames(ctx, g.ID)
	ps, _ := f.st.ListPlayers(ctx, g.ID)
	f.st.CreateRound(ctx, g.ID, games[0].ID, "", store.RoundInput{Teams: [2][]string{{ps[0].ID}, {bob.ID}}})

	file := filepath.Join(t.TempDir(), "export.json")
	f.ok("export", "-o", file)
	data, err := os.ReadFile(file)
	if err != nil || !json.Valid(data) || !strings.Contains(string(data), `"Bob"`) {
		t.Fatalf("export file: %v %s", err, data)
	}
	out := f.ok("import", file, "--name", "Copy")
	if !strings.Contains(out, "imported: Copy") || !strings.Contains(out, "owner link:") {
		t.Fatal(out)
	}
	f.ok("players", "list", "-g", "Copy")
	f.fails("not an export document", "import", writeFile(t, "{not json"))
	f.fails("unsupported export format", "import", writeFile(t, `{"format": 99, "name": "x"}`))
	f.fails("no such file", "import", filepath.Join(t.TempDir(), "missing.json"))

	backup := filepath.Join(t.TempDir(), "backup.db")
	f.ok("backup", backup)
	if _, err := os.Stat(backup); err != nil {
		t.Fatal(err)
	}
	f.fails("already exists", "backup", backup)
}

func writeFile(t *testing.T, body string) string {
	p := filepath.Join(t.TempDir(), "f.json")
	os.WriteFile(p, []byte(body), 0o600)
	return p
}

func TestJSONOutputAndConfig(t *testing.T) {
	f := newFixture(t, func(c *config.Config) { c.AdminToken = "s3cret" })
	out := f.ok("--json", "stats")
	var st map[string]any
	if err := json.Unmarshal([]byte(out), &st); err != nil || st["groups"] != float64(0) {
		t.Fatalf("%v %s", err, out)
	}
	cfg := f.ok("config")
	if strings.Contains(cfg, "s3cret") || !strings.Contains(cfg, "(set)") {
		t.Fatalf("the admin token must never be shown:\n%s", cfg)
	}
	if out, _, code := f.run("help"); code != 0 || !strings.Contains(out, "scoreboard admin") {
		t.Fatal("help")
	}
	f.fails("unknown command", "frobnicate")
	f.fails("unknown option", "--nonsense", "stats")
	f.fails("usage:", "players", "merge", "OnlyOne")
}

func TestGuard(t *testing.T) {
	f := newFixture(t, func(c *config.Config) { c.AdminToken = "s3cret" })
	post := func(header bool, token string) int {
		req, _ := http.NewRequest("POST", f.srv.URL+"/scoreboard.admin.v1.AdminService/GetStats", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		if header {
			req.Header.Set(Header, "test")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c := post(false, "s3cret"); c != 400 {
		t.Fatalf("without the marker header (as a web page would send): %d", c)
	}
	if c := post(true, ""); c != 401 {
		t.Fatalf("without token: %d", c)
	}
	if c := post(true, "wrong"); c != 401 {
		t.Fatalf("wrong token: %d", c)
	}
	if c := post(true, "s3cret"); c != 200 {
		t.Fatalf("right token: %d", c)
	}
	// The CLI without the token is refused, with a useful message.
	var out, errb bytes.Buffer
	code := RunCLI([]string{"--url", f.srv.URL, "stats"}, func(string) string { return "" }, &out, &errb)
	if code == 0 || !strings.Contains(errb.String(), "unauthenticated") && !strings.Contains(errb.String(), "401") && !strings.Contains(errb.String(), "token") {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
}

func TestUnreachable(t *testing.T) {
	var out, errb bytes.Buffer
	code := RunCLI([]string{"--url", "http://127.0.0.1:1", "stats"}, func(string) string { return "" }, &out, &errb)
	if code == 0 || !strings.Contains(errb.String(), "cannot reach the admin port") {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
}

func TestSingleModeLinksAndProtection(t *testing.T) {
	f := newFixture(t, func(c *config.Config) { c.Mode = config.ModeSingle })
	if _, err := f.st.EnsureGroup(context.Background(), config.SingleGroupID, "Office"); err != nil {
		t.Fatal(err)
	}
	out := f.ok("links", "show")
	if !strings.Contains(out, "site:           https://score.example.com/") || !strings.Contains(out, "https://score.example.com/d") || strings.Contains(out, "/j/") {
		t.Fatal(out)
	}
	f.fails("single-mode", "groups", "delete", "--yes")
	f.ok("groups", "rename", "Oslo HQ")
	f.ok("games", "list")
}
