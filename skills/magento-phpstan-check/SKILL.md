---
name: magento-phpstan-check
description: Run phpstan static analysis on a Magento 2 codebase and fix the findings. Use after code changes, before commits, or when the pre-commit quality gate reports phpstan errors. Knows the Magento-specific false positives and the parallel-worker environment quirks.
---

# Magento 2 phpstan Check

Runs phpstan on `app/code` and `app/design` (or a given file list) and drives the
findings to zero. Project-agnostic: works in any Magento 2 codebase with a
`phpstan.neon`. Use the project's CLI wrapper (ddev/warden/docker exec) for
every command.

## Run

```bash
vendor/bin/phpstan analyse --no-progress --error-format=raw app/code/ app/design/
```

Scoped run (changed files only):

```bash
vendor/bin/phpstan analyse --no-progress --error-format=raw $(.claude/skills/magento-performance-review/scripts/perf-gate files --php)
```

## Environment quirks

- **Parallel worker crash** — `Child process error`, `Too many open files`, or
  `Cannot open phar archive for reading`: not code errors. Re-run
  single-threaded with `--debug` (add `--memory-limit=4G`); result is
  authoritative.
- **Mass `Could not read file` lines**: stale result cache or worker crash —
  run `vendor/bin/phpstan clear-result-cache`, retry.
- **Huge scan / fd exhaustion**: check `excludePaths` in `phpstan.neon` covers
  `**/node_modules/**` and other vendor-sized trees inside analysed paths.

## Fixing findings

1. Fix real type errors first — missing return types, wrong parameter types,
   null-safety. These are the point of the tool.
2. Magento false positives (magic getters/setters, `Phrase` vs `string`,
   phtml `$block`/`$escaper` scope) are usually already handled by the
   project's `ignoreErrors` and the bitexpert/phpstan-magento extension —
   check `phpstan.neon` before adding anything.
3. `@phpstan-ignore-next-line` only as last resort: one line, on the exact
   statement, with the reason given in chat/commit — not as a code comment.
4. Never lower `level`, never add blanket path ignores, never ignore an error
   class project-wide to silence one file.
5. After edits, re-run scoped, then full.

## Definition of done

Full run exits 0 with `[OK] No errors` (table format) or empty raw output for
both `app/code/` and `app/design/`.
