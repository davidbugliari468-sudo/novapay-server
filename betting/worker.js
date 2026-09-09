"use strict";

const {
  reconcileBettingTransactions,
} = require("./reconciliation");

function readPositiveIntegerEnv(
  name,
  fallback,
  minimum
) {
  const rawValue = process.env[name];

  if (
    rawValue === undefined ||
    rawValue === null ||
    String(rawValue).trim() === ""
  ) {
    return fallback;
  }

  const parsed = Number(rawValue);

  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < minimum
  ) {
    console.warn(
      "[BETTING WORKER] Invalid configuration value. Using default.",
      {
        name,
        minimum,
        fallback,
      }
    );

    return fallback;
  }

  return parsed;
}

const INTERVAL_MS =
  readPositiveIntegerEnv(
    "BETTING_RECONCILIATION_INTERVAL_MS",
    60_000,
    10_000
  );

const BATCH_SIZE =
  readPositiveIntegerEnv(
    "BETTING_RECONCILIATION_BATCH_SIZE",
    25,
    1
  );

const INITIAL_DELAY_MS = 5_000;

let workerTimer = null;
let initialTimer = null;
let running = false;
let stopping = false;

async function runBettingReconciliationOnce() {
  if (running) {
    console.log(
      "[BETTING WORKER] Previous reconciliation run is still running."
    );

    return null;
  }

  running = true;

  try {
    const result =
      await reconcileBettingTransactions({
        batchSize: BATCH_SIZE,
      });

    console.log(
      "[BETTING WORKER] Reconciliation completed.",
      {
        processed:
          Number(result?.processed) || 0,

        succeeded:
          Number(result?.succeeded) || 0,

        failed:
          Number(result?.failed) || 0,

        pending:
          Number(result?.pending) || 0,

        skipped:
          Number(result?.skipped) || 0,
      }
    );

    return result;
  } catch (error) {
    console.error(
      "[BETTING WORKER] Reconciliation run failed.",
      {
        kind:
          error?.kind ||
          "unknown",

        message:
          error?.message ||
          "Unknown error",
      }
    );

    return null;
  } finally {
    running = false;
  }
}

function scheduleInitialReconciliation() {
  if (initialTimer) {
    return;
  }

  initialTimer = setTimeout(() => {
    initialTimer = null;

    if (
      !workerTimer ||
      stopping
    ) {
      return;
    }

    runBettingReconciliationOnce().catch(
      (error) => {
        console.error(
          "[BETTING WORKER] Unexpected initial reconciliation error.",
          {
            message:
              error?.message ||
              "Unknown error",
          }
        );
      }
    );
  }, INITIAL_DELAY_MS);

  if (
    initialTimer &&
    typeof initialTimer.unref === "function"
  ) {
    initialTimer.unref();
  }
}

function startBettingReconciliationWorker() {
  if (workerTimer) {
    console.log(
      "[BETTING WORKER] Reconciliation worker is already running."
    );

    return workerTimer;
  }

  stopping = false;

  console.log(
    "[BETTING WORKER] Starting reconciliation worker.",
    {
      intervalMs: INTERVAL_MS,
      batchSize: BATCH_SIZE,
      initialDelayMs: INITIAL_DELAY_MS,
    }
  );

  workerTimer = setInterval(() => {
    if (stopping) {
      return;
    }

    runBettingReconciliationOnce().catch(
      (error) => {
        console.error(
          "[BETTING WORKER] Unexpected worker error.",
          {
            message:
              error?.message ||
              "Unknown error",
          }
        );
      }
    );
  }, INTERVAL_MS);

  if (
    workerTimer &&
    typeof workerTimer.unref === "function"
  ) {
    workerTimer.unref();
  }

  scheduleInitialReconciliation();

  return workerTimer;
}

function stopBettingReconciliationWorker() {
  stopping = true;

  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }

  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }

  console.log(
    "[BETTING WORKER] Reconciliation worker stopped."
  );
}

module.exports = {
  runBettingReconciliationOnce,
  startBettingReconciliationWorker,
  stopBettingReconciliationWorker,
};