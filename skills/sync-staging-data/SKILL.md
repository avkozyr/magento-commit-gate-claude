---
name: sync-staging-data
description: Copies production data (catalog, CMS, media, optionally settings) to the staging node of a Hypernode Magento 2 shop, keeping staging's own customers, orders, config, admins and tokens. Phased script with a confirmation gate, staging backup, maintenance mode and no dump files left behind. Use when asked to refresh, sync or update staging with production data. Manual invocation only.
---

# Sync Staging Data

Refreshes a staging node from production so testers see the current catalog,
content and images. Runs from the developer machine; the staging node pulls
from production over its own SSH key, so no data passes through the laptop.
Nothing is written on production.

## Configuration

Once per project, `.claude/sync-staging-data.conf` (committed):

```bash
cp .claude/skills/sync-staging-data/sync-staging-data.conf.dist .claude/sync-staging-data.conf
```

- `PROD_<site>` / `STAGING_<site>` — one host pair per site, as many sites
  as the project has (e.g. `life`, `belamo`). The staging host name must
  contain `staging`; the script refuses anything else.
- `PAGES_<site>` — paths the `verify` phase requests on staging
- `URL_MAP_<site>` — `prodhost=staginghost` pairs (one per website, e.g.
  `www.shop.com=stagingshop.hypernode.io showroom.shop.com=showroom.stagingshop.hypernode.io`).
  `post` replaces the production host with the staging host inside content
  columns (menus, CMS, categories, widgets, config) so absolute links typed
  by editors stay on staging. Unset: links keep pointing at production.
- `MAGENTO_ROOT`, `MEDIA_DIR`, `BACKUP_DIR`, `DB`, `KEEP_BACKUPS` —
  Hypernode defaults, usually unchanged
- `MAIL_GUARD=<config path>=<expected value>` — a setting that proves staging
  cannot send real mail (e.g. the mail transport switched off in `env.php`);
  `preflight` fails when it does not match
- `EXTRA_EXCLUDE`, `EXTRA_STRIP`, `EXTRA_SETTINGS_BLACKLIST`,
  `EXTRA_URL_COLUMNS` — project tables, config paths and `table.column`
  pairs added to the built-in lists (below). A `_<site>` suffix overrides
  per site.

Requirements: SSH as `app` to the staging host from the laptop, SSH from the
staging host to production (the first `preflight` prints the key setup when it
is missing), `n98-magerun2` on production.

## Param: `site`

The first argument picks the pair from the conf. If the user did not name
one, ask which site, listing the pairs from the conf, e.g.:

> "Sync `life` (life.hypernode.io → staginglife.hypernode.io) or `belamo`?"

Never guess. Two shops are two runs, each with its own gate.

## Run

From the project root, local shell (not ddev):

```bash
.claude/skills/sync-staging-data/scripts/sync-staging-data <site> all
.claude/skills/sync-staging-data/scripts/sync-staging-data <site> all --no-settings
.claude/skills/sync-staging-data/scripts/sync-staging-data <site> <phase> [--dry-run]
```

Before any mutating phase the script prints site, hosts and phases and waits
for the staging hostname to be typed. Run it in the foreground so the user can
answer; pass `--yes` only when the user explicitly asked to skip the gate.
Start with `preflight` alone when the project or the key setup is new.

## Transparency

The user must be able to follow every step. Rules for running the skill:

1. Run phases one at a time, in order, each as its own command. Use `all`
   only when the user asks for it.
2. Show the script output as it is; do not pipe it through `tail`, `head`
   or `grep`, and do not run it in the background. The script prints every
   command before executing it (`$ …`, with `ssh app@<prod>` marking the
   commands that run on production), a numbered `step n/m` line per step,
   live progress for the dump and the rsync, and the duration per phase.
3. After each phase, report to the user in a few lines: what ran, the
   numbers that matter (sizes, counts, durations, `DIFF`/`WARN` lines), and
   which phase comes next. Wait for the user before the first mutating
   phase (`backup`).
   After `verify`, paste its output verbatim in the reply, in a code block:
   the before / now / prod table, the staging-owned rows, added / removed
   lists, the URL check, pages, and the whole sync summary block. The user
   does not see tool output, only the reply; a condensed version is not
   enough. Every run starts with `preflight`, otherwise `verify` has no
   "before" to compare against.
4. When a phase fails, show the `ERROR: phase … failed at line …` output,
   state what is now in which state (maintenance mode on or off, backup
   file name, temp table present or not) and propose the next command. Do
   not re-run automatically.

## Phases

