// Package store keeps everything in one SQLite file: groups, players, games,
// rounds and the ratings derived from them.
//
// Writes run in IMMEDIATE transactions, so SQLite itself serialises them; every
// rating change (new round, edit, delete, restore) commits the round and all the
// rating rows it affects together.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Limits keep one group from growing without bound. Zero means the default.
type Limits struct {
	Players, Games, Devices, Tournaments, RoundsPerDay int
}

func (l Limits) withDefaults() Limits {
	def := func(v *int, d int) {
		if *v <= 0 {
			*v = d
		}
	}
	def(&l.Players, 200)
	def(&l.Games, 50)
	def(&l.Devices, 500)
	def(&l.Tournaments, 200)
	def(&l.RoundsPerDay, 500)
	return l
}

// Store is the database.
type Store struct {
	db     *sql.DB
	Limits Limits
	// Now is replaceable in tests.
	Now func() time.Time
}

// Open opens (and creates) the database at path and brings its schema up to
// date: every migration the binary knows that the database has not seen yet is
// applied, in order, before Open returns. Use ":memory:" for tests.
func Open(path string) (*Store, error) {
	return openWith(path, migrationFiles, "migrations")
}

func openWith(path string, migrations fs.FS, dir string) (*Store, error) {
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_txlock", "immediate")
	var dsn string
	if path == ":memory:" {
		// A uniquely named shared-cache database, so tests don't see each other.
		q.Set("mode", "memory")
		q.Set("cache", "shared")
		dsn = "file:mem" + randomString(idAlphabet, 10) + "?" + q.Encode()
	} else {
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)")
		dsn = "file:" + path + "?" + q.Encode()
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if path == ":memory:" {
		db.SetMaxOpenConns(1) // every connection would be its own empty database
	}
	s := &Store{db: db, Limits: Limits{}.withDefaults(), Now: time.Now}
	if err := s.migrate(migrations, dir); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// ---- migrations ---------------------------------------------------------------------
//
// Schema changes are numbered SQL files in migrations/ (0001_init.sql,
// 0002_something.sql, ...), compiled into the binary and applied at startup.
// Rules: add a new file for every change and never edit one that has shipped (a
// changed file is detected and refused); each file runs in one transaction, so a
// failing migration leaves the database as it was; a database that has seen a
// migration this binary doesn't know (a newer version wrote to it) is refused
// rather than risk corrupting it.

var migrationName = regexp.MustCompile(`^(\d{4})_[a-z0-9_]+\.sql$`)

type migration struct {
	version  string // the file name
	body     string
	checksum string
}

func loadMigrations(fsys fs.FS, dir string) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, err
	}
	var out []migration
	last := ""
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := migrationName.FindStringSubmatch(e.Name())
		if m == nil {
			return nil, fmt.Errorf("migration file %q must be named NNNN_description.sql", e.Name())
		}
		if m[1] == last {
			return nil, fmt.Errorf("two migrations are numbered %s", m[1])
		}
		last = m[1]
		body, err := fs.ReadFile(fsys, dir+"/"+e.Name())
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: e.Name(), body: string(body), checksum: Hash(string(body))})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

func (s *Store) migrate(fsys fs.FS, dir string) error {
	migrations, err := loadMigrations(fsys, dir)
	if err != nil {
		return err
	}
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	if err := s.refuseNewerDatabase(ctx, migrations); err != nil {
		return err
	}
	for _, m := range migrations {
		if err := s.applyMigration(ctx, m); err != nil {
			return fmt.Errorf("migration %s: %w", m.version, err)
		}
	}
	return nil
}

