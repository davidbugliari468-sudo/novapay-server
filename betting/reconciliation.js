"use strict";

const { db } = require("../firebase-admin");

const {
  getReservation,
  commitReservation,
  releaseReservation,
} = require("../wallet/reservation");

const {
  requeryBetting,
} = require("./vtu");

const {
  STATUS_PENDING,
  STATUS_SUCCESSFUL,
  STATUS_FAILED,
} = require("./service");

const bettingTransactionsRef =
  db.collection("bettingTransactions");

const DEFAULT_BATCH_SIZE = Math.max(
  1,
  Number(process.env.BETTING_RECONCILIATION_BATCH_SIZE || 25)
);

const DEFAULT_BACKOFF_MINUTES = Math.max(
  1,
  Number(process.env.BETTING_RECONCILIATION_BACKOFF_MINUTES || 5)
);

const MAX_RECONCILIATION_ATTEMPTS = Math.max(
  1,
  Number(
    process.env.BETTING_MAX_RECONCILIATION_ATTEMPTS || 20
  )
);

function now() {
  return new Date();
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error) {
  return normalizeString(error?.message) || "Unknown error";
}

function calculateNextRetry(attempts) {
  const safeAttempts = Math.max(
    1,
    Number(attempts) || 1
  );

  const multiplier = Math.min(
    safeAttempts,
    12
  );

  const delayMinutes =
    DEFAULT_BACKOFF_MINUTES *
    Math.pow(2, multiplier - 1);

  const cappedDelayMinutes = Math.min(
    delayMinutes,
    24 * 60
  );

  return new Date(
    Date.now() +
      cappedDelayMinutes * 60 * 1000
  );
}

function isRetryDue(transaction) {
  if (!transaction?.nextReconciliationAt) {
    return true;
  }

  const next =
    transaction.nextReconciliationAt instanceof Date
      ? transaction.nextReconciliationAt
      : new Date(
          transaction.nextReconciliationAt
        );

  if (Number.isNaN(next.getTime())) {
    return true;
  }

  return next.getTime() <= Date.now();
}

async function updateTransaction(
  transactionId,
  updates
) {
  await bettingTransactionsRef
    .doc(transactionId)
    .update({
      ...updates,
      updatedAt: now(),
    });
}

function normalizeProviderResult(result) {
  if (!result || typeof result !== "object") {
    return {
      outcome: "unknown",
      providerReference: "",
      providerRequestId: "",
      providerStatus: "",
      providerCode: "",
      message: "",
    };
  }

  return {
    outcome:
      result.outcome === "success"
        ? "success"
        : result.outcome === "failure"
        ? "failure"
        : "unknown",

    providerReference:
      normalizeString(
        result.providerReference
      ),

    providerRequestId:
      normalizeString(
        result.providerRequestId
      ),

    providerStatus:
      normalizeString(
        result.providerStatus
      ),

    providerCode:
      normalizeString(
        result.providerCode
      ),

    message:
      normalizeString(
        result.message
      ),
  };
}

