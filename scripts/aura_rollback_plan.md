# AURA 2070 consolidated migrations rollback plan

This plan is documentation only. Do not paste it into production. Prefer feature flags and Render deploy rollback before schema rollback.

## First response

1. Stop feature rollout.
2. Disable AURA feature flags:
   - `AURA_VOICE_ENABLED=false`
   - `AURA_IMAGE_WORKER_ENABLED=false`
   - `ENABLE_LEGACY_AGENT_CRON=false`
3. Stop `start:worker:ai` if image jobs are involved.
4. Keep webhooks online if notifications were already sent.
5. Preserve logs, `aura_runs`, `aura_actions`, `ai_jobs`, campaign ids and notification ids.

## Code rollback

Use Render's previous deploy for the web service or affected worker. Then run:

```bash
curl -i https://YOUR_DOMAIN/api/health
```

Run a minimal authenticated smoke test for `/api/aura/chat` and `/api/agent/confirm`.

## Database rollback policy

Do not drop AURA tables from production unless:

- a backup was taken after incident triage;
- the tables are confirmed unused or exported;
- the rollback was rehearsed on a Neon branch;
- dependent FKs are known.

The safest production rollback is usually:

- leave schema in place;
- disable flags;
- reject or expire pending `aura_actions`;
- pause campaigns;
- stop workers affected by the incident.

## Reverse dependency order

If a Neon branch test proves a destructive rollback is required, reverse order is:

1. `010_aura_voice_mvp.sql`
2. `009_aura_send_time_optimization.sql`
3. `008_aura_customer_growth.sql`
4. `007_predictive_forecasting.sql`
5. `006_predictive_features.sql`
6. `005_aura_actions_outbox_v2.sql`
7. `004_aura_image_jobs.sql`
8. `003_aura_campaigns_v2.sql`
9. `002_page_views_tenant_v2.sql`
10. `001_aura_core_consolidated.sql`

## Manual branch rollback skeleton

Use only on a test branch after exporting data:

```sql
BEGIN;
-- Drop dependent AURA objects in reverse order only after inspecting FKs.
-- Do not run this skeleton in production.
ROLLBACK;
```

## Data-preserving mitigations

### AURA textual

- Remove `OPENAI_API_KEY` or disable `has_ai_agent` for affected plans.
- Keep `aura_runs` for audit.

### Campaign sends

- Stop worker general if needed.
- Set campaigns to paused/cancelled through approved admin flow.
- Reject pending `aura_actions`.

### Images

- Stop AI worker.
- Leave `campaign_assets` rows and Cloudinary assets for audit.
- Delete generated assets only through the safe tenant-aware deletion path.

### Predictive

- Stop recalculation jobs.
- Leave historical `prediction_results`.

### Voice

- Disable flag.
- Let sessions expire.
- Audio is metadata-only and not stored.

## Verification after rollback

Run:

```bash
psql "$NEON_AURA_BRANCH_URL" -X -v ON_ERROR_STOP=1 -f scripts/aura_postflight.sql
npm test
```

If production was touched, also verify:

- no duplicate workers;
- no pending dangerous actions;
- no `notification_queue` rows unexpectedly stuck in `sending`;
- no tenant A/B leakage in a targeted smoke test.

