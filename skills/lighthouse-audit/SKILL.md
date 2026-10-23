---
name: lighthouse-audit
description: Runs Lighthouse (pinned version, median of N runs, mobile and desktop) on the pages configured in .claude/lighthouse-audit.conf and appends the results as a dated entry to the project's Lighthouse history (default docs/Performance/History-Lighthouse.md). Use when asked to measure, audit, log or compare frontend performance of a live site with Lighthouse.
---

# Lighthouse Audit

Lab performance of a live site, measured with the same Lighthouse version,
pages, devices and run count every time, so entries can be compared over time.
Run it whenever a measurement is needed. Runs from the local machine against
public URLs — no SSH, no ddev, nothing is changed on the server.

## Configuration

Once per project, `.claude/lighthouse-audit.conf` (committed):

```bash
cp .claude/skills/lighthouse-audit/lighthouse-audit.conf.dist .claude/lighthouse-audit.conf
```

- `LIGHTHOUSE_VERSION` — pinned `npx lighthouse@<version>`; changing it breaks
  comparability with older entries
- `RUNS` — runs per page and device; the median is logged
- `DEVICES` — `mobile` and/or `desktop`
- `LOG_FILE` — where the results go (see Output)
- `SITE_<name>=<base URL>` and `PAGES_<name>="label=/path label=/path"` — one
  pair per storefront; the same labels across sites keep the log readable

Requirements: `node` + `npx`, a local Chrome/Chromium.

## Procedure

1. Check the config exists and every page URL answers 200:
   `curl -s -o /dev/null -w '%{http_code}\n' <base><path>` — a redirect or 404
   page gets measured as is and makes the entry useless; ask the user for a
   replacement path.
2. Run from the project root, in the background (one run takes 30–120 s;
   sites × pages × devices × runs):

   ```bash
   node .claude/skills/lighthouse-audit/scripts/lighthouse-audit.mjs
   ```

   Options: `--site <name>` (one site only), `--conf <file>`, `--log <file>`.
   Progress per run goes to stderr.
3. Failed runs show as `error` and are listed under the table; rerun with
   `--site` when a whole row failed.
4. Report to the user: per site the score and LCP per page and device. When
   asked to compare, compare with an older entry of the same pages and devices;
   small changes (a few score points, < 10 % of a timing) are run-to-run noise.

## Output

- Results are appended to `LOG_FILE` from the config, path relative to the
  project root; default `docs/Performance/History-Lighthouse.md`. File and
  folder are created on the first run with a header that explains the columns.
- Newest entry first: `## <date> <time> UTC`, time window, Lighthouse version,
  run count, then one table row per site, page and device: Score, FCP, LCP,
  TBT, CLS, SI, Weight, Requests. Failed runs are listed under the table.
- The same entry is printed to stdout; nothing else is stored (raw Lighthouse
  reports are deleted after the medians are taken).
- The log is a project file: commit it only when the user asks. When `docs/`
  is a git submodule (e.g. a GitLab wiki), commit it in the submodule on its
  default branch first, then bump the pointer in the project.

## Noise rules

- Compare only entries measured from the same machine and network, without
  other heavy load on the machine
- Measure a warm site: right after a deploy or cache flush, open each page once
  first, otherwise the cold cache is measured
- Lighthouse throttles mobile (simulated slow 4G, 4× CPU slowdown); desktop is
  `--preset=desktop`; compare only the same device