async function reconcileTransaction(
  transaction
) {
  const transactionId =
    normalizeString(transaction?.id);

  if (!transactionId) {
    throw new Error(
      "Betting reconciliation transaction ID is missing"
    );
  }

  const uid =
    normalizeString(transaction?.uid);

  if (!uid) {
    throw new Error(
      "Betting reconciliation user ID is missing"
    );
  }

  const reservationId =
    normalizeString(
      transaction?.reservationId
    );

  if (!reservationId) {
    await updateTransaction(
      transactionId,
      {
        status: STATUS_PENDING,
        reconciliationRequired: true,
        reconciliationError:
          "Transaction has no reservation",
        nextReconciliationAt:
          calculateNextRetry(1),
      }
    );

    return {
      transactionId,
      outcome: "unknown",
      reason: "missing_reservation",
    };
  }

  const reservation =
    await getReservation(
      reservationId
    );

  if (!reservation) {
    await updateTransaction(
      transactionId,
      {
        status: STATUS_PENDING,
        reconciliationRequired: true,
        reconciliationError:
          "Reservation could not be found",
        nextReconciliationAt:
          calculateNextRetry(1),
      }
    );

    return {
      transactionId,
      outcome: "unknown",
      reason: "reservation_not_found",
    };
  }

  if (reservation.uid !== uid) {
    throw new Error(
      "Betting reservation ownership mismatch"
    );
  }

  /*
   * If another process already committed the
   * reservation, the financial result is known.
   */
  if (
    reservation.status === "committed"
  ) {
    await updateTransaction(
      transactionId,
      {
        status: STATUS_SUCCESSFUL,
        providerOutcome: "success",
        reconciliationRequired: false,
        reconciliationError: "",
        nextReconciliationAt: null,
      }
    );

    return {
      transactionId,
      outcome: "success",
      reason: "reservation_already_committed",
    };
  }

  /*
   * If another process already released the
   * reservation, the financial result is known.
   */
  if (
    reservation.status === "released"
  ) {
    await updateTransaction(
      transactionId,
      {
        status: STATUS_FAILED,
        providerOutcome: "failure",
        reconciliationRequired: false,
        reconciliationError: "",
        nextReconciliationAt: null,
        failureReason:
          transaction.failureReason ||
          "Betting transaction failed",
      }
    );

    return {
      transactionId,
      outcome: "failure",
      reason: "reservation_already_released",
    };
  }

  /*
   * IMPORTANT:
   * This is a REQUERY only.
   * It never calls the original betting purchase
   * endpoint.
   */
  let providerResult;

  try {
    providerResult =
      await requeryBetting(
        transactionId
      );
  } catch (error) {
    const attempts =
      Number(
        transaction.reconciliationAttempts
      ) || 0;

    const nextAttempts =
      attempts + 1;

    const permanentlyWaiting =
      nextAttempts >=
      MAX_RECONCILIATION_ATTEMPTS;

    await updateTransaction(
      transactionId,
      {
        status: STATUS_PENDING,
        providerOutcome: "unknown",
        reconciliationRequired: true,
        reconciliationAttempts:
          nextAttempts,
        reconciliationError:
          getErrorMessage(error),
        nextReconciliationAt:
          permanentlyWaiting
            ? null
            : calculateNextRetry(
                nextAttempts
              ),
      }
    );

    return {
      transactionId,
      outcome: "unknown",
      reason: "requery_error",
      attempts: nextAttempts,
    };
  }

  const normalized =
    normalizeProviderResult(
      providerResult
    );

  /*
   * DEFINITE SUCCESS
   *
   * Commit the reservation only after
   * VTU.ng gives us a definite success.
   */
  if (
    normalized.outcome === "success"
  ) {
    try {
      await commitReservation({
        uid,
        reservationId,
      });
    } catch (error) {
      /*
       * Provider says success but our wallet
       * commit failed. Do NOT release funds.
       * Keep the reservation locked and retry
       * reconciliation.
       */
      const attempts =
        Number(
          transaction.reconciliationAttempts
        ) || 0;

      const nextAttempts =
        attempts + 1;

      await updateTransaction(
        transactionId,
        {
          status: STATUS_PENDING,

          providerReference:
            normalized.providerReference,

          providerRequestId:
            normalized.providerRequestId,

          providerStatus:
            normalized.providerStatus,

          providerCode:
            normalized.providerCode,

          providerMessage:
            normalized.message,

          providerOutcome: "success",

          reconciliationRequired: true,

          reconciliationAttempts:
            nextAttempts,

          reconciliationError:
            `Provider succeeded but reservation commit failed: ${getErrorMessage(
              error
            )}`,

          nextReconciliationAt:
            calculateNextRetry(
              nextAttempts
            ),
        }
      );

      return {
        transactionId,
        outcome: "unknown",
        reason: "commit_failed",
        attempts: nextAttempts,
      };
    }

    await updateTransaction(
      transactionId,
      {
        status: STATUS_SUCCESSFUL,

        providerReference:
          normalized.providerReference,

        providerRequestId:
          normalized.providerRequestId,

        providerStatus:
          normalized.providerStatus,

        providerCode:
          normalized.providerCode,

        providerMessage:
          normalized.message,

        providerOutcome: "success",

        reconciliationRequired: false,

        reconciliationAttempts:
          Number(
            transaction.reconciliationAttempts
          ) || 0,

        reconciliationError: "",

        nextReconciliationAt: null,
      }
    );

    return {
      transactionId,
      outcome: "success",
      reason: "provider_confirmed_success",
    };
  }

  /*
   * DEFINITE FAILURE
   *
   * Release the reservation only after
   * VTU.ng gives us a definite failure.
   */
  if (
    normalized.outcome === "failure"
  ) {
    try {
      await releaseReservation({
        uid,
        reservationId,
      });
    } catch (error) {
      /*
       * If release fails, DO NOT mark the
       * transaction as successfully failed.
       *
       * The wallet reservation must remain
       * protected until release succeeds.
       */
      const attempts =
        Number(
          transaction.reconciliationAttempts
        ) || 0;

      const nextAttempts =
        attempts + 1;

      await updateTransaction(
        transactionId,
        {
          status: STATUS_PENDING,

          providerReference:
            normalized.providerReference,

          providerRequestId:
            normalized.providerRequestId,

          providerStatus:
            normalized.providerStatus,

          providerCode:
            normalized.providerCode,

          providerMessage:
            normalized.message,

          providerOutcome: "failure",

          reconciliationRequired: true,

          reconciliationAttempts:
            nextAttempts,

          reconciliationError:
            `Provider failed but reservation release failed: ${getErrorMessage(
              error
            )}`,

          nextReconciliationAt:
            calculateNextRetry(
              nextAttempts
            ),
        }
      );

      return {
        transactionId,
        outcome: "unknown",
        reason: "release_failed",
        attempts: nextAttempts,
      };
    }

    await updateTransaction(
      transactionId,
      {
        status: STATUS_FAILED,

        providerReference:
          normalized.providerReference,

        providerRequestId:
          normalized.providerRequestId,

        providerStatus:
          normalized.providerStatus,

        providerCode:
          normalized.providerCode,

        providerMessage:
          normalized.message,

        providerOutcome: "failure",

        failureReason:
          normalized.message ||
          "Betting account funding failed",

        reconciliationRequired: false,

        reconciliationAttempts:
          Number(
            transaction.reconciliationAttempts
          ) || 0,

        reconciliationError: "",

        nextReconciliationAt: null,
      }
    );

    return {
      transactionId,
      outcome: "failure",
      reason: "provider_confirmed_failure",
    };
  }

  /*
   * UNKNOWN / PROCESSING / AMBIGUOUS
   *
   * NEVER release the reservation here.
   */
  const attempts =
    Number(
      transaction.reconciliationAttempts
    ) || 0;

  const nextAttempts =
    attempts + 1;

  const permanentlyWaiting =
    nextAttempts >=
    MAX_RECONCILIATION_ATTEMPTS;

  await updateTransaction(
    transactionId,
    {
      status: STATUS_PENDING,

      providerReference:
        normalized.providerReference,

      providerRequestId:
        normalized.providerRequestId,

      providerStatus:
        normalized.providerStatus,

      providerCode:
        normalized.providerCode,

      providerMessage:
        normalized.message,

      providerOutcome: "unknown",

      reconciliationRequired: true,

      reconciliationAttempts:
        nextAttempts,

      reconciliationError: "",

      nextReconciliationAt:
        permanentlyWaiting
          ? null
          : calculateNextRetry(
              nextAttempts
            ),
    }
  );

  return {
    transactionId,
    outcome: "unknown",
    reason: permanentlyWaiting
      ? "maximum_attempts_reached"
      : "provider_result_still_unknown",
    attempts: nextAttempts,
  };
}

