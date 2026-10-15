package store

import (
	"context"
	"database/sql"
	"strings"
)

// Group is an office or location: it has players, games and three links.
type Group struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	InviteCode     string `json:"-"`
	DashboardToken string `json:"-"`
	CreatedAt      int64  `json:"createdAt"`
}

// Device is a browser that joined a group.
type Device struct {
	ID        string `json:"id"`
	GroupID   string `json:"-"`
	Owner     bool   `json:"owner"`
	Label     string `json:"label"`
	CreatedAt int64  `json:"createdAt"`
	LastSeen  *int64 `json:"lastSeen"`
}

func scanGroup(row interface{ Scan(...any) error }) (Group, error) {
	var g Group
	err := row.Scan(&g.ID, &g.Name, &g.InviteCode, &g.DashboardToken, &g.CreatedAt)
	return g, notFoundIf(err)
}

const groupCols = `id, name, invite_code, dashboard_token, created_at`

// GetGroup returns one group.
func (s *Store) GetGroup(ctx context.Context, id string) (Group, error) {
	return scanGroup(s.db.QueryRowContext(ctx, `SELECT `+groupCols+` FROM groups WHERE id = ?`, id))
}

// GroupByDashboardToken finds the group a dashboard link belongs to.
func (s *Store) GroupByDashboardToken(ctx context.Context, token string) (Group, error) {
	return scanGroup(s.db.QueryRowContext(ctx, `SELECT `+groupCols+` FROM groups WHERE dashboard_token = ?`, token))
}

// ListGroups returns every group, oldest first, with simple counts.
type GroupSummary struct {
	Group
	Players, Games, Rounds, Devices int
}

