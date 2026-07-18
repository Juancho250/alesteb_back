# AURA 2070 migration order

These migrations replace the previous root-level AURA migrations. Apply only on a Neon branch or staging database first. Do not run on production until `scripts/aura_preflight.sql`, the full migration chain, and `scripts/aura_postflight.sql` have passed against a real PostgreSQL database.

## Final order

1. `001_aura_core_consolidated.sql`
2. `002_page_views_tenant_v2.sql`
3. `003_aura_campaigns_v2.sql`
4. `004_aura_image_jobs.sql`
5. `005_aura_actions_outbox_v2.sql`
6. `006_predictive_features.sql`
7. `007_predictive_forecasting.sql`
8. `008_aura_customer_growth.sql`
9. `009_aura_send_time_optimization.sql`
10. `010_aura_voice_mvp.sql`

## Feature flags that must stay off during migration

Keep these disabled while validating the full chain on a Neon branch:

- `ENABLE_LEGACY_AGENT_CRON=false`
- `AURA_IMAGE_WORKER_ENABLED=false`
- `AURA_PREDICTIVE_JOBS_ENABLED=false`
- `AURA_FORECAST_WORKER_ENABLED=false`
- `AURA_VOICE_ENABLED=false`

Keep the web service in maintenance mode, or at minimum ensure it receives no AURA traffic, during `001_aura_core_consolidated.sql` and any backfill step.

## Replaced migrations

Superseded by `001_aura_core_consolidated.sql`:

- `migrations/2026_07_12_aura_secure_mvp.sql`
- `migrations/2026_07_12_aura_mvp.sql`

Superseded by the v2 package:

- `migrations/2026_07_12_page_views_tenant.sql`
- `migrations/2026_07_12_aura_campaigns.sql`
- `migrations/2026_07_12_aura_image_jobs.sql`
- `migrations/2026_07_12_aura_actions_outbox.sql`
- `migrations/2026_07_12_predictive_features.sql`
- `migrations/2026_07_12_predictive_forecasting.sql`
- `migrations/2026_07_12_aura_customer_growth.sql`
- `migrations/2026_07_12_aura_send_time_optimization.sql`
- `migrations/2026_07_12_aura_voice_mvp.sql`

## Historical migrations not included

Do not add these to the AURA manifest if the real production schema already contains the listed columns/defaults:

- `migrations/2026_06_01_expenses_po_link.sql`
  - expected: `expenses.purchase_order_id`
- `migrations/2026_06_02_discount_scope.sql`
  - expected: `sales.discount_id`
  - expected: `discount_coupons.scope`
- `migrations/20260608_hybrid_default.sql`
  - expected: `products.fulfillment_mode DEFAULT 'hybrid'`

This workspace does not include a production dump, so those historical checks must be confirmed by `scripts/aura_preflight.sql` on a Neon branch.

## Dependency graph

- `001` depends on `users` and `agent_conversations`.
- `002` depends on `users`; optionally validates `api_keys` and `products` if present.
- `003` depends on `users`, `sales`, and `discounts`.
- `004` depends on `003`, `products`, and `product_variants`.
- `005` depends on `003` for campaign outbox links and preserves the existing transactional `notification_queue`.
- `006` depends on `users`, `products`, and `product_variants`.
- `007` depends on `004` and `006`.
- `008` depends on `users` and `products`.
- `009` depends on `003`.
- `010` depends on `users`, `aura_runs`, and `agent_conversations`.

## Notification queue strategy

The production table already has enum columns and transactional references. The v2 migration keeps the existing enum-based design and extends enum values with `ALTER TYPE ADD VALUE IF NOT EXISTS` when the enums exist. It keeps `reference_id` as integer to preserve legacy transactional references and adds `reference_key` for future extensible string references.

The claim index is `idx_notification_queue_claim` on `(available_at, scheduled_for, created_at, id)` with the constant predicate `status = 'pending'`. Time eligibility (`available_at <= NOW()` and `scheduled_for <= NOW()`) and retry eligibility (`attempts < max_attempts`) are evaluated by the worker query. PostgreSQL does not allow temporal functions in an index predicate, and enum-to-text casts are not immutable either.

## Staging validation incident: 2026-07-15

The first real run on the Neon `aura-staging` branch reached this state:

- `001` through `004`: committed successfully.
- `005`: rolled back completely by its transaction after PostgreSQL rejected `status::text` in the partial claim index predicate with `functions in index predicate must be marked IMMUTABLE`.
- `006` through `010`: not executed.

Migration `005` was corrected in place because it was not applied. No patch migration and no manual rollback of `001` through `004` are required. The preflight now reports a contiguous applied prefix separately from partial or out-of-order structures.

After this correction, restart the complete runner from `001` on the same staging branch. Migrations `001` through `004` are designed to be idempotent, `005` starts from its rolled-back state, and `006` through `010` continue in their normal order. Keep every worker and AURA feature flag disabled during the run.

This package is still not approved for production. It must pass the complete staging run, postflight, a second idempotency run, and tenant isolation checks first.

## Job dedupe alignment

Image and forecasting job dedupe is active-only for `queued` and `running`. Completed, failed, and cancelled jobs do not block legitimate future jobs. Explicit cache reuse remains separate from active dedupe.

## Commands for Neon branch

Set a branch database URL, never the production primary URL:

```bash
export NEON_AURA_BRANCH_URL="postgresql://..."
```

Run preflight:

```bash
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f scripts/aura_preflight.sql
```

Apply in order:

```bash
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/001_aura_core_consolidated.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/002_page_views_tenant_v2.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/003_aura_campaigns_v2.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/004_aura_image_jobs.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/005_aura_actions_outbox_v2.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/006_predictive_features.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/007_predictive_forecasting.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/008_aura_customer_growth.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/009_aura_send_time_optimization.sql
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f migrations/aura/010_aura_voice_mvp.sql
```

Run postflight:

```bash
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f scripts/aura_postflight.sql
```

Run the same chain a second time on the branch to test idempotency. Do not do this first on production.
