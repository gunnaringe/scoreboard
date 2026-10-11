package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/gunnaringe/scoreboard/web"
)

type asset struct {
	data []byte
	typ  string
	etag string
}

func newAsset(data []byte, typ string) *asset {
	sum := sha256.Sum256(data)
	return &asset{data: data, typ: typ, etag: `"` + hex.EncodeToString(sum[:8]) + `"`}
}

// serve answers GET/HEAD with an ETag, so unchanged files cost a 304. Files are
// "no-cache": always revalidated, so a new binary shows up on the next load.
func (a *asset) serve(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", a.typ)
	h.Set("ETag", a.etag)
	h.Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(a.data))
}

func init() {
	for ext, typ := range map[string]string{".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"} {
		_ = mime.AddExtensionType(ext, typ)
	}
}

func (s *Server) staticRoutes(mux *http.ServeMux) error {
	files := map[string]*asset{}
	err := fs.WalkDir(web.Assets, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || p == "index.html" {
			return err
		}
		data, err := web.Assets.ReadFile(p)
		if err != nil {
			return err
		}
		files["/"+p] = newAsset(data, mime.TypeByExtension(path.Ext(p)))
		return nil
	})
	if err != nil {
		return err
	}
	tmpl, err := web.Assets.ReadFile("index.html")
	if err != nil {
		return err
	}
	index := newAsset([]byte(s.Brand.RenderIndex(string(tmpl))), "text/html; charset=utf-8")
	manifestJSON, err := s.Brand.Manifest()
	if err != nil {
		return err
	}
	manifest := newAsset(manifestJSON, "application/manifest+json")
	css := newAsset([]byte(s.Brand.CSS()), "text/css; charset=utf-8")

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.Store.Ping(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok\n"))
	})
	// The same message GetInstance returns, so the page can start without a round trip.
	ccJSON, err := jsonCodec{}.Marshal(s.instance())
	if err != nil {
		return err
	}
	clientCfg := newAsset(ccJSON, "application/json; charset=utf-8")
	mux.HandleFunc("GET /config.json", func(w http.ResponseWriter, r *http.Request) { clientCfg.serve(w, r) })
	mux.HandleFunc("GET /manifest.webmanifest", func(w http.ResponseWriter, r *http.Request) { manifest.serve(w, r) })
	mux.HandleFunc("GET /branding.css", func(w http.ResponseWriter, r *http.Request) { css.serve(w, r) })
	brandFile := func(get func() ([]byte, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			data, typ := get()
			if data == nil {
				http.NotFound(w, r)
				return
			}
			// An SVG opened directly must not be able to run script.
			w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
			newAsset(data, typ).serve(w, r)
		}
	}
	mux.HandleFunc("GET /branding/logo", brandFile(s.Brand.Logo))
	mux.HandleFunc("GET /branding/favicon", brandFile(s.Brand.Favicon))

	// Everything else: an embedded file, or the app itself (it routes in the browser).
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := path.Clean(r.URL.Path)
		if a, ok := files[p]; ok {
			a.serve(w, r)
			return
		}
		if strings.Contains(path.Base(p), ".") { // a file that doesn't exist
			http.NotFound(w, r)
			return
		}
		index.serve(w, r)
	})
	return nil
}
