// Command scoreboard is the whole app: the web server with its embedded
// frontend, and the CLI that administers a running instance.
//
//	scoreboard serve [options]     run the server (default)
//	scoreboard admin <command>     manage a running server (see: scoreboard admin help)
//	scoreboard version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/gunnaringe/scoreboard/internal/admin"
	"github.com/gunnaringe/scoreboard/internal/api"
	"github.com/gunnaringe/scoreboard/internal/branding"
	"github.com/gunnaringe/scoreboard/internal/config"
	"github.com/gunnaringe/scoreboard/internal/store"
)

// version is set at build time: -ldflags "-X main.version=1.2.3".
var version = ""

func buildVersion() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 7 {
				return "dev-" + s.Value[:7]
			}
		}
	}
	return "dev"
}

func main() {
	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		os.Exit(serve(args))
	case "admin":
		os.Exit(admin.RunCLI(args, os.Getenv, os.Stdout, os.Stderr))
	case "healthcheck":
		os.Exit(healthcheck())
	case "version":
		fmt.Println("scoreboard", buildVersion())
	case "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
}

const usage = `scoreboard: game scores with fair team ratings, in one binary.

  scoreboard serve [options]     run the server (the default command)
  scoreboard admin <command>     manage a running server (scoreboard admin help)
  scoreboard healthcheck         exit 0 if the local server answers (for Docker HEALTHCHECK)
  scoreboard version

Run "scoreboard serve -h" for the server's settings.
`

func serve(args []string) int {
	cfg, err := config.Load(args, os.LookupEnv)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Printf("scoreboard serve [options]\n\nEvery option can also be set with its environment variable or in the --config file.\n\n%s", config.Usage())
		return 0
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 2
	}
	slog.Info("starting", "version", buildVersion(), "mode", cfg.Mode, "listen", cfg.Listen, "db", cfg.DB)

	brand, err := branding.Load(cfg.BrandingDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: branding:", err)
		return 1
	}
	st, err := store.Open(cfg.DB)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: database:", err)
		return 1
	}
	defer st.Close()
	app, err := api.New(st, cfg, brand)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	servers := []*http.Server{{Addr: cfg.Listen, Handler: app.Handler(), ReadHeaderTimeout: 10 * time.Second}}
	if cfg.AdminListen != "" {
		a := &admin.Server{Store: st, Cfg: cfg}
		servers = append(servers, &http.Server{Addr: cfg.AdminListen, Handler: a.Handler(), ReadHeaderTimeout: 10 * time.Second})
		if !config.IsLoopback(cfg.AdminListen) {
			slog.Warn("the admin port is reachable from the network; keep the token secret", "listen", cfg.AdminListen)
		}
	}
	errc := make(chan error, len(servers))
	for _, srv := range servers {
		go func() {
			slog.Info("listening", "addr", srv.Addr)
			if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				errc <- fmt.Errorf("%s: %w", srv.Addr, err)
			}
		}()
	}
	select {
	case err := <-errc:
		fmt.Fprintln(os.Stderr, "error:", err)
		return 1
	case <-ctx.Done():
	}
	slog.Info("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, srv := range servers {
		_ = srv.Shutdown(shutdown)
	}
	return 0
}

// healthcheck asks the server on this machine for /healthz; containers without
// curl use it as their health command.
func healthcheck() int {
	cfg, err := config.Load(nil, os.LookupEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	addr := cfg.Listen
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, res.Status)
		return 1
	}
	return 0
}
