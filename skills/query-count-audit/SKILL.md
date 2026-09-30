---
name: query-count-audit
description: Deterministic SQL query-count gate — counts the database queries of the homepage, a PLP and a PDP on the clean HEAD (A) and with the working changes (B) in one scripted run; any page where B needs more queries than A flags red and blocks the commit. History (docs/Performance/History-Queries.md) is written only on degradation.
---

# Query Count Audit (A/B)

Counts **SQL queries per page** (Magento query log) of one FPC-bypassing
request on the clean HEAD (A) and with the working changes (B), and gates on
the count. Query counts are deterministic: same code + same cache procedure =
the same count on any machine, under any load. An increased count is the
regression class that hurts Magento most as data grows: a query in a loop,
N+1 loading, a lookup that stopped being cached. Wall-clock is never measured.
Pure-PHP regressions are covered by `call-count-audit`, diff-level review by
`magento-performance-review`.

## Run

```bash
.claude/skills/magento-performance-review/scripts/perf-gate audit
```

The same run also measures PHP function calls for `call-count-audit` (same
requests) and writes each marker independently — never run it twice for the
two skills.

Run it in the background and wait (2 × `setup:di:compile`, several minutes).
Never do the steps by hand — the script handles the traps (stash always
popped, compiled DI rebuilt per side, query log always disabled again).

What it does: reads the page paths from `.claude/perf-gate.conf` and base URL
+ PHP version from ddev (conf `BASE_URL` / `PHP_VERSION` override), enables the
query log, stashes `app/code` + `app/design` (A), rebuilds, per page 2 warmups
+ 1 measured request with a fresh cache-buster, pops the stash (B, diff hash
verified), rebuilds, measures, tears down, prints `page | query A→B | status`.

Exit codes: `0` queries and calls green (both markers written) or no gated
changes; `1` degradation in either metric (the green metric still gets its
marker, the red one none); `2` setup error (message says what — if it mentions
the stash, check `git stash list` and `git status` first and tell the user).

## Reading the result

Per page: **B > A → 🔴**, no tolerance — every extra query must be explained.
B ≤ A → ✅ (fewer is an improvement, note it). On 🔴 the script prints the
added SQL statements per red page; the logs stay in the web container at
`/tmp/perf-gate/<side>-<page>.sql.log` until the next run.

Any 🔴: **alert the user explicitly** — page, both counts, the added queries.
The commit stays blocked. Only the user can decide to proceed.

## History — written ONLY on degradation

Green run → no history write. On any 🔴, append the flagged pages to
`docs/Performance/History-Queries.md` (create file + folder on the first
degradation):

```markdown
# Performance History — SQL queries per page (degradations only)

Queries of one FPC-bypassing request after 2 warmups, guest, local. A = clean
HEAD, B = HEAD + working changes. Only degradations are recorded.

| Date | Commit | Page | URL | A | B | Status | Cause | Resolution |
|------|--------|------|-----|---|---|--------|-------|------------|
| 2026-01-15 | a1b2c3d4 | plp | https://... | 1400 | 1422 | ✅ fixed | +22: `Foo` plugin queries per product | Batched in `Foo` — re-measured 1395, 5 fewer than A |
```

One row per caught degradation. Status = the final state: `✅ fixed`
(Resolution carries the fix and the re-measured count), `🔴 open` (written
when the flag is reported, before the user decides), or
`🔴 accepted by user, committed`. The Cause cell starts with the delta
(`+N: …`) and names the culprit. Commit = `git rev-parse --short HEAD`.

## Unblocking the pre-commit gate

All green → the script wrote the marker. A 🔴 the user explicitly accepted:
update the history row first, then — in its own Bash call before the commit:

```bash
.claude/skills/magento-performance-review/scripts/perf-gate mark query
```

## Boundaries

Writes only degradation history rows (and, on explicit acceptance, the
marker). No fixes, no config changes — findings become separate approved
tasks.
