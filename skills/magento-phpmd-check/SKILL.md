---
name: magento-phpmd-check
description: Run phpmd mess detection with the Magento ruleset and triage the violations — refactor or justified suppression. Use after code changes, before commits, or when the pre-commit quality gate reports phpmd violations.
---

# Magento 2 phpmd Check

Runs phpmd with the Magento core ruleset and drives touched files to zero
violations. Project-agnostic: works in any Magento 2 codebase. Use the
project's CLI wrapper (ddev/warden/docker exec) for every command.

## Run

```bash
vendor/bin/phpmd app/code/,app/design/ text dev/tests/static/testsuite/Magento/Test/Php/_files/phpmd/ruleset.xml
```

Scoped run — phpmd takes a comma-separated list:

```bash
FILES=$(.claude/skills/magento-performance-review/scripts/perf-gate files --php | tr '\n' ',' | sed 's/,$//')
vendor/bin/phpmd "$FILES" text dev/tests/static/testsuite/Magento/Test/Php/_files/phpmd/ruleset.xml
```

Exit code 2 = violations found (not a tool failure).

When the project has no `dev/tests/` folder, use the copy shipped with
Magento: `vendor/magento/magento2-base/dev/tests/static/testsuite/Magento/Test/Php/_files/phpmd/ruleset.xml`
(the pre-commit gate falls back to it automatically).

## Triage — refactor or suppress

Default is **refactor**. Suppression is the exception and needs a reason the
framework forces on you.

Legitimate suppressions (Magento reality):

- **Plugin/observer signatures**: unused `$subject`, `$observer`, or
  positional plugin arguments required by the interception contract →
  `@SuppressWarnings(PHPMD.UnusedFormalParameter)` docblock on the method.
- **Wiring classes**: UI component data providers, ViewModels and form
  modifiers that legitimately aggregate many dependencies →
  `@SuppressWarnings(PHPMD.CouplingBetweenObjects)` /
  `@SuppressWarnings(PHPMD.ExcessiveParameterList)` on the class, only when
  splitting would be artificial.
- **CookieAndSessionMisuse** on classes that genuinely belong to the
  presentation layer but phpmd cannot tell.

Always refactor, never suppress:

- `CyclomaticComplexity`, `NPathComplexity`, `ExcessiveMethodLength` in **new**
  code — extract methods; the threshold is the design feedback.
- `UnusedLocalVariable`, `UnusedPrivateMethod/Field` — dead code, delete.
- `ElseExpression`, `BooleanArgumentFlag` style rules where the ruleset has
  them — restructure.

Rules:

1. Suppress method-level, not class-level, when the violation is on one method.
2. Justification goes in chat/commit message — not as a code comment.
3. Never suppress to avoid refactoring code you are writing right now.
4. Pre-existing violations in a file you touch: fix or suppress them per the
   table above — the quality gate lints whole files, leaving them blocks the
   commit.

## Definition of done

Scoped run on all touched files exits 0 with no output.