| Phase | What it does | Re-run |
|---|---|---|
| `preflight` | read-only: SSH chain, n98 options, disk, `base_url` lock, mail guard, row-count snapshot, resolved table lists, leftover dump files | always safe |
| `backup` | full staging DB dump to `BACKUP_DIR`, keeps `KEEP_BACKUPS` | safe |
| `db` | `maintenance:enable`, streams the prod dump into staging (no file on either host), `DEFINER` rewritten to `CURRENT_USER` | safe, drops and recreates the synced tables |
| `media` | `rsync --delete` of prod media; excluded dirs are kept | resumes |
| `settings` | prod `core_config_data` upserted into staging minus the blacklist and every encrypted value; staging-only rows survive; left out with `--no-settings` | safe |
| `post` | `setup:upgrade`, URL rewrite (`URL_MAP`), drops imported triggers and re-subscribes the scheduled indexers, orphan cleanup, `indexer:reindex`, cache + Varnish flush, `maintenance:disable` | safe |
| `verify` | read-only: per synced table before / now / prod / change, staging-owned counts vs snapshot, products, categories and CMS pages added or removed (first 10 listed), no production host left in the URL columns, pages answer, no temp table, no dump files, then the sync summary (dump size and time, media files created / deleted / transferred, settings rows updated / inserted with the saved list, URL rows rewritten, triggers, durations) | always safe; run it right after `post`, production keeps changing |
| `cleanup` | removes the old manual's `migrated_data_export.sql*` on both hosts, drops the temp table, prunes backups; lists other dump files without deleting | safe |

Staging is in maintenance mode from `db` until the end of `post`. When a run
stops in between, fix the cause and run `post` (or restore, see below).

## What is synced

- **Synced**: products, categories, attributes, prices, stock, URL rewrites,
  CMS pages and blocks, Page Builder templates, reviews, search terms and
  synonyms, sales rules, tax, shipping tables, themes/design config, media.
- **Stripped** (structure arrives, table ends up empty on staging): logs,
  sessions, caches, index and changelog tables, replicas, queues of
  third-party modules, bulk/import history. Rebuilt by `post`.
- **Excluded** (staging keeps its own rows): customers, quotes, orders,
  invoices, shipments, credit memos, `core_config_data`, admin users and
  roles, 2FA, integrations and OAuth tokens, `cron_schedule`, message queues,
  `flag`, `indexer_state`, `mview_state`, compare lists, coupon usage.

`--strip` and `--exclude` differ: a stripped table is recreated empty, an
excluded table is not in the dump at all. Staging-owned data must be in the
exclude list. `setup_module` and `patch_list` are synced on purpose: staging
code that is ahead of production then applies its newer patches to the
imported data, exactly as the next production deploy will.

## URL rewrite

Editors type absolute links (`https://www.shop.com/about`) into menus, CMS
content, category descriptions and widgets; the dump brings them along and
staging would send testers to production. `post` runs, per `URL_MAP` pair
and per column in the built-in list (`snowmenu_node.content`,
`cms_page.content`, `cms_block.content`, `catalog_category_entity_text.value`,
`catalog_category_entity_varchar.value`, `catalog_product_entity_text.value`,
`widget_instance.widget_parameters`, `url_rewrite.target_path`,
`email_template.template_text`, `core_config_data.value`, plus
`EXTRA_URL_COLUMNS`; missing tables are skipped):

```sql
UPDATE t SET c = REPLACE(c, 'www.shop.com', 'stagingshop.hypernode.io') WHERE c LIKE '%www.shop.com%'
```

Hostname only, so `https://`, JSON-escaped `https:\/\/` and protocol-relative
links are all covered and e-mail addresses on the bare domain are untouched.
Links to other sites stay. `verify` fails when a production host is still
found in those columns.

## Settings phase

Part of every `all` run (`--no-settings` leaves it out). Every row from production is applied unless its
path matches the blacklist or its value is encrypted (`n:n:base64`). Built-in
blacklist: any path containing `/api/`, `api_key`, `api_secret`, `endpoint`,
`base_url`, `secret`, `token`, `password`, `webhook`, `enable_live`, `sandbox`
or `mock` (integration endpoints, credentials and live/test switches, also
when stored in plain text), plus base and link URLs, cookies, search engine
hosts, `system/*`, `dev/*`, `admin/*`, 2FA, PayPal, Google/GTM ids, Sentry,
reCAPTCHA keys.
Project credentials and modes (payment providers, POS, CDP keys, consent
ids, tax providers) go into `EXTRA_SETTINGS_BLACKLIST`. Use
`settings --dry-run` first: it prints every row that would change.

## Restore

```bash
ssh app@<staging> 'gunzip -c /data/web/backups/<site>-staging-pre-sync-<ts>.sql.gz | mysql magento2 && cd /data/web/magento2/current && bin/magento setup:upgrade --keep-generated && bin/magento indexer:reindex && bin/magento cache:flush && bin/magento maintenance:disable'
```

## Troubleshooting

- `staging cannot ssh to app@<prod>` — follow the three printed steps; the
  key on production should carry `from=`, `no-pty` and the `no-*-forwarding`
  options. The script never installs keys.
- `n98-magerun2 on <prod> lacks …` — old magerun on the node; ask hosting to
  update before running.
- `web/unsecure/base_url … env.php lock missing` — the staging `env.php` does
  not pin its URLs; fix that first, otherwise the DB import could point
  staging at production URLs.
- Run interrupted during `db` — staging stays in maintenance mode; re-run
  `db` (idempotent) or restore the backup.
- Scheduled indexers not catching up after the sync — `verify` prints
  `WARN mview … ahead of changelog`; run `bin/magento indexer:reindex` on
  staging, it realigns the versions.

## Definition of done

`verify` ends with `verify ok` for every site that was synced, and the
project's staging smoke test passes.
