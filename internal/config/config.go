// Package config reads the server's settings from defaults, an optional JSON
// file, SCOREBOARD_* environment variables and command-line flags (later wins).
package config

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Modes.
const (
	ModeSingle = "single" // one office, no links: the app opens straight to the games
	ModeMulti  = "multi"  // several offices, each with office/dashboard/owner links
)

// SingleGroupID is the id of the implicit group in single mode.
const SingleGroupID = "main"

// Config is everything `scoreboard serve` can be told.
type Config struct {
	Mode               string `json:"mode"`
	Listen             string `json:"listen"`
	DB                 string `json:"db"`
	PublicURL          string `json:"publicUrl"`
	AdminListen        string `json:"adminListen"`
	AdminToken         string `json:"adminToken"`
	AllowGroupCreation bool   `json:"allowGroupCreation"`
	Dashboard          string `json:"dashboard"` // single mode: "open" or "off"
	GroupName          string `json:"groupName"` // single mode: the group's initial name
	BrandingDir        string `json:"brandingDir"`
	TrustProxy         bool   `json:"trustProxy"`
	JoinLimit          int    `json:"joinLimit"`  // per IP and minute; 0 = unlimited
	WriteLimit         int    `json:"writeLimit"` // per device and minute; 0 = unlimited
}

// Defaults are the settings when nothing is given.
func Defaults() Config {
	return Config{
		Mode:               ModeMulti,
		Listen:             ":8080",
		DB:                 "scoreboard.db",
		PublicURL:          "http://localhost:8080",
		AdminListen:        "127.0.0.1:8081",
		AllowGroupCreation: true,
		Dashboard:          "open",
		GroupName:          "Scoreboard",
		JoinLimit:          100,
		WriteLimit:         60,
	}
}

type field struct {
	flag, env, usage string
	isBool           bool
	set              func(c *Config, v string) error
	get              func(c *Config) string
}

func str(dst func(c *Config) *string) (func(*Config, string) error, func(*Config) string) {
	return func(c *Config, v string) error { *dst(c) = v; return nil }, func(c *Config) string { return *dst(c) }
}

func boolean(dst func(c *Config) *bool) (func(*Config, string) error, func(*Config) string) {
	return func(c *Config, v string) error {
			b, err := strconv.ParseBool(v)
			*dst(c) = b
			return err
		}, func(c *Config) string {
			return strconv.FormatBool(*dst(c))
		}
}

func integer(dst func(c *Config) *int) (func(*Config, string) error, func(*Config) string) {
	return func(c *Config, v string) error {
			n, err := strconv.Atoi(v)
			*dst(c) = n
			return err
		}, func(c *Config) string {
			return strconv.Itoa(*dst(c))
		}
}

