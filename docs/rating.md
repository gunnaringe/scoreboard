# How the ratings work

Scoreboard rates players with Weng-Lin (Bradley-Terry), a TrueSkill-style
model built for teams. Everyone starts at 1000. Beating stronger players gives
more than beating weaker ones, and losing to weaker players costs more.

- **Teams.** A team's strength is the sum of its players' skill. Uneven teams
  (2 against 1) are fine: each format ("2v1", "3v2"…) gets a handicap that the
  app learns from the results, so the bigger team is not simply assumed to win.
- **New players** move a lot (40 points or more per round) while the app
  works out how good they are, and are listed apart as "new" until they have
  played 10 rounds.
- **The number shown** is the skill estimate minus its uncertainty, so it
  rises as the app becomes more sure about a player.
- **Win odds and "balance teams"** in the round sheet use the same ratings.
- **Edits are exact.** Changing or deleting an old round replays the game from
  the first round, so ratings are always what they would have been had the
  history been right all along.

All of it runs on the server (`internal/rating`); the browser only shows the
results.

## Rating speed

Every player has a skill estimate and an uncertainty. A win against stronger
players moves the estimate more than a win against weaker ones, and the more
uncertain the estimate, the further it moves: new players find their level in
a handful of rounds. As someone plays more, the uncertainty shrinks and so does
the step per round. That keeps a long-time player's rating from jumping around
after one bad day, but it also means someone who really gets better climbs
slowly.

To keep ratings from freezing, a little uncertainty is added back before every
round. How much is the game's **rating speed** (Group settings → the game →
*Rating speed*, or `scoreboard admin games speed`):

| Speed | Use it for | Points for a win between equals | Rounds to catch up after getting 100 points better | Typical drift around the true level |
|---|---|---|---|---|
| **Steady** (default) | team games, and games where skill hardly changes | ~5 | ~80 | ±20 |
| **Medium** | in between | ~10 | ~30 | ±30 |
| **Fast** | games people get better at quickly: table tennis, foosball | ~18 | ~15 | ±50 |

The numbers come from simulating a group of six playing 1-against-1, for
players with about 300 rounds each; they are rough. Newcomers move much more
(40 points or so per round) whatever the speed. Faster is not better, just more
weight on recent results: it shows improvement sooner but also reads more into
a lucky streak.

Things to know before switching:

- **It re-rates the whole game.** Every round is replayed with the new speed, so
  the ratings are what they would have been had the game always used it.
  Switching back gives exactly the old ratings again.
- **Long-time players will show a little lower.** The number shown is the skill
  estimate minus its uncertainty, and a faster speed keeps the uncertainty
  higher: about 20 points lower on Medium and 45 on Fast. Everyone with a long
  history drops by about the same, so their order hardly changes.
- It only affects this game; win odds and balancing use the same ratings.

Compared with classic Elo: Elo with the common K = 32 moves 16 points for a win
between equals, for everyone, so for long-time players Fast is about Elo and
Steady is much calmer. Unlike Elo, newcomers move 40 points or more per round
here, so they find their level in a handful of rounds.