// applyMigration applies one migration if the database hasn't seen it, on a
// dedicated connection with foreign keys switched off. That is what makes the
// standard SQLite table rebuild (create new, copy, drop old, rename) safe: with
// them on, DROP TABLE would run ON DELETE CASCADE and silently empty the child
// tables. PRAGMA foreign_keys cannot be changed inside a transaction, hence
// the connection; before committing, foreign_key_check refuses a migration that
// leaves dangling references, and the pragma is restored afterwards.
func (s *Store) applyMigration(ctx context.Context, m migration) (err error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	defer func() {
		if _, e := conn.ExecContext(ctx, `PRAGMA foreign_keys = ON`); e != nil && err == nil {
			err = e
		}
	}()
	tx, err := conn.BeginTx(ctx, nil) // BEGIN IMMEDIATE: two servers starting at once queue up
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Checked inside the transaction, so another server can't have applied it meanwhile.
	var sum string
	switch err := tx.QueryRowContext(ctx, `SELECT checksum FROM schema_migrations WHERE version = ?`, m.version).Scan(&sum); {
	case err == nil:
		if sum != m.checksum {
			return fmt.Errorf("%s was changed after it was applied; add a new migration instead", m.version)
		}
		return nil
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}
	if _, err := tx.ExecContext(ctx, m.body); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	dangling := rows.Next()
	rows.Close()
	if dangling {
		return errors.New("it leaves rows whose foreign key points nowhere (PRAGMA foreign_key_check); nothing was changed")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)`, m.version, m.checksum, s.nowMs()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) refuseNewerDatabase(ctx context.Context, migrations []migration) error {
	// A database written by a newer version has migrations this binary lacks.
	known := map[string]bool{}
	for _, m := range migrations {
		known[m.version] = true
	}
	rows, err := s.db.QueryContext(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return err
		}
		if !known[v] {
			return fmt.Errorf("the database has migration %s, which this version of scoreboard doesn't know: it was last used by a newer version, so upgrade the binary", v)
		}
	}
	return rows.Err()
}

// SchemaVersion is the newest applied migration (for the admin API and tests).
func (s *Store) SchemaVersion(ctx context.Context) (string, error) {
	var v sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&v)
	return v.String, err
}

func (s *Store) nowMs() int64 { return s.Now().UnixMilli() }

// write runs fn in a transaction (IMMEDIATE, so writers queue up) and commits
// if it returns nil.
func (s *Store) write(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ---- errors -------------------------------------------------------------------

var (
	// ErrNotFound: the thing doesn't exist (or isn't in the caller's group).
	ErrNotFound = errors.New("not found")
	// ErrLimit: a per-group cap was reached.
	ErrLimit = errors.New("limit reached")
)

// BadRequest is a validation error whose message is safe to show.
type BadRequest string

func (e BadRequest) Error() string { return string(e) }

// NameTakenError carries the player that already has the name.
type NameTakenError struct{ Existing Player }

func (e *NameTakenError) Error() string { return "name taken" }

// ---- ids, tokens, names ----------------------------------------------------------

const (
	idAlphabet   = "abcdefghijklmnopqrstuvwxyz0123456789"
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	maxName      = 40
)

// randomString picks length characters from alphabet, without modulo bias.
func randomString(alphabet string, length int) string {
	max := 256 - (256 % len(alphabet))
	out := make([]byte, 0, length)
	buf := make([]byte, length*2)
	for len(out) < length {
		if _, err := rand.Read(buf); err != nil {
			panic(err)
		}
		for _, b := range buf {
			if int(b) < max && len(out) < length {
				out = append(out, alphabet[int(b)%len(alphabet)])
			}
		}
	}
	return string(out)
}

func newID() string             { return randomString(idAlphabet, 12) }
func newCode() string           { return randomString(codeAlphabet, 8) }
func newDashboardToken() string { return randomString(idAlphabet, 16) }

// NewToken is a 256-bit URL-safe secret (device tokens, owner links).
func NewToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Hash is the SHA-256 hex digest stored instead of a secret.
func Hash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// NormalizeCode turns "abcd-efgh", " ABCD EFGH " and "abcdefgh" into "ABCDEFGH".
func NormalizeCode(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// FormatCode shows a code as ABCD-EFGH.
func FormatCode(code string) string {
	if len(code) != 8 {
		return code
	}
	return code[:4] + "-" + code[4:]
}

// CleanName normalises a user-supplied name: NFKC, no invisible or bidi
// control characters, single spaces, at most 40 characters.
func CleanName(value, field string) (string, error) {
	s := norm.NFKC.String(value)
	s = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", BadRequest(field + " required")
	}
	if len([]rune(s)) > maxName {
		return "", BadRequest(field + " too long")
	}
	return s, nil
}

func nameKey(name string) string { return strings.ToLower(name) }

// Nullable is an optional field of a patch that can also be set to null:
// Set false means "leave unchanged", Set true with Val nil means "clear".
type Nullable[T any] struct {
	Set bool
	Val *T
}

// Some is a Nullable that sets v.
func Some[T any](v T) Nullable[T] { return Nullable[T]{Set: true, Val: &v} }

// Clear is a Nullable that clears the field.
func Clear[T any]() Nullable[T] { return Nullable[T]{Set: true} }

// optionalName is CleanName for fields that may be empty (nil = default).
func optionalName(value *string, field string) (*string, error) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil, nil
	}
	s, err := CleanName(*value, field)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// DeviceLabel is "iPhone · Safari" from a User-Agent, to tell devices apart.
func DeviceLabel(ua string) string {
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(ua, s) {
				return true
			}
		}
		return false
	}
	device := ""
	switch {
	case has("iPhone"):
		device = "iPhone"
	case has("iPad"):
		device = "iPad"
	case has("Android"):
		device = "Android"
	case has("Mac OS X"):
		device = "Mac"
	case has("Windows"):
		device = "Windows"
	case has("CrOS"):
		device = "ChromeOS"
	case has("Linux"):
		device = "Linux"
	}
	browser := ""
	switch {
	case has("Edg/"):
		browser = "Edge"
	case has("Firefox/", "FxiOS"):
		browser = "Firefox"
	case has("Chrome/", "CriOS"):
		browser = "Chrome"
	case has("Safari/"):
		browser = "Safari"
	}
	switch {
	case device != "" && browser != "":
		return device + " · " + browser
	case device != "":
		return device
	}
	return browser
}

// ---- small query helpers ------------------------------------------------------------

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// count returns the first column of a COUNT(*) style query.
func count(ctx context.Context, q queryer, query string, args ...any) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, query, args...).Scan(&n)
	return n, err
}

func notFoundIf(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
