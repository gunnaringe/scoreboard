package store

import (
	"strings"
	"testing"
	"testing/fstest"
)

func files(m map[string]string) fstest.MapFS {
	out := fstest.MapFS{}
	for name, body := range m {
		out["migrations/"+name] = &fstest.MapFile{Data: []byte(body)}
	}
	return out
}

const m1 = `CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`
const m2 = `ALTER TABLE things ADD COLUMN size INTEGER NOT NULL DEFAULT 7;`

func columns(t *testing.T, s *Store, table string) []string {
	t.Helper()
	rows, err := s.db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		out = append(out, n)
	}
	return out
}

func TestEmbeddedSchemaAppliesAtStartup(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	v, err := s.SchemaVersion(ctx)
	if err != nil || v != "0005_game_format.sql" {
		t.Fatalf("schema version %q %v", v, err)
	}
	for _, table := range []string{"groups", "players", "devices", "games", "tournaments", "rounds", "round_players", "ratings", "handicaps"} {
		if len(columns(t, s, table)) == 0 {
			t.Errorf("table %s missing", table)
		}
	}
}

func TestUpgradeKeepsDataAndAppliesOnlyNewMigrations(t *testing.T) {
	path := t.TempDir() + "/up.db"
	old, err := openWith(path, files(map[string]string{"0001_init.sql": m1}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.db.Exec(`INSERT INTO things (name) VALUES ('kept')`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	// Restarting with the same binary changes nothing...
	same, err := openWith(path, files(map[string]string{"0001_init.sql": m1}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	same.Close()

	// ...a newer binary applies just the new migration, on the existing data.
	up, err := openWith(path, files(map[string]string{"0001_init.sql": m1, "0002_size.sql": m2}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	defer up.Close()
	var name string
	var size int
	if err := up.db.QueryRow(`SELECT name, size FROM things`).Scan(&name, &size); err != nil || name != "kept" || size != 7 {
		t.Fatalf("%q %d %v", name, size, err)
	}
	if v, _ := up.SchemaVersion(ctx); v != "0002_size.sql" {
		t.Fatalf("version %q", v)
	}
	if n := len(columns(t, up, "things")); n != 3 {
		t.Fatalf("%d columns", n)
	}
	var applied int
	up.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&applied)
	if applied != 2 {
		t.Fatalf("%d rows in schema_migrations", applied)
	}
}

func TestFailedMigrationChangesNothing(t *testing.T) {
	path := t.TempDir() + "/fail.db"
	good, err := openWith(path, files(map[string]string{"0001_init.sql": m1}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	good.Close()
	_, err = openWith(path, files(map[string]string{
		"0001_init.sql": m1,
		"0002_bad.sql":  `ALTER TABLE things ADD COLUMN extra TEXT; INSERT INTO nowhere VALUES (1);`,
	}), "migrations")
	if err == nil || !strings.Contains(err.Error(), "0002_bad.sql") {
		t.Fatalf("got %v", err)
	}
	again, err := openWith(path, files(map[string]string{"0001_init.sql": m1}), "migrations")
	if err != nil {
		t.Fatalf("database left unusable: %v", err)
	}
	defer again.Close()
	if n := len(columns(t, again, "things")); n != 2 {
		t.Fatalf("the half-applied ALTER stayed: %d columns", n)
	}
}

func TestNewerDatabaseIsRefused(t *testing.T) {
	path := t.TempDir() + "/new.db"
	n, err := openWith(path, files(map[string]string{"0001_init.sql": m1, "0002_size.sql": m2}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	n.Close()
	_, err = openWith(path, files(map[string]string{"0001_init.sql": m1}), "migrations")
	if err == nil || !strings.Contains(err.Error(), "newer version") {
		t.Fatalf("got %v", err)
	}
}

func TestEditedMigrationIsRefused(t *testing.T) {
	path := t.TempDir() + "/edit.db"
	a, err := openWith(path, files(map[string]string{"0001_init.sql": m1}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	_, err = openWith(path, files(map[string]string{"0001_init.sql": m1 + " -- tweaked"}), "migrations")
	if err == nil || !strings.Contains(err.Error(), "changed after it was applied") {
		t.Fatalf("got %v", err)
	}
}

func TestBadMigrationNames(t *testing.T) {
	for name, set := range map[string]map[string]string{
		"no number":      {"init.sql": m1},
		"bad characters": {"0001_Init.sql": m1},
		"duplicate":      {"0001_a.sql": m1, "0001_b.sql": m2},
	} {
		if _, err := openWith(":memory:", files(set), "migrations"); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

// The classic SQLite migration: rebuild a table (create new, copy, drop old,
// rename). With foreign keys on, DROP TABLE would run ON DELETE CASCADE and
// silently empty the child tables; the runner must switch them off for the
// migration and then verify nothing dangles.
func TestTableRebuildKeepsChildRows(t *testing.T) {
	const parentChild = `
		CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE, note TEXT);`
	const rebuild = `
		CREATE TABLE parents_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 0);
		INSERT INTO parents_new (id, name) SELECT id, name FROM parents;
		DROP TABLE parents;
		ALTER TABLE parents_new RENAME TO parents;`
	path := t.TempDir() + "/rebuild.db"
	old, err := openWith(path, files(map[string]string{"0001_init.sql": parentChild}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO parents (id, name) VALUES (1, 'a'), (2, 'b')`,
		`INSERT INTO children (parent_id, note) VALUES (1, 'x'), (1, 'y'), (2, 'z')`,
	} {
		if _, err := old.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()

	up, err := openWith(path, files(map[string]string{"0001_init.sql": parentChild, "0002_rank.sql": rebuild}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	defer up.Close()
	var children, parents int
	up.db.QueryRow(`SELECT COUNT(*) FROM children`).Scan(&children)
	up.db.QueryRow(`SELECT COUNT(*) FROM parents`).Scan(&parents)
	if parents != 2 || children != 3 {
		t.Fatalf("after the rebuild: %d parents, %d children (the cascade ate the children)", parents, children)
	}
	// Foreign keys are enforced again afterwards, on every connection of the pool.
	var on int
	up.db.QueryRow(`PRAGMA foreign_keys`).Scan(&on)
	if on != 1 {
		t.Fatal("foreign keys left switched off")
	}
	if _, err := up.db.Exec(`INSERT INTO children (parent_id) VALUES (999)`); err == nil {
		t.Fatal("a child without a parent was accepted")
	}
}

// A migration that leaves dangling references is refused and rolled back.
func TestMigrationLeavingDanglingReferencesIsRefused(t *testing.T) {
	const base = `
		CREATE TABLE parents (id INTEGER PRIMARY KEY);
		CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id));
		INSERT INTO parents VALUES (1);
		INSERT INTO children (parent_id) VALUES (1);`
	path := t.TempDir() + "/dangling.db"
	a, err := openWith(path, files(map[string]string{"0001_init.sql": base}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	_, err = openWith(path, files(map[string]string{"0001_init.sql": base, "0002_oops.sql": `DELETE FROM parents;`}), "migrations")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "foreign key") {
		t.Fatalf("got %v", err)
	}
	again, err := openWith(path, files(map[string]string{"0001_init.sql": base}), "migrations")
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	var n int
	again.db.QueryRow(`SELECT COUNT(*) FROM parents`).Scan(&n)
	if n != 1 {
		t.Fatal("the bad migration was not rolled back")
	}
}
