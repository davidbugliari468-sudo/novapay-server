"use strict";

const {
  findTransactionsRequiringReconciliation,
  reconcileElectricityTransaction,
} = require("./reconciliation");

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;

function normalizeLimit(limit) {
  const value = Number(limit);

  if (
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.min(
    value,
    MAX_BATCH_SIZE
  );
}

async function runReconciliationBatch({
  limit = DEFAULT_BATCH_SIZE,
} = {}) {
  const safeLimit =
    normalizeLimit(limit);

  const transactions =
    await findTransactionsRequiringReconciliation({
      limit: safeLimit,
    });

  const results = [];
  const errors = [];

  for (const transaction of transactions) {
    try {
      const result =
        await reconcileElectricityTransaction({
          transactionId:
            transaction.id,
        });

      results.push({
        transactionId:
          transaction.id,

        result,
      });
    } catch (error) {
      errors.push({
        transactionId:
          transaction.id,

        error:
          error?.message ||
          "Electricity reconciliation failed.",
      });
    }
  }

  return {
    scanned:
      transactions.length,

    processed:
      results.length,

    failed:
      errors.length,

    results,

    errors,
  };
}

async function runSingleReconciliation({
  transactionId,
} = {}) {
  if (
    !transactionId ||
    typeof transactionId !==
      "string"
  ) {
    throw new Error(
      "transactionId is required."
    );
  }

  return reconcileElectricityTransaction({
    transactionId,
  });
}

function getWorkerInfo() {
  return {
    service:
      "electricity",

    worker:
      "reconciliation",

    enabled:
      true,

    defaultBatchSize:
      DEFAULT_BATCH_SIZE,

    maxBatchSize:
      MAX_BATCH_SIZE,
  };
}

module.exports = {
  runReconciliationBatch,
  runSingleReconciliation,
  getWorkerInfo,
};