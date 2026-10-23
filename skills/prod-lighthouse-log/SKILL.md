---
name: prod-lighthouse-log
description: Measures the production storefront with Lighthouse (pinned version, median of N runs, mobile and desktop) just before and just after a release, and appends the results to the project's prod Lighthouse log (default docs/Performance/Prod-Lighthouse.md) with the delta vs the before run. Use when asked to measure, log or compare production frontend performance around a release or deploy.
---

# Prod Lighthouse Log

Lab performance of the live site, measured with the same Lighthouse version,
pages, devices and run count around every release, so releases can be compared
over time. Runs from the local machine against public production URLs — no SSH,
no ddev, nothing is changed on the server.

## Configuration

Once per project, `.claude/prod-lighthouse-log.conf` (committed):

```bash
cp .claude/skills/prod-lighthouse-log/prod-lighthouse-log.conf.dist .claude/prod-lighthouse-log.conf
```

- `LIGHTHOUSE_VERSION` — pinned `npx lighthouse@<version>`; changing it breaks
  comparability, log a new `baseline` right after a bump
- `RUNS` — runs per page and device; the median is logged
- `DEVICES` — `mobile` and/or `desktop`
- `LOG_FILE` — markdown log, created with a header on the first run
- `SITE_<name>=<base URL>` and `PAGES_<name>="label=/path label=/path"` — one
  pair per storefront; the same labels across sites keep the log readable

Requirements: `node` + `npx`, a local Chrome/Chromium.

## Phases

- `before` — right before the deploy of a release (the previous release is live)
- `after` — right after the deploy and cache warm-up of the same release; each
  value gets the change vs the `before` entry of that release, ⚠ marks worse
- `baseline` — reference run outside a release (first run, Lighthouse bump,
  new pages)

`--release` is the release being deployed, for both `before` and `after`
(e.g. `2.7.5`); without it the latest local git tag is used. Ask the user for
the release when it is not given.

## Procedure

1. Check the config exists and every page URL answers 200:
   `curl -s -o /dev/null -w '%{http_code}\n' <base><path>` — a redirect or 404
   page gets measured as is and makes the entry useless; ask the user for a
   replacement path.
2. Run from the project root, in the background (one run takes 30–120 s;
   sites × pages × devices × runs):

   ```bash
   node .claude/skills/prod-lighthouse-log/scripts/prod-lighthouse.mjs --phase before --release 2.7.5
   ```

   Options: `--site <name>` (one site only), `--conf <file>`, `--log <file>`.
   Progress per run goes to stderr, the new entry to stdout.
3. Failed runs show as `error` and are listed under the table; rerun with
   `--site` when a whole row failed (a partial site entry is logged as its own
   entry).
4. Report to the user: per site the score and LCP per page and device, and for
   `after` every ⚠ value. Small changes (a few points of score, < 10 % of a
   timing) are within run-to-run noise of lab data; call out only clear shifts.
5. The log is a project file: commit it only when the user asks.

## Noise rules

- Measure `before` and `after` from the same machine and network, without
  other heavy load on the machine
- `after`: only after the deploy finished and the full-page cache is warm
  (open each page once), otherwise the cold cache is measured
- Lighthouse throttles mobile (simulated slow 4G, 4× CPU slowdown); desktop is
  `--preset=desktop`
