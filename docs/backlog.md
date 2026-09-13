# Backlog

- Deleting a saved search: soft-delete rather than FK cascade, so notification history survives
- income_requirement_multiple comes back from Drizzle as a string; parse at the boundary in the matcher
- Request gap and robots cache are per-process; move to a Redis token bucket if the worker scales past one replica
- Surface robots.txt-unavailable distinctly from parse failures on the Sources page
- PollingPolicy.backoff doc says 403/429/5xx; the worker backs off on 429/5xx only (sprint 1 T3 spec). Decide whether 403 belongs
- `pnpm dev` on a clean checkout fails: @pounce/db and @pounce/adapter-fake resolve to dist/ but have no watch/build step in dev; run `pnpm build` first
- Worker backoff only reacts to HTTP status; robots-unreachable and parse errors retry every tick