func (s *Store) ListGroups(ctx context.Context) ([]GroupSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT g.id, g.name, g.invite_code, g.dashboard_token, g.created_at,
		  (SELECT COUNT(*) FROM players WHERE group_id = g.id),
		  (SELECT COUNT(*) FROM games WHERE group_id = g.id),
		  (SELECT COUNT(*) FROM rounds r JOIN games x ON x.id = r.game_id WHERE x.group_id = g.id AND r.deleted_at IS NULL),
		  (SELECT COUNT(*) FROM devices WHERE group_id = g.id)
		FROM groups g ORDER BY g.created_at, g.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GroupSummary
	for rows.Next() {
		var g GroupSummary
		if err := rows.Scan(&g.ID, &g.Name, &g.InviteCode, &g.DashboardToken, &g.CreatedAt, &g.Players, &g.Games, &g.Rounds, &g.Devices); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// CreatedGroup is what creating a group hands back.
type CreatedGroup struct {
	Group       Group
	GameID      string
	DeviceToken string // empty when no device was created (operator-made groups)
	OwnerToken  string // shown once; only its hash is kept
}

// CreateGroup makes a group with an optional first player and game. When ua is
// non-empty the caller's browser becomes its first device and an owner.
func (s *Store) CreateGroup(ctx context.Context, name, playerName, gameName string, withDevice bool, ua string) (CreatedGroup, error) {
	name, err := CleanName(name, "group name")
	if err != nil {
		return CreatedGroup{}, err
	}
	if playerName != "" {
		if playerName, err = CleanName(playerName, "player name"); err != nil {
			return CreatedGroup{}, err
		}
	}
	if gameName != "" {
		if gameName, err = CleanName(gameName, "game name"); err != nil {
			return CreatedGroup{}, err
		}
	}
	now := s.nowMs()
	out := CreatedGroup{OwnerToken: NewToken()}
	out.Group = Group{ID: newID(), Name: name, InviteCode: newCode(), DashboardToken: newDashboardToken(), CreatedAt: now}
	err = s.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO groups (id, name, invite_code, dashboard_token, owner_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			out.Group.ID, name, out.Group.InviteCode, out.Group.DashboardToken, Hash(out.OwnerToken), now); err != nil {
			return err
		}
		if playerName != "" {
			if _, err := tx.ExecContext(ctx, `INSERT INTO players (id, group_id, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)`,
				newID(), out.Group.ID, playerName, nameKey(playerName), now); err != nil {
				return err
			}
		}
		if withDevice {
			out.DeviceToken = NewToken()
			if _, err := tx.ExecContext(ctx, `INSERT INTO devices (id, token_hash, group_id, is_owner, label, created_at, last_seen) VALUES (?, ?, ?, 1, ?, ?, ?)`,
				newID(), Hash(out.DeviceToken), out.Group.ID, DeviceLabel(ua), now, now); err != nil {
				return err
			}
		}
		if gameName != "" {
			out.GameID = newID()
			if _, err := tx.ExecContext(ctx, `INSERT INTO games (id, group_id, name, created_at) VALUES (?, ?, ?, ?)`, out.GameID, out.Group.ID, gameName, now); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

// EnsureGroup creates the group with a fixed id if it doesn't exist yet (single
// mode's implicit group). It has no owner link worth sharing: administration
// happens through the admin port.
func (s *Store) EnsureGroup(ctx context.Context, id, name string) (Group, error) {
	if g, err := s.GetGroup(ctx, id); err == nil {
		return g, nil
	}
	g := Group{ID: id, Name: name, InviteCode: newCode(), DashboardToken: newDashboardToken(), CreatedAt: s.nowMs()}
	err := s.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO groups (id, name, invite_code, dashboard_token, owner_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			id, name, g.InviteCode, g.DashboardToken, Hash(NewToken()), g.CreatedAt)
		return err
	})
	if err != nil {
		return Group{}, err
	}
	return s.GetGroup(ctx, id)
}

func (s *Store) addDevice(ctx context.Context, tx *sql.Tx, groupID string, owner bool, ua string) (string, error) {
	n, err := count(ctx, tx, `SELECT COUNT(*) FROM devices WHERE group_id = ?`, groupID)
	if err != nil {
		return "", err
	}
	if n >= s.Limits.Devices {
		return "", ErrLimit
	}
	token := NewToken()
	now := s.nowMs()
	_, err = tx.ExecContext(ctx, `INSERT INTO devices (id, token_hash, group_id, is_owner, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		newID(), Hash(token), groupID, b2i(owner), DeviceLabel(ua), now, now)
	return token, err
}

// Join adds a member device to the group the office code belongs to.
func (s *Store) Join(ctx context.Context, code, ua string) (Group, string, error) {
	code = NormalizeCode(code)
	if len(code) != 8 {
		return Group{}, "", ErrNotFound
	}
	g, err := scanGroup(s.db.QueryRowContext(ctx, `SELECT `+groupCols+` FROM groups WHERE invite_code = ?`, code))
	if err != nil {
		return Group{}, "", err
	}
	return s.JoinGroup(ctx, g.ID, ua)
}

// JoinGroup adds a member device to a group directly (single mode).
func (s *Store) JoinGroup(ctx context.Context, groupID, ua string) (Group, string, error) {
	g, err := s.GetGroup(ctx, groupID)
	if err != nil {
		return Group{}, "", err
	}
	var token string
	err = s.write(ctx, func(tx *sql.Tx) (err error) {
		token, err = s.addDevice(ctx, tx, groupID, false, ua)
		return
	})
	return g, token, err
}

// ClaimOwner makes a browser an owner using the owner link's token. known are
// device tokens the browser already holds: if one of them is a device in the
// group it is promoted (newToken stays empty), otherwise a new owner device is made.
func (s *Store) ClaimOwner(ctx context.Context, ownerToken string, known []string, ua string) (g Group, newToken string, err error) {
	var id string
	if err = s.db.QueryRowContext(ctx, `SELECT id FROM groups WHERE owner_hash = ?`, Hash(ownerToken)).Scan(&id); err != nil {
		return Group{}, "", notFoundIf(err)
	}
	if g, err = s.GetGroup(ctx, id); err != nil {
		return Group{}, "", err
	}
	err = s.write(ctx, func(tx *sql.Tx) error {
		for i, k := range known {
			if i >= 50 {
				break
			}
			res, err := tx.ExecContext(ctx, `UPDATE devices SET is_owner = 1 WHERE group_id = ? AND token_hash = ?`, id, Hash(k))
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				return nil
			}
		}
		newToken, err = s.addDevice(ctx, tx, id, true, ua)
		return err
	})
	return g, newToken, err
}

// RotateLink replaces one of the group's links; the old one stops working.
// kind is "office", "dashboard" or "owner". It returns the new secret: the
// formatted code, the dashboard token or the owner token.
func (s *Store) RotateLink(ctx context.Context, groupID, kind string) (string, error) {
	var value, query string
	var arg string
	switch kind {
	case "office":
		value = newCode()
		query, arg = `UPDATE groups SET invite_code = ? WHERE id = ?`, value
	case "dashboard":
		value = newDashboardToken()
		query, arg = `UPDATE groups SET dashboard_token = ? WHERE id = ?`, value
	case "owner":
		value = NewToken()
		query, arg = `UPDATE groups SET owner_hash = ? WHERE id = ?`, Hash(value)
	default:
		return "", ErrNotFound
	}
	res, err := s.db.ExecContext(ctx, query, arg, groupID)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", ErrNotFound
	}
	if kind == "office" {
		return FormatCode(value), nil
	}
	return value, nil
}

// Authenticate finds the device a bearer token belongs to. It records "last
// seen" at most once a day.
func (s *Store) Authenticate(ctx context.Context, token string) (Device, error) {
	var d Device
	var label sql.NullString
	var lastSeen sql.NullInt64
	var owner int
	err := s.db.QueryRowContext(ctx, `SELECT id, group_id, is_owner, label, created_at, last_seen FROM devices WHERE token_hash = ?`, Hash(token)).
		Scan(&d.ID, &d.GroupID, &owner, &label, &d.CreatedAt, &lastSeen)
	if err != nil {
		return Device{}, notFoundIf(err)
	}
	d.Owner = owner == 1
	d.Label = label.String
	now := s.nowMs()
	if !lastSeen.Valid || now-lastSeen.Int64 > 86400000 {
		_, _ = s.db.ExecContext(ctx, `UPDATE devices SET last_seen = ? WHERE id = ?`, now, d.ID)
	} else {
		d.LastSeen = &lastSeen.Int64
	}
	return d, nil
}

// ListDevices returns a group's devices, oldest first.
func (s *Store) ListDevices(ctx context.Context, groupID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, is_owner, label, created_at, last_seen FROM devices WHERE group_id = ? ORDER BY created_at, id`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		d := Device{GroupID: groupID}
		var label sql.NullString
		var last sql.NullInt64
		var owner int
		if err := rows.Scan(&d.ID, &owner, &label, &d.CreatedAt, &last); err != nil {
			return nil, err
		}
		d.Owner = owner == 1
		d.Label = label.String
		if last.Valid {
			d.LastSeen = &last.Int64
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ListOwners returns the devices that are owners, for showing who they are.
func (s *Store) ListOwners(ctx context.Context, groupID string) ([]Device, error) {
	all, err := s.ListDevices(ctx, groupID)
	if err != nil {
		return nil, err
	}
	owners := []Device{}
	for _, d := range all {
		if d.Owner {
			owners = append(owners, d)
		}
	}
	return owners, nil
}

// DeleteDevice removes a device from a group.
func (s *Store) DeleteDevice(ctx context.Context, groupID, deviceID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM devices WHERE id = ? AND group_id = ?`, deviceID, groupID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetOwner promotes or demotes a device (admin CLI).
func (s *Store) SetOwner(ctx context.Context, groupID, deviceID string, owner bool) error {
	res, err := s.db.ExecContext(ctx, `UPDATE devices SET is_owner = ? WHERE id = ? AND group_id = ?`, b2i(owner), deviceID, groupID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RenameGroup changes a group's name.
func (s *Store) RenameGroup(ctx context.Context, groupID, name string) error {
	name, err := CleanName(name, "group name")
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE groups SET name = ? WHERE id = ?`, name, groupID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteGroup removes a group and everything in it.
func (s *Store) DeleteGroup(ctx context.Context, groupID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM groups WHERE id = ?`, groupID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// GroupByName finds a group by exact (case-insensitive) name or id, for the CLI.
func (s *Store) FindGroup(ctx context.Context, ref string) (Group, error) {
	if g, err := s.GetGroup(ctx, ref); err == nil {
		return g, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+groupCols+` FROM groups WHERE lower(name) = ?`, strings.ToLower(ref))
	if err != nil {
		return Group{}, err
	}
	defer rows.Close()
	var found []Group
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return Group{}, err
		}
		found = append(found, g)
	}
	switch len(found) {
	case 0:
		return Group{}, ErrNotFound
	case 1:
		return found[0], nil
	}
	return Group{}, BadRequest("several groups have that name; use the id")
}
