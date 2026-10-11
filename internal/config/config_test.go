package config

import (
	"os"
	"path/filepath"
	"testing"
)

func env(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestPrecedence(t *testing.T) {
	file := filepath.Join(t.TempDir(), "c.json")
	os.WriteFile(file, []byte(`{"mode":"single","listen":":1111","db":"file.db","groupName":"From file"}`), 0o600)
	cfg, err := Load([]string{"--config", file, "--db", "flag.db"}, env(map[string]string{"SCOREBOARD_LISTEN": ":2222", "SCOREBOARD_DB": "env.db"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Mode != "single" || cfg.Listen != ":2222" || cfg.DB != "flag.db" || cfg.GroupName != "From file" {
		t.Fatalf("%+v", cfg)
	}
	if !cfg.AllowGroupCreation || cfg.JoinLimit != 100 {
		t.Fatalf("defaults lost: %+v", cfg)
	}
}

func TestValidation(t *testing.T) {
	for _, args := range [][]string{
		{"--mode", "both"},
		{"--dashboard", "maybe"},
		{"--admin-listen", ":8081"}, // not loopback, no token
		{"--join-limit", "many"},
	} {
		if _, err := Load(args, env(nil)); err == nil {
			t.Errorf("%v accepted", args)
		}
	}
	if _, err := Load([]string{"--admin-listen", ":8081", "--admin-token", "x"}, env(nil)); err != nil {
		t.Errorf("token + public admin port refused: %v", err)
	}
	cfg, err := Load([]string{"--allow-group-creation=false", "--trust-proxy"}, env(nil))
	if err != nil || cfg.AllowGroupCreation || !cfg.TrustProxy {
		t.Errorf("boolean flags: %+v %v", cfg, err)
	}
	// An empty value is a value: it disables the admin port.
	cfg, err = Load([]string{"--admin-listen", ""}, env(nil))
	if err != nil || cfg.AdminListen != "" {
		t.Errorf("empty admin-listen: %+v %v", cfg, err)
	}
	cfg, err = Load(nil, env(map[string]string{"SCOREBOARD_ADMIN_LISTEN": ""}))
	if err != nil || cfg.AdminListen != "" {
		t.Errorf("empty env: %+v %v", cfg, err)
	}
}

func TestLoopback(t *testing.T) {
	for addr, want := range map[string]bool{"127.0.0.1:8081": true, "localhost:1": true, "[::1]:9": true, ":8081": false, "0.0.0.0:8081": false, "10.0.0.5:1": false} {
		if IsLoopback(addr) != want {
			t.Errorf("%s: want %v", addr, want)
		}
	}
}
