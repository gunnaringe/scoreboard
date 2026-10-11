// Package branding lets an operator rename and restyle the app without
// rebuilding it: point --branding-dir at a directory with
//
//	branding.json  {"name", "shortName", "accent", "defaultTheme", "defaultLanguage", "footer", "logo", "favicon"}
//	logo.svg|png   shown in the top bar, on the poster and in the sign-in header
//	favicon.png    browser tab icon (optional)
//	custom.css     appended to the stylesheet (optional)
//
// Every field is optional; without a directory the app keeps its own look.
package branding

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"math"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Default is the name used when nothing is configured.
const Default = "Scoreboard"

const maxFile = 512 << 10 // logos and CSS are small; refuse anything bigger

var accentRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Branding is the resolved custom look. The zero value is "no branding".
type Branding struct {
	Name            string `json:"name"`
	ShortName       string `json:"shortName"`
	Accent          string `json:"accent,omitempty"`
	DefaultTheme    string `json:"defaultTheme,omitempty"`    // auto, light, dark, hacker
	DefaultLanguage string `json:"defaultLanguage,omitempty"` // auto, en, no
	Footer          string `json:"footer,omitempty"`
	HasLogo         bool   `json:"logo"`

	logo, favicon         []byte
	logoType, faviconType string
	css                   string
}

type file struct {
	Name            string `json:"name"`
	ShortName       string `json:"shortName"`
	Accent          string `json:"accent"`
	DefaultTheme    string `json:"defaultTheme"`
	DefaultLanguage string `json:"defaultLanguage"`
	Footer          string `json:"footer"`
	Logo            string `json:"logo"`
	Favicon         string `json:"favicon"`
}

