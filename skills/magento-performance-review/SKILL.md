---
name: magento-performance-review
description: Performance review of changed PHP/SQL code in a Magento 2 project. Run before committing — reviews the current diff for database and PHP performance anti-patterns (N+1 queries, collections in loops, full-save misuse, missing indexes, EAV pitfalls) and verifies new SQL with EXPLAIN. Unblocks the pre-commit quality gate on pass.
---

# Magento 2 Performance Review

Reviews the working diff (staged + unstaged) of PHP/PHTML files and module
config XML (di.xml, events.xml, layout) for performance problems before they
are committed. Project-agnostic: works in any Magento 2 codebase. Use the
project's CLI wrapper (ddev/warden/docker exec) for every command that needs
PHP or MySQL.

## Scope

The gated file set is defined once, in `.claude/skills/magento-performance-review/scripts/perf-gate`:

```bash
.claude/skills/magento-performance-review/scripts/perf-gate files
git diff HEAD -- $(.claude/skills/magento-performance-review/scripts/perf-gate files)
```

Review only the changed hunks plus enough surrounding context to judge loops and
call frequency. New or changed plugins and observers in `etc/**/*.xml` are in
scope — check the class they wire in against the hot-path rules below. Frontend
assets (JS/CSS) are out of scope.

The review deliberately covers staged **and** unstaged changes: a partial
(staged-only) commit is still reviewed against the full working diff, so the
marker hash stays stable regardless of what is staged.

**Skip condition**: when `perf-gate files` prints nothing (docs, tests,
frontend assets only), there is nothing to review — state that and stop. The quality-gate hook does not block such
commits, so no marker is needed.

## Checklist — Database

1. **Queries in loops**: any `->load()`, repository `getById()/get()`,
   `fetchRow/fetchOne/fetchAll`, `getFirstItem()`, collection instantiation, or
   `addFieldToFilter` on a fresh/cloned collection inside `foreach`/`while`.
   Fix: batch-load before the loop or convert to one set-based query/join.
2. **Per-row lookups vs join**: PHP-side merging of two datasets that MySQL
   could join. Fix: join or `IN ()` batch.
3. **Full entity save for partial change**: `$product->save()` /
   `$repository->save()` to change one attribute fires every save observer,
   plugin and index invalidation. Fix: resource `saveAttribute()`,
   `updateAttributes()`, or a targeted resource-model update.
4. **New/changed SQL must be EXPLAINed**: build the query with realistic data
   and run `EXPLAIN`. Findings: `type=ALL` or `index` on a table that grows with
   catalog/order/customer size; `Using filesort`/`Using temporary` on large sets;
   joins on unindexed columns. Small config-like tables (< a few hundred rows)
   may scan.
5. **Unbounded collections and result sets**: collection loaded without page
   size / id filter on tables that grow (products, orders, quotes, customers,
   logs). Fix: filter, paginate, or iterate with
   `\Magento\Framework\Model\ResourceModel\Iterator`.
6. **Memory on big sets**: `fetchAll()`/`getItems()` materializing thousands of
   rows where `->query()` + `fetch()` streaming (or `insertFromSelect` staying
   inside MySQL) would do; large arrays accumulated across an export/indexer run
   without batching.
7. **`getSize()` vs `count()`**: `count()`/`getItems()` loads the collection;
   `getSize()` issues `COUNT(*)`. Use whichever avoids the unneeded load.
8. **EAV**: attribute values fetched per product instead of
   `addAttributeToSelect` on the collection; store-scope fallback joins done per
   row; hardcoded `attribute_id`/`entity_type_id` instead of a lookup.
9. **Tier price / index tables**: direct reads of `catalog_product_index_price`
   or `catalog_product_entity_tier_price` must filter by website/group/qty —
   full scans there hit the biggest tables in the shop.

## Checklist — PHP runtime

10. **Plugins/observers on hot paths**: new plugin or observer on product load,
    collection load, price calculation, cart/quote save, or layout generation.
    Everything there runs per product per request — no queries, no file I/O, no
    heavy object creation inside. Cache lookups in class properties.
11. **Work in constructors**: DI constructors must only assign dependencies.
    Queries/config reads in a constructor run even when the class is unused
    (proxy exceptions aside).
12. **Repeated config/attribute lookups**: `scopeConfig->getValue()`, attribute
    metadata, store resolution inside loops — hoist or memoize.
13. **ObjectManager runtime lookups** in loops; `create()` where `get()`
    (singleton) suffices.
14. **Serialization/JSON** of large structures per row; string building with
    repeated array_merge in loops (use `[] =` + single merge).

## Checklist — Caching & indexers

15. **Cache invalidation breadth**: does the change flush more than needed
    (full FPC vs tagged entities)? Does a frequent save now trigger reindex or
    cache cleaning per row?
16. **New cron/indexer load**: full rebuilds where a delta would do; missing
    batching on multi-thousand-row updates.

## Worked example

N+1 (🔴 on listing path):

```php
foreach ($collection as $product) {
    $full = $this->productRepository->getById($product->getId()); // full load per product
    $result[$product->getId()] = $full->getData('lead_time');
}
```

Set-based fix:

```php
$collection->addAttributeToSelect('lead_time'); // one join on the existing load
foreach ($collection as $product) {
    $result[$product->getId()] = $product->getData('lead_time');
}
```

## Procedure

1. Read the diff, apply the checklists to changed hunks.
2. For every new or modified SQL statement, obtain the real query and run
   `EXPLAIN` against the project database. Scratch-script template (place in a
   container-visible path, delete after):

   ```php
   <?php
   require __DIR__ . '/app/bootstrap.php';
   $bootstrap = \Magento\Framework\App\Bootstrap::create(BP, $_SERVER);
   $om = $bootstrap->getObjectManager();
   $om->get(\Magento\Framework\App\State::class)->setAreaCode('adminhtml');
   // build the changed select via its owning class or reconstruct it here
   $select = ...;
   echo $select . "\n\n";
   foreach ($om->get(\Magento\Framework\App\ResourceConnection::class)
       ->getConnection()->fetchAll('EXPLAIN ' . $select) as $row) {
       echo sprintf("table=%s type=%s key=%s rows=%s extra=%s\n",
           $row['table'], $row['type'], $row['key'] ?? '-', $row['rows'], $row['Extra'] ?? '');
   }
   ```
3. Time set-based operations that run on full catalog/order data when feasible
   (same scratch script, `microtime(true)` around the call).
4. Report findings:
   - 🔴 blocker — measurable regression on a hot path or growing table
   - 🟡 risk — works now, degrades with data growth
   - 🔵 nit — micro-optimization, optional
5. Blockers must be fixed (with approval) before commit. Risks: report, let the
   author decide.

## Unblocking the pre-commit gate

When the review is done (no blockers, or blockers fixed and re-reviewed),
create the marker the quality-gate hook checks — in its own Bash call, before
the commit (the hook runs before the command, so `perf-gate mark … && git commit` in
one call is always blocked):

```bash
.claude/skills/magento-performance-review/scripts/perf-gate mark perf
```

The hash covers the reviewed diff — any further code change invalidates the
marker and re-triggers the review on the next commit attempt.
