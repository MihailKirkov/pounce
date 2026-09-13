# Backlog

- Deleting a saved search: soft-delete rather than FK cascade, so notification history survives
- income_requirement_multiple comes back from Drizzle as a string; parse at the boundary in the matcher
- Request gap and robots cache are per-process; move to a Redis token bucket if the worker scales past one replica
- Surface robots.txt-unavailable distinctly from parse failures on the Sources page
