---
name: call-count-audit
description: Deterministic PHP function-call-count gate — profiles one request per page (homepage, PLP, PDP) with the Xdebug profiler on the clean HEAD (A) and with the working changes (B) in one scripted run; any page where B executes more function calls than A flags red and blocks the commit. History (docs/Performance/History-Calls.md) is written only on degradation.
---

# Call Count Audit (A/B)

Counts the **total PHP function calls** of one FPC-bypassing request per page
from an Xdebug cachegrind profile, on the clean HEAD (A) and with the working
changes (B), and gates on the count. Call counts are deterministic: same code
+ same cache procedure = the same count on any machine, under any load. This
catches the pure-PHP regression class the query gate cannot see: loop
blowups, a method suddenly called thousands of times. Xdebug timing overhead
is irrelevant — only counts are read. DB regressions are covered by
`query-count-audit`, diff-level review by `magento-performance-review`.

## Run

```bash
.claude/skills/magento-performance-review/scripts/perf-gate audit
```

The same run also counts SQL queries for `query-count-audit` (same requests)
and writes each marker independently — never run it twice for the two skills.

Run it in the background and wait (2 × `setup:di:compile`, several minutes).
Never do the steps by hand — the script handles the traps (Magento CLI runs
with `XDEBUG_MODE=off` because CLI PHP waits for an IDE forever while xdebug
is on; fpm restarts via supervisorctl; the stash is always popped; xdebug is
always returned to its previous state).

What it does: reads the page paths from `.claude/perf-gate.conf` and base URL
+ PHP version from ddev (conf `BASE_URL` / `PHP_VERSION` override), enables
the Xdebug profiler in trigger mode, stashes `app/code` + `app/design` + `app/etc/config.php` (A),
rebuilds, per page 2 warmups + 1 profiled request with a fresh cache-buster,
pops the stash (B, diff hash verified), rebuilds, measures, tears down, prints
`page | calls A→B | status`.

Exit codes: `0` queries and calls green (both markers written) or no gated
changes; `1` degradation in either metric (the green metric still gets its
marker, the red one none); `2` setup error (message says what — if it mentions
the stash, check `git stash list` and `git status` first and tell the user).

New modules: when the diff adds a module (new `app/code/<Vendor>/<Module>/registration.php`),
A keeps that module's skeleton — `registration.php`, `etc/module.xml` and the B
`app/etc/config.php` that enables it. The fixed per-request cost of one more registered
module (component registration, module directory path lookups) is then on both sides
and cancels out; B − A is only the module's real code (di, plugins, observers, layout).
The run prints `[a] new module skeletons registered on A` with the module paths.

## Reading the result

Per page: **B > A → 🔴**, no tolerance — every extra call must be explained.
B ≤ A → ✅ (fewer is an improvement, note it). On 🔴 the script prints, per
red page, the top 20 functions called more often (A/B counts). Profiles stay
in the web container at `/tmp/perf-gate/<side>-<page>.cg` until the next run.

Any 🔴: **alert the user explicitly** — page, both totals, the culprit
functions. The commit stays blocked. Only the user can decide to proceed.

## History — written ONLY on degradation

Green run → no history write. On any 🔴, append the flagged pages to
`docs/Performance/History-Calls.md` (create file + folder on the first
degradation):

```markdown
# Performance History — PHP function calls per page (degradations only)

Total function calls of one profiled FPC-bypassing request after 2 warmups,
guest, local. A = clean HEAD, B = HEAD + working changes. Only degradations
are recorded.

| Date | Commit | Page | URL | A | B | Status | Cause | Resolution |
|------|--------|------|-----|---|---|--------|-------|------------|
| 2026-01-15 | a1b2c3d4 | plp | https://... | 4000000 | 4136000 | ✅ fixed | +136000: `Foo::bar` invoked 1200× more | Memoized in `Foo` — re-measured 3998000, fewer than A |
```

One row per caught degradation. Status = the final state: `✅ fixed`
(Resolution carries the fix and the re-measured count), `🔴 open` (written
when the flag is reported, before the user decides), or
`🔴 accepted by user, committed`. The Cause cell starts with the delta
(`+N: …`) and names the increased functions. Commit =
`git rev-parse --short HEAD`.

## Unblocking the pre-commit gate

All green → the script wrote the marker. A 🔴 the user explicitly accepted:
update the history row first, then — in its own Bash call before the commit:

```bash
.claude/skills/magento-performance-review/scripts/perf-gate mark calls
```

## Boundaries

Writes only degradation history rows (and, on explicit acceptance, the
marker). No fixes, no config changes — findings become separate approved
tasks.
