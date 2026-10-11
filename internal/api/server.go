// Package api is the public web server: the Connect API (the same one the web
// app uses), the embedded frontend, /config.json and the branding assets.
package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/gunnaringe/scoreboard/gen/scoreboard/v1/scoreboardv1connect"
	"github.com/gunnaringe/scoreboard/internal/branding"
	"github.com/gunnaringe/scoreboard/internal/config"
	"github.com/gunnaringe/scoreboard/internal/store"
)

// maxBody caps request messages.
const maxBody = 64 << 10

// Server serves the app.
type Server struct {
	Store *store.Store
	Cfg   config.Config
	Brand *branding.Branding

	join, write *limiter
	handler     http.Handler
}

// New builds the server. In single mode it makes sure the implicit group exists.
func New(st *store.Store, cfg config.Config, br *branding.Branding) (*Server, error) {
	s := &Server{Store: st, Cfg: cfg, Brand: br, join: newLimiter(cfg.JoinLimit), write: newLimiter(cfg.WriteLimit)}
	if cfg.Mode == config.ModeSingle {
		name := cfg.GroupName
		if name == "" {
			name = br.Name
		}
		if _, err := st.EnsureGroup(context.Background(), config.SingleGroupID, name); err != nil {
			return nil, fmt.Errorf("single-mode group: %w", err)
		}
	}
	mux := http.NewServeMux()
	path, h := scoreboardv1connect.NewScoreboardServiceHandler(&service{s: s},
		JSONCodecOption(), connect.WithReadMaxBytes(maxBody))
	mux.Handle(path, h)
	if err := s.staticRoutes(mux); err != nil {
		return nil, err
	}
	s.handler = s.middleware(mux)
	return s, nil
}

// Handler is the http.Handler to serve.
func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) single() bool { return s.Cfg.Mode == config.ModeSingle }

// ---- middleware -------------------------------------------------------------------

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		h := w.Header()
		// Everything the app loads is same-origin. no-referrer keeps owner and
		// dashboard links out of Referer headers.
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic", "path", r.URL.Path, "panic", rec)
				if sw.status == 200 {
					http.Error(sw, "internal error", http.StatusInternalServerError)
				}
			}
			if method, ok := strings.CutPrefix(r.URL.Path, "/scoreboard.v1.ScoreboardService/"); ok {
				changes := !strings.HasPrefix(method, "Get") && !strings.HasPrefix(method, "List") &&
					!strings.HasPrefix(method, "Preview") && !strings.HasPrefix(method, "Suggest")
				if changes || sw.status >= 500 {
					slog.Info("rpc", "method", method, "status", sw.status, "ms", time.Since(start).Milliseconds())
				}
			}
		}()
		next.ServeHTTP(sw, r)
	})
}

// clientIP is the address used for rate limiting.
func (s *Server) clientIP(h http.Header, peer string) string {
	if s.Cfg.TrustProxy {
		if ip := h.Get("CF-Connecting-IP"); ip != "" {
			return ip
		}
		if xff := h.Get("X-Forwarded-For"); xff != "" {
			first, _, _ := strings.Cut(xff, ",")
			return strings.TrimSpace(first)
		}
	}
	host, _, err := net.SplitHostPort(peer)
	if err != nil {
		return peer
	}
	return host
}

// ---- errors -------------------------------------------------------------------------

// Messages the web app recognises (it maps them to translated text).
const (
	msgRateLimited = "too many requests, wait a minute"
	msgJoinLimited = "too many attempts, wait a minute"
	msgLimit       = "limit reached"
)

func fail(code connect.Code, msg string) error { return connect.NewError(code, errors.New(msg)) }

// rpcErr turns store errors into Connect errors; anything unexpected is logged
// and reported as a plain internal error.
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
		return fail(connect.CodeAlreadyExists, "name taken")
	case errors.Is(err, store.ErrNotFound):
		return fail(connect.CodeNotFound, "not found")
	case errors.Is(err, store.ErrLimit):
		return fail(connect.CodeResourceExhausted, msgLimit)
	default:
		slog.Error("request failed", "err", err)
		return fail(connect.CodeInternal, "internal error")
	}
}