func fields() []field {
	var out []field
	add := func(flag, env, usage string, set func(*Config, string) error, get func(*Config) string) {
		out = append(out, field{flag: flag, env: env, usage: usage, set: set, get: get})
	}
	s, g := str(func(c *Config) *string { return &c.Mode })
	add("mode", "SCOREBOARD_MODE", "single (one office, no links) or multi (several offices with secret links)", s, g)
	s, g = str(func(c *Config) *string { return &c.Listen })
	add("listen", "SCOREBOARD_LISTEN", "address of the web server", s, g)
	s, g = str(func(c *Config) *string { return &c.DB })
	add("db", "SCOREBOARD_DB", "path of the SQLite database", s, g)
	s, g = str(func(c *Config) *string { return &c.PublicURL })
	add("public-url", "SCOREBOARD_PUBLIC_URL", "public address, used when the CLI prints links", s, g)
	s, g = str(func(c *Config) *string { return &c.AdminListen })
	add("admin-listen", "SCOREBOARD_ADMIN_LISTEN", "address of the admin port (empty disables it); keep it on loopback", s, g)
	s, g = str(func(c *Config) *string { return &c.AdminToken })
	add("admin-token", "SCOREBOARD_ADMIN_TOKEN", "bearer token required on the admin port (required unless it listens on loopback)", s, g)
	b, bg := boolean(func(c *Config) *bool { return &c.AllowGroupCreation })
	add("allow-group-creation", "SCOREBOARD_ALLOW_GROUP_CREATION", "multi mode: let anyone create a group (=false: only the operator, via the CLI)", b, bg)
	out[len(out)-1].isBool = true
	s, g = str(func(c *Config) *string { return &c.Dashboard })
	add("dashboard", "SCOREBOARD_DASHBOARD", "single mode: open (read-only dashboard at /d) or off", s, g)
	s, g = str(func(c *Config) *string { return &c.GroupName })
	add("group-name", "SCOREBOARD_GROUP_NAME", "single mode: name of the group when it is first created", s, g)
	s, g = str(func(c *Config) *string { return &c.BrandingDir })
	add("branding-dir", "SCOREBOARD_BRANDING_DIR", "directory with branding.json, logo, favicon and custom.css (empty: no custom branding)", s, g)
	b, bg = boolean(func(c *Config) *bool { return &c.TrustProxy })
	add("trust-proxy", "SCOREBOARD_TRUST_PROXY", "take the client address from X-Forwarded-For / CF-Connecting-IP (only behind a proxy you control)", b, bg)
	out[len(out)-1].isBool = true
	n, ng := integer(func(c *Config) *int { return &c.JoinLimit })
	add("join-limit", "SCOREBOARD_JOIN_LIMIT", "joins, owner links and group creations per IP and minute (0 = unlimited)", n, ng)
	n, ng = integer(func(c *Config) *int { return &c.WriteLimit })
	add("write-limit", "SCOREBOARD_WRITE_LIMIT", "changes per device and minute (0 = unlimited)", n, ng)
	return out
}

// Load builds the configuration from args (without the program name) and the
// environment (lookup is os.LookupEnv). It returns flag.ErrHelp for -h.
func Load(args []string, lookup func(string) (string, bool)) (Config, error) {
	cfg := Defaults()
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	configFile := fs.String("config", "", "JSON file with the same settings (flags and environment win)")
	fl := fields()
	given := make([]*string, len(fl)) // nil: not given on the command line
	for i, f := range fl {
		i, f := i, f
		record := func(v string) error { given[i] = &v; return nil }
		if f.isBool {
			fs.BoolFunc(f.flag, f.usage, record)
		} else {
			fs.Func(f.flag, f.usage, record)
		}
	}
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	file := *configFile
	if v, ok := lookup("SCOREBOARD_CONFIG"); ok && file == "" {
		file = v
	}
	if file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return cfg, err
		}
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&cfg); err != nil {
			return cfg, fmt.Errorf("%s: %w", file, err)
		}
	}
	for i, f := range fl {
		if v, ok := lookup(f.env); ok {
			if err := f.set(&cfg, v); err != nil {
				return cfg, fmt.Errorf("%s: %w", f.env, err)
			}
		}
		if given[i] != nil {
			if err := f.set(&cfg, *given[i]); err != nil {
				return cfg, fmt.Errorf("--%s: %w", f.flag, err)
			}
		}
	}
	return cfg, cfg.Validate()
}

// Validate checks the settings fit together.
func (c Config) Validate() error {
	switch c.Mode {
	case ModeSingle, ModeMulti:
	default:
		return fmt.Errorf("mode must be %q or %q, not %q", ModeSingle, ModeMulti, c.Mode)
	}
	switch c.Dashboard {
	case "open", "off":
	default:
		return fmt.Errorf("dashboard must be open or off, not %q", c.Dashboard)
	}
	if c.AdminListen != "" && c.AdminToken == "" && !IsLoopback(c.AdminListen) {
		return fmt.Errorf("the admin port listens on %s, which is not loopback: set --admin-token", c.AdminListen)
	}
	return nil
}

// IsLoopback reports whether a listen address only accepts local connections.
func IsLoopback(addr string) bool {
	host := addr
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		host = addr[:i]
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

// Usage prints the settings table for `scoreboard serve -h`.
func Usage() string {
	var b strings.Builder
	cfg := Defaults()
	for _, f := range fields() {
		fmt.Fprintf(&b, "  --%-22s %s\n  %-24s env %s, default %q\n", f.flag, f.usage, "", f.env, f.get(&cfg))
	}
	b.WriteString("  --config                 JSON file with the same settings (env SCOREBOARD_CONFIG)\n")
	return b.String()
}
