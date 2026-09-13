# Backlog

- Deleting a saved search: soft-delete rather than FK cascade, so notification history survives
- income_requirement_multiple comes back from Drizzle as a string; parse at the boundary in the matcher
- Request gap and robots cache are per-process; move to a Redis token bucket if the worker scales past one replica
- Surface robots.txt-unavailable distinctly from parse failures on the Sources page
- PollingPolicy.backoff doc says 403/429/5xx; the worker backs off on 429/5xx only (sprint 1 T3 spec). Decide whether 403 belongs
- `pnpm dev` on a clean checkout fails: @pounce/db and @pounce/adapter-fake resolve to dist/ but have no watch/build step in dev; run `pnpm build` first
- Worker backoff only reacts to HTTP status; robots-unreachable and parse errors retry every tick
- PC4 centroid table covers Eindhoven/Veldhoven/Best only (packages/core/src/normalize/pc4-centroids.json); bundle the full NL table from the same MIT 4pp source
- normalize validates prices and lat/lng only; NaN or non-integer areaSqm/rooms/bedrooms/deposit and Invalid Date would still fail the listings insert
- docs/sprint-1.md T4 still says "scaffold only"; superseded by DECISIONS #009
- saved_searches.furnished uses the `furnished` pg enum, which has no `not_stated`; the matcher's FurnishingFilter needs a schema change before a search can opt in to unstated furnishing
- core exports `matches()` and @pounce/db exports a `matches` table; the worker will need an import alias when it wires the matcher
- Fuzzy dedup (layer 3) auto-merges at score 0 on the ±5%/±10% edge; decide whether low-score fuzzy hits should merge or only log for review
