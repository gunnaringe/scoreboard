package branding

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestNoBranding(t *testing.T) {
	b, err := Load("")
	if err != nil || b.Name != Default || b.CSS() != "" || b.HasLogo {
		t.Fatalf("%+v %v", b, err)
	}
}

func TestFullBranding(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "branding.json", `{"name":"Acme Games","shortName":"Acme","accent":"#E4572E","defaultTheme":"dark","defaultLanguage":"no","footer":"Made at Acme"}`)
	write(t, dir, "logo.svg", "<svg/>")
	write(t, dir, "favicon.png", "png")
	write(t, dir, "custom.css", ".brand { letter-spacing: 1px }")
	b, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if b.Name != "Acme Games" || b.ShortName != "Acme" || b.Accent != "#e4572e" || !b.HasLogo || b.Footer != "Made at Acme" {
		t.Fatalf("%+v", b)
	}
	if logo, typ := b.Logo(); string(logo) != "<svg/>" || !strings.HasPrefix(typ, "image/svg") {
		t.Fatalf("logo %q %q", logo, typ)
	}
	if fav, typ := b.Favicon(); string(fav) != "png" || typ != "image/png" {
		t.Fatalf("favicon %q %q", fav, typ)
	}
	css := b.CSS()
	for _, want := range []string{"--accent: #e4572e", "rgba(228, 87, 46, 0.16)", ".brand { letter-spacing: 1px }", `html[data-theme="dark"]`} {
		if !strings.Contains(css, want) {
			t.Errorf("css lacks %q:\n%s", want, css)
		}
	}
	m, _ := b.Manifest()
	if !strings.Contains(string(m), `"name": "Acme Games"`) || !strings.Contains(string(m), `"short_name": "Acme"`) {
		t.Fatalf("manifest: %s", m)
	}
	page := b.RenderIndex(`<title>{{NAME}}</title><meta content="{{DEFAULT_THEME}}"><link href="{{FAVICON}}">`)
	if page != `<title>Acme Games</title><meta content="dark"><link href="/branding/favicon">` {
		t.Fatalf("index: %s", page)
	}
}

func TestOnlyWhatIsSetChanges(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "branding.json", `{"name":"Just a name"}`)
	b, err := Load(dir)
	if err != nil || b.Name != "Just a name" || b.ShortName != "Just a name" || b.CSS() != "" || b.HasLogo {
		t.Fatalf("%+v %v", b, err)
	}
	// A directory without branding.json still works (logo and css only).
	only := t.TempDir()
	write(t, only, "logo.png", "x")
	if b, err := Load(only); err != nil || !b.HasLogo || b.Name != Default {
		t.Fatalf("%+v %v", b, err)
	}
}

func TestInvalidBranding(t *testing.T) {
	for name, body := range map[string]string{
		"bad accent":    `{"accent":"red"}`,
		"bad theme":     `{"defaultTheme":"neon"}`,
		"bad language":  `{"defaultLanguage":"fr"}`,
		"unknown field": `{"colour":"#fff000"}`,
		"path escape":   `{"logo":"../secret.png"}`,
		"missing logo":  `{"logo":"nope.png"}`,
	} {
		dir := t.TempDir()
		write(t, dir, "branding.json", body)
		if _, err := Load(dir); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	big := t.TempDir()
	write(t, big, "custom.css", strings.Repeat("a", maxFile+1))
	if _, err := Load(big); err == nil {
		t.Error("huge css accepted")
	}
}

func TestReadableTextOnAccent(t *testing.T) {
	for hex, want := range map[string]string{"#ffffff": "#0a0e1a", "#8b9dff": "#0a0e1a", "#000000": "#ffffff", "#1a237e": "#ffffff", "#ffeb3b": "#0a0e1a"} {
		if got := OnColor(hex); got != want {
			t.Errorf("%s: %s, want %s", hex, got, want)
		}
	}
}