// Load reads a branding directory. An empty dir means no branding.
func Load(dir string) (*Branding, error) {
	b := &Branding{Name: Default, ShortName: Default}
	if dir == "" {
		return b, nil
	}
	var f file
	raw, err := os.ReadFile(filepath.Join(dir, "branding.json"))
	switch {
	case err == nil:
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&f); err != nil {
			return nil, fmt.Errorf("branding.json: %w", err)
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	if f.Name != "" {
		b.Name = f.Name
		b.ShortName = f.Name
	}
	if f.ShortName != "" {
		b.ShortName = f.ShortName
	}
	if f.Accent != "" {
		if !accentRE.MatchString(f.Accent) {
			return nil, fmt.Errorf("branding.json: accent must look like #1a73e8, not %q", f.Accent)
		}
		b.Accent = strings.ToLower(f.Accent)
	}
	switch f.DefaultTheme {
	case "", "auto", "light", "dark", "hacker":
		b.DefaultTheme = f.DefaultTheme
	default:
		return nil, fmt.Errorf("branding.json: defaultTheme must be auto, light, dark or hacker")
	}
	switch f.DefaultLanguage {
	case "", "auto", "en", "no":
		b.DefaultLanguage = f.DefaultLanguage
	default:
		return nil, fmt.Errorf("branding.json: defaultLanguage must be auto, en or no")
	}
	b.Footer = f.Footer

	// Logo and favicon: named in branding.json, or found by their usual names.
	if b.logo, b.logoType, err = readAsset(dir, f.Logo, "logo.svg", "logo.png", "logo.webp"); err != nil {
		return nil, err
	}
	b.HasLogo = b.logo != nil
	if b.favicon, b.faviconType, err = readAsset(dir, f.Favicon, "favicon.png", "favicon.svg", "favicon.ico"); err != nil {
		return nil, err
	}
	var css strings.Builder
	if b.Accent != "" {
		css.WriteString(accentCSS(b.Accent))
	}
	if custom, err := os.ReadFile(filepath.Join(dir, "custom.css")); err == nil {
		if len(custom) > maxFile {
			return nil, errors.New("custom.css is too large")
		}
		css.Write(custom)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	b.css = css.String()
	return b, nil
}

func readAsset(dir, named string, guesses ...string) ([]byte, string, error) {
	names := guesses
	if named != "" {
		names = []string{named}
	}
	for _, n := range names {
		if filepath.Base(n) != n {
			return nil, "", fmt.Errorf("%q must be a file name inside the branding directory", n)
		}
		data, err := os.ReadFile(filepath.Join(dir, n))
		if errors.Is(err, os.ErrNotExist) {
			if named != "" {
				return nil, "", fmt.Errorf("%s not found in %s", n, dir)
			}
			continue
		}
		if err != nil {
			return nil, "", err
		}
		if len(data) > maxFile {
			return nil, "", fmt.Errorf("%s is too large (max %d KB)", n, maxFile>>10)
		}
		t := mime.TypeByExtension(strings.ToLower(filepath.Ext(n)))
		if t == "" {
			t = "application/octet-stream"
		}
		return data, t, nil
	}
	return nil, "", nil
}

// accentCSS recolours the buttons and highlights of the light and dark themes
// (the hacker theme stays green), choosing readable text for the colour.
func accentCSS(hex string) string {
	r, _ := strconv.ParseUint(hex[1:3], 16, 8)
	g, _ := strconv.ParseUint(hex[3:5], 16, 8)
	b, _ := strconv.ParseUint(hex[5:7], 16, 8)
	return fmt.Sprintf("html[data-theme=\"light\"], html[data-theme=\"dark\"] {\n  --accent: %s;\n  --accent-soft: rgba(%d, %d, %d, 0.16);\n  --on-accent: %s;\n}\n",
		hex, r, g, b, OnColor(hex))
}

func channel(v uint64) float64 {
	c := float64(v) / 255
	if c <= 0.03928 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

// OnColor is black or white, whichever is more readable on the given #rrggbb.
func OnColor(hex string) string {
	r, _ := strconv.ParseUint(hex[1:3], 16, 8)
	g, _ := strconv.ParseUint(hex[3:5], 16, 8)
	b, _ := strconv.ParseUint(hex[5:7], 16, 8)
	lum := 0.2126*channel(r) + 0.7152*channel(g) + 0.0722*channel(b)
	// Contrast with black is (lum+0.05)/0.05, with white 1.05/(lum+0.05).
	if (lum+0.05)/0.05 > 1.05/(lum+0.05) {
		return "#0a0e1a"
	}
	return "#ffffff"
}

// CSS is the stylesheet addition served at /branding.css (may be empty).
func (b *Branding) CSS() string { return b.css }

// Logo returns the logo bytes and content type, or nil.
func (b *Branding) Logo() ([]byte, string) { return b.logo, b.logoType }

// Favicon returns the favicon bytes and content type, or nil.
func (b *Branding) Favicon() ([]byte, string) { return b.favicon, b.faviconType }

// Manifest is the web app manifest, named after the branding.
func (b *Branding) Manifest() ([]byte, error) {
	icons := []map[string]string{
		{"src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
		{"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
		{"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
		{"src": "/icons/icon.svg", "sizes": "any", "type": "image/svg+xml"},
	}
	theme := "#0a0e1a" // the app's dark background
	return json.MarshalIndent(map[string]any{
		"name": b.Name, "short_name": b.ShortName,
		"description": b.Name + " — game scores with fair team ratings",
		"start_url":   "/?app", "scope": "/", "display": "standalone",
		"background_color": theme, "theme_color": theme, "icons": icons,
	}, "", "  ")
}

// RenderIndex fills the placeholders of index.html.
func (b *Branding) RenderIndex(tmpl string) string {
	repl := strings.NewReplacer(
		"{{NAME}}", html.EscapeString(b.Name),
		"{{DEFAULT_THEME}}", html.EscapeString(b.DefaultTheme),
		"{{DEFAULT_LANG}}", html.EscapeString(b.DefaultLanguage),
		"{{FAVICON}}", map[bool]string{true: "/branding/favicon", false: "/icons/icon.svg"}[b.favicon != nil],
	)
	return repl.Replace(tmpl)
}
