const imageJobs = require("./auraImageJobs.service");

const DEFAULT_POLL_MS = 5_000;
const state = {
  enabled: false,
  running: false,
  workerId: null,
  startedAt: null,
  lastTickAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  processed: 0,
  staleRecovered: 0,
};

function isAuraImageWorkerEnabled() {
  return String(process.env.AURA_IMAGE_WORKER_ENABLED || "false").toLowerCase() === "true";
}

function pollIntervalMs() {
  const parsed = Number.parseInt(process.env.AURA_IMAGE_WORKER_POLL_MS || String(DEFAULT_POLL_MS), 10);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_POLL_MS;
  return Math.min(Math.max(parsed, 1_000), 60_000);
}

function workerId() {
  const host = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || "local";
  return `aura-image-worker:${process.pid}:${host}`;
}

function redactedError(err) {
  return {
    code: String(err.code || "AURA_IMAGE_JOB_FAILED").slice(0, 80),
    message: err.status && err.status < 500
      ? String(err.message || "Solicitud de imagen rechazada").slice(0, 500)
      : "No fue posible procesar la imagen con el proveedor externo.",
  };
}

async function processOneImageJob(id = workerId(), claimScope = {}) {
  const job = await imageJobs.claimNextImageJob({
    workerId: id,
    ownerAdminId: claimScope.ownerAdminId,
    jobId: claimScope.jobId,
  });
  if (!job) return { processed: false };

  try {
    const result = await imageJobs.processImageJob(job);
    console.log(JSON.stringify({
      level: "info",
      event: "aura_image_job_completed",
      jobId: job.id,
      ownerAdminId: job.ownerAdminId,
      assetId: job.input?.assetId || null,
    }));
    return { processed: true, jobId: job.id, result };
  } catch (err) {
    const safe = redactedError(err);
    await imageJobs.markAssetFailed({
      ownerAdminId: job.ownerAdminId,
      assetId: job.input?.assetId,
      code: safe.code,
      message: safe.message,
    }).catch(() => {});
    const updated = await imageJobs.markJobFailed({
      jobId: job.id,
      ownerAdminId: job.ownerAdminId,
      attempts: job.attempts,
      maxAttempts: err.status && err.status < 500 ? job.attempts : job.maxAttempts,
      errorCode: safe.code,
      errorMessageRedacted: safe.message,
    });
    console.warn(JSON.stringify({
      level: "warn",
      event: "aura_image_job_failed",
      jobId: job.id,
      ownerAdminId: job.ownerAdminId,
      status: updated?.status || "unknown",
      code: safe.code,
    }));
    return { processed: true, jobId: job.id, error: safe };
  }
}

function startAuraImageWorker() {
  if (!isAuraImageWorkerEnabled()) {
    console.log(JSON.stringify({
      level: "info",
      event: "aura_image_worker_disabled",
      enabled: false,
    }));
    state.enabled = false;
    return { enabled: false, stop() {}, getHealth: getAuraImageWorkerHealth };
  }

  const id = workerId();
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    state.running = true;
    state.lastTickAt = new Date().toISOString();
    try {
      const staleMinutes = Number.parseInt(process.env.AURA_IMAGE_STALE_JOB_MINUTES || "15", 10);
      const recovered = await imageJobs.recoverStaleImageJobs({ staleMinutes });
      state.staleRecovered += Number(recovered.recovered || 0);
      const result = await processOneImageJob(id);
      if (result.processed) state.processed += 1;
      state.lastSuccessAt = new Date().toISOString();
      state.lastErrorCode = null;
    } catch (err) {
      state.lastErrorCode = err.code || "AURA_IMAGE_WORKER_ERROR";
      console.error(JSON.stringify({
        level: "error",
        event: "aura_image_worker_tick_failed",
        code: err.code || "AURA_IMAGE_WORKER_ERROR",
      }));
    } finally {
      running = false;
      state.running = false;
    }
  }

  const interval = setInterval(tick, pollIntervalMs());
  state.enabled = true;
  state.workerId = id;
  state.startedAt = new Date().toISOString();
  tick();

  console.log(JSON.stringify({
    level: "info",
    event: "aura_image_worker_started",
    workerId: id,
    pollMs: pollIntervalMs(),
  }));

  return {
    enabled: true,
    workerId: id,
    stop() {
      stopped = true;
      clearInterval(interval);
      state.enabled = false;
    },
    getHealth: getAuraImageWorkerHealth,
  };
}

function getAuraImageWorkerHealth() {
  return { ...state };
}

module.exports = {
  isAuraImageWorkerEnabled,
  pollIntervalMs,
  workerId,
  processOneImageJob,
  startAuraImageWorker,
  getAuraImageWorkerHealth,
};
