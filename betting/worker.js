"use strict";

const {
  reconcileBettingTransactions,
} = require("./reconciliation");

const INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.BETTING_RECONCILIATION_INTERVAL_MS || 60_000)
);

const BATCH_SIZE = Math.max(
  1,
  Number(process.env.BETTING_RECONCILIATION_BATCH_SIZE || 25)
);

let workerTimer = null;
let running = false;

async function runBettingReconciliationOnce() {
  if (running) {
    console.log("[BETTING WORKER] Previous reconciliation run is still running.");
    return;
  }

  running = true;

  try {
    const result = await reconcileBettingTransactions({
      batchSize: BATCH_SIZE,
    });

    console.log("[BETTING WORKER] Reconciliation completed.", {
      processed: result?.processed ?? 0,
      succeeded: result?.succeeded ?? 0,
      failed: result?.failed ?? 0,
      pending: result?.pending ?? 0,
      skipped: result?.skipped ?? 0,
    });

    return result;
  } catch (error) {
    console.error("[BETTING WORKER] Reconciliation run failed.", {
      message: error?.message || "Unknown error",
    });

    return null;
  } finally {
    running = false;
  }
}

function startBettingReconciliationWorker() {
  if (workerTimer) {
    return workerTimer;
  }

  console.log("[BETTING WORKER] Starting reconciliation worker.", {
    intervalMs: INTERVAL_MS,
    batchSize: BATCH_SIZE,
  });

  workerTimer = setInterval(() => {
    runBettingReconciliationOnce().catch((error) => {
      console.error("[BETTING WORKER] Unexpected worker error.", {
        message: error?.message || "Unknown error",
      });
    });
  }, INTERVAL_MS);

  if (typeof workerTimer.unref === "function") {
    workerTimer.unref();
  }

  setTimeout(() => {
    runBettingReconciliationOnce().catch((error) => {
      console.error("[BETTING WORKER] Initial reconciliation error.", {
        message: error?.message || "Unknown error",
      });
    });
  }, 5_000);

  return workerTimer;
}

function stopBettingReconciliationWorker() {
  if (!workerTimer) {
    return;
  }

  clearInterval(workerTimer);
  workerTimer = null;

  console.log("[BETTING WORKER] Reconciliation worker stopped.");
}

module.exports = {
  runBettingReconciliationOnce,
  startBettingReconciliationWorker,
  stopBettingReconciliationWorker,
};