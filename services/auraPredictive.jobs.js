'use strict';

const cron = require('node-cron');
const { runDailyPredictiveFeatureJob } = require('./auraPredictiveFeatures.service');
const { processForecastJobs, recoverStaleForecastJobs } = require('./auraForecasting.service');

const health = {
  dailyFeatures: { enabled: false, running: false, lastCompletedAt: null, lastErrorCode: null },
  forecast: { enabled: false, running: false, lastCompletedAt: null, lastErrorCode: null },
};

function predictiveJobsEnabled() {
  return String(process.env.AURA_PREDICTIVE_JOBS_ENABLED || 'false').toLowerCase() === 'true';
}

function predictiveSchedule() {
  return process.env.AURA_PREDICTIVE_DAILY_CRON || '20 2 * * *';
}

function forecastWorkerEnabled() {
  return String(process.env.AURA_FORECAST_WORKER_ENABLED || 'false').toLowerCase() === 'true';
}

function forecastWorkerSchedule() {
  return process.env.AURA_FORECAST_WORKER_CRON || '*/5 * * * *';
}

function forecastWorkerBatchSize() {
  const parsed = Number.parseInt(process.env.AURA_FORECAST_WORKER_BATCH || '5', 10);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), 25) : 5;
}

function startAuraPredictiveJobs() {
  const tasks = {};

  if (predictiveJobsEnabled()) {
    health.dailyFeatures.enabled = true;
    const schedule = predictiveSchedule();
    tasks.dailyFeatures = cron.schedule(schedule, async () => {
      const started = Date.now();
      health.dailyFeatures.running = true;
      try {
        const result = await runDailyPredictiveFeatureJob();
        health.dailyFeatures.lastCompletedAt = new Date().toISOString();
        health.dailyFeatures.lastErrorCode = null;
        console.log(JSON.stringify({
          level: 'info',
          event: 'aura_predictive_daily_completed',
          featureDate: result.featureDate,
          tenants: result.tenants,
          durationMs: Date.now() - started,
        }));
      } catch (err) {
        health.dailyFeatures.lastErrorCode = String(err.code || 'AURA_PREDICTIVE_JOB_ERROR').slice(0, 80);
        console.error(JSON.stringify({
          level: 'error',
          event: 'aura_predictive_daily_failed',
          code: err.code || 'AURA_PREDICTIVE_JOB_ERROR',
          durationMs: Date.now() - started,
        }));
      } finally {
        health.dailyFeatures.running = false;
      }
    }, { noOverlap: true });

    console.log(`[aura-predictive] daily feature job iniciado (${schedule})`);
  } else {
    console.log('[aura-predictive] daily feature job desactivado');
  }

  if (forecastWorkerEnabled()) {
    health.forecast.enabled = true;
    const schedule = forecastWorkerSchedule();
    tasks.forecastWorker = cron.schedule(schedule, async () => {
      const started = Date.now();
      health.forecast.running = true;
      try {
        const recovery = await recoverStaleForecastJobs();
        const result = await processForecastJobs(forecastWorkerBatchSize());
        health.forecast.lastCompletedAt = new Date().toISOString();
        health.forecast.lastErrorCode = null;
        if (result.processed > 0) {
          console.log(JSON.stringify({
            level: 'info',
            event: 'aura_forecast_jobs_processed',
            processed: result.processed,
            recovered: recovery.recovered,
            durationMs: Date.now() - started,
          }));
        }
      } catch (err) {
        health.forecast.lastErrorCode = String(err.code || 'AURA_FORECAST_WORKER_ERROR').slice(0, 80);
        console.error(JSON.stringify({
          level: 'error',
          event: 'aura_forecast_jobs_failed',
          code: err.code || 'AURA_FORECAST_WORKER_ERROR',
          durationMs: Date.now() - started,
        }));
      } finally {
        health.forecast.running = false;
      }
    }, { noOverlap: true });

    console.log(`[aura-predictive] forecast worker iniciado (${schedule})`);
  } else {
    console.log('[aura-predictive] forecast worker desactivado');
  }

  return {
    enabled: Object.keys(tasks).length > 0,
    tasks,
    getHealth() {
      return JSON.parse(JSON.stringify(health));
    },
    stop() {
      for (const task of Object.values(tasks)) task.stop();
      health.dailyFeatures.enabled = false;
      health.forecast.enabled = false;
    },
  };
}

module.exports = {
  startAuraPredictiveJobs,
  predictiveJobsEnabled,
  predictiveSchedule,
  forecastWorkerEnabled,
  forecastWorkerSchedule,
  forecastWorkerBatchSize,
};
