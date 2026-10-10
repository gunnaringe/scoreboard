# Scoreboard

Keep score for office games — a long-running daily Rocket League, table
tennis, anything with two teams. Fair team ratings, no accounts.

- **Groups** for an office or location, with three links:
  - the **office link** (code, QR poster, share button): colleagues scan it and
    pick their name — no sign-up — and can then log and edit rounds;
  - the **dashboard link**: a read-only leaderboard for a wall screen or TV;
  - the **owner link**: makes a device an owner, who can replace the office and
    dashboard links (and the owner link itself), rename or delete the group.
- **Games** in a group, **rounds** in a game: one or more players per team,
  winner, optional score. Optional **tournaments** with their own standings.
- **Ratings** use Weng-Lin (Bradley-Terry), a TrueSkill-style model made for
  teams. Uneven teams (2 against 1) are handled with a learned handicap, new
  players are listed separately until they've played 10 rounds.
- Fast logging: the sheet opens with the last line-up, tapping who won saves,
  Undo fixes mistakes. Balanced team suggestions and win odds.
- Player pages: rating graph, best teammate, nemesis, head-to-head.
- Themes: auto, light, dark and hacker. English and Norwegian.

## Deploy

The D1 database `scoreboard` exists (its ID is in `wrangler.jsonc`). One-time
setup left:

1. Cloudflare dashboard → Workers & Pages → Create → Import a repository →
   `gunnaringe/scoreboard`. The Worker name must be `scoreboard`; the custom
   domain `scoreboard.apphub.casa` comes from `wrangler.jsonc`.
2. Set the **deploy command** to `npm run deploy`. It applies pending D1
   migrations (`migrations/`) and then deploys, so schema changes ship with
   the code. If the first build fails with a D1 permission error, give the
   build's API token **D1: Edit**.

After that, every push to `main` migrates and deploys.

Cost: free plan. Static files are free and unlimited; API calls count against
the 100,000 requests/day Workers free limit, and D1's free 5M rows read /
100k rows written per day (shared by the whole Cloudflare account). Rate
limits and caps keep one group from using those up.

## Develop

See `CLAUDE.md`.