async function reconcileBettingTransactions({
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const safeBatchSize = Math.max(
    1,
    Math.min(
      Number(batchSize) || DEFAULT_BATCH_SIZE,
      100
    )
  );

  const snapshot =
    await bettingTransactionsRef
      .where(
        "status",
        "==",
        STATUS_PENDING
      )
      .where(
        "reconciliationRequired",
        "==",
        true
      )
      .limit(safeBatchSize)
      .get();

  if (snapshot.empty) {
    return {
      scanned: 0,
      success: 0,
      failed: 0,
      pending: 0,
      errors: 0,
    };
  }

  const results = {
    scanned: 0,
    success: 0,
    failed: 0,
    pending: 0,
    errors: 0,
  };

  for (const document of snapshot.docs) {
    const transaction =
      document.data();

    if (!isRetryDue(transaction)) {
      continue;
    }

    results.scanned += 1;

    /*
     * Mark this reconciliation attempt as
     * being processed before querying.
     *
     * This is not a financial state change.
     */
    try {
      await updateTransaction(
        transaction.id,
        {
          reconciliationStartedAt:
            now(),
        }
      );

      const result =
        await reconcileTransaction(
          transaction
        );

      if (
        result.outcome === "success"
      ) {
        results.success += 1;
      } else if (
        result.outcome === "failure"
      ) {
        results.failed += 1;
      } else {
        results.pending += 1;
      }
    } catch (error) {
      results.errors += 1;

      const attempts =
        Number(
          transaction.reconciliationAttempts
        ) || 0;

      const nextAttempts =
        attempts + 1;

      try {
        await updateTransaction(
          transaction.id,
          {
            status: STATUS_PENDING,
            reconciliationRequired: true,
            reconciliationAttempts:
              nextAttempts,
            reconciliationError:
              getErrorMessage(error),
            nextReconciliationAt:
              calculateNextRetry(
                nextAttempts
              ),
          }
        );
      } catch (updateError) {
        console.error(
          "[Betting Reconciliation Update Error]",
          {
            transactionId:
              transaction.id,
            message:
              getErrorMessage(
                updateError
              ),
          }
        );
      }

      console.error(
        "[Betting Reconciliation Error]",
        {
          transactionId:
            transaction.id,
          message:
            getErrorMessage(error),
        }
      );
    }
  }

  return results;
}

module.exports = {
  reconcileTransaction,
  reconcileBettingTransactions,
};