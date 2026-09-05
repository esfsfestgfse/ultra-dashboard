# DASH sports source audit

The ticker keeps the original two-lane presentation. Sources are now treated as a priority queue feeding one normalized game model, not as independent HTML painters.

## Source priority

| Priority | Source / endpoint | Coverage | Role | Acceptance gate |
| --- | --- | --- | --- | --- |
| 1 | MLB StatsAPI `/api/v1/schedule?sportId=1&hydrate=linescore,team` | MLB | League authority | Real team names, explicit Live/Final state, both scores when applicable |
| 1 | NHL web API `/v1/score/{Central date}` | NHL | League authority | `LIVE`/`CRIT` or final state, real team names, both scores |
| 1 | Squiggle `?q=games;year={year};live=1` | AFL | League authority | `complete` strictly between 0 and 100 for live; real teams; both scores |
| 1 | NASCAR live feeds | NASCAR | Strict racing poller | Race session/run flags, current feed, progressing laps, freshness |
| 1 | OpenF1 session/position feeds | Formula 1 | Supplemental racing source | Race session window, current session, fresh position data |
| 2 | ESPN scoreboard endpoints | NFL, MLB, NBA, NHL, WNBA, college football/basketball, MLS/NWSL, selected international soccer, ATP/WTA, UFC, PGA | Broad primary | Provider state only; no timestamp-only or numeric-only live inference |
| 3 | TheSportsDB `livescore.php?s={sport}` | Soccer, tennis, cricket, rugby | International gap filler | Explicit textual in-play marker and both scores; numeric-only progress is rejected |

The Worker calls a bounded, curated ESPN set with a concurrency limit, then the league-authority backups and the small international gap set. The page normally consumes one `/bundle` snapshot. Direct browser requests are a recovery path for a failed or stale edge snapshot.

## Normalized model

Every accepted record has:

- `source`, `sourcePriority`, `sport`, `league`, `kind`
- `state`: `live`, `final`, or `scheduled`
- `competitors[]` with stable id, real name, score/rank, and participant type
- `eventId`, `startTime`, `updatedAt`, `sourcePath`, `confidence`, and metadata

`kind` is one of `team`, `golf`, `tennis`, `racing`, or `combat`. Cross-provider dedupe uses normalized participant names, sport, kind, and date; source-specific event IDs are retained for focus links but are not used as the only dedupe key.

## Ticker behavior

- Live lane: only explicit provider live states that pass the sport-specific validation gate.
- Today lane: same-day finals with verified scores.
- Upcoming/favorites: retained in the normalized state and exposed in the existing Live dropdown, with favorites first.
- A failed source uses its short last-good cache. Stale live rows expire quickly; the strip remains populated with a truthful “No verified live games” state instead of inventing a game.

`fctv33hd.work` remains a click-through destination only. It is not a score source and never determines whether a game is live.
