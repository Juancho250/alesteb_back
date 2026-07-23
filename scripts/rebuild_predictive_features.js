#!/usr/bin/env node
'use strict';

require('dotenv/config');
require('../config/env')();

const db = require('../src/platform/database');
const predictive = require('../src/modules/aura/predictive/features.service');

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  const tenant = Number(arg('tenant'));
  const from = arg('from');
  const to = arg('to');
  const user = arg('user') ? Number(arg('user')) : null;

  if (!tenant || !from || !to) {
    console.error('Uso: node scripts/rebuild_predictive_features.js --tenant=101 --from=2026-07-01 --to=2026-07-14 [--user=1]');
    process.exitCode = 1;
    return;
  }

  const result = await predictive.rebuildPredictiveFeatures({
    ownerAdminId: tenant,
    dateFrom: from,
    dateTo: to,
    userId: user,
    runType: 'feature_backfill',
  });
  console.log(JSON.stringify({ success: true, data: result }, null, 2));
}

main()
  .catch((err) => {
    console.error(JSON.stringify({
      success: false,
      code: err.code || 'AURA_PREDICTIVE_REBUILD_FAILED',
      message: err.message,
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end().catch(() => {});
  });
