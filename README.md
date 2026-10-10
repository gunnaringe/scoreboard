# Scoreboard

Keep score for office games — a long-running daily Rocket League, table
tennis, anything with two teams. Fair team ratings, no accounts.

- **Groups** with an invite code and a printable QR poster. Anyone with the
  code joins from their phone; no sign-up.
- **Games** in a group, **rounds** in a game: one or more players per team,
  winner, optional score. Optional **tournaments** with their own standings.
- **Ratings** use Weng-Lin (Bradley-Terry), a TrueSkill-style model made for
  teams: uneven teams (1v2) work, and new players move faster than veterans.
- Balanced team suggestions, win odds, "same teams as last time", undo.
- Player pages: rating graph, best teammate, nemesis, head-to-head.
- Admin settings: make everyone admin, choose who may edit or delete rounds,
  rotate the invite code, manage devices and players.
- Themes: auto, light, dark and hacker. English and Norwegian.

## Deploy (one-time, not done yet)

1. `npx wrangler d1 create scoreboard` and put the `database_id` in
   `wrangler.jsonc` (replace the zeros placeholder).
2. `npx wrangler d1 migrations apply scoreboard --remote`
3. Push to GitHub and import the repo in Cloudflare → Workers & Pages →
   Create → Import a repository (Workers Builds). The Worker name must be
   `score`; the custom domain `scoreboard.apphub.casa` comes from `wrangler.jsonc`.
4. After that, every push to `main` deploys. New migrations must be applied
   with step 2 before (or right after) the deploy that needs them.

Cost: free plan. Static files are free and unlimited; API calls count against
the 100,000 requests/day Workers free limit, and D1's free 5M rows read /
100k rows written per day.

## Develop

See `CLAUDE.md`.
