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
  Math.min(
    Number(
      process.env.BETTING_RECONCILIATION_BATCH_SIZE || 25
    ),
    100
  )
);

const DEFAULT_BACKOFF_MINUTES = Math.max(
  1,
  Number(
    process.env.BETTING_RECONCILIATION_BACKOFF_MINUTES || 5
  )
);

const MAX_RECONCILIATION_ATTEMPTS = Math.max(
  1,
  Number(
    process.env.BETTING_MAX_RECONCILIATION_ATTEMPTS || 20
  )
);

/*
 * A reconciliation claim prevents multiple workers from
 * simultaneously querying the same transaction.
 *
 * The claim is intentionally short-lived so a crashed worker
 * does not permanently lock reconciliation.
 */
const RECONCILIATION_CLAIM_MINUTES = Math.max(
  1,
  Number(
    process.env.BETTING_RECONCILIATION_CLAIM_MINUTES || 5
  )
);

function now() {
  return new Date();
}

function normalizeString(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function getErrorMessage(error) {
  return (
    normalizeString(error?.message) ||
    "Unknown error"
  );
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

function calculateClaimExpiry() {
  return new Date(
    Date.now() +
      RECONCILIATION_CLAIM_MINUTES *
        60 *
        1000
  );
}

function toDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (
    typeof value.toDate === "function"
  ) {
    const converted = value.toDate();

    return converted instanceof Date
      ? converted
      : null;
  }

  const converted = new Date(value);

  if (Number.isNaN(converted.getTime())) {
    return null;
  }

  return converted;
}

function isRetryDue(transaction) {
  if (!transaction) {
    return false;
  }

  /*
   * An exhausted transaction must not be continuously
   * retried by the worker.
   */
  if (
    transaction.reconciliationExhausted === true
  ) {
    return false;
  }

  /*
   * Do not process a transaction that is no longer
   * waiting for reconciliation.
   */
  if (
    transaction.status !== STATUS_PENDING ||
    transaction.reconciliationRequired !== true
  ) {
    return false;
  }

  /*
   * Respect an existing reconciliation schedule.
   */
  const next =
    toDate(
      transaction.nextReconciliationAt
    );

  if (next && next.getTime() > Date.now()) {
    return false;
  }

  /*
   * Respect an active reconciliation claim.
   *
   * If the previous worker crashed, the claim eventually
   * expires and another worker can continue.
   */
  const claimUntil =
    toDate(
      transaction.reconciliationClaimUntil
    );

  if (
    claimUntil &&
    claimUntil.getTime() > Date.now()
  ) {
    return false;
  }

  return true;
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

async function claimTransaction(
  transactionId
) {
  const transactionDocument =
    bettingTransactionsRef.doc(
      transactionId
    );

  return db.runTransaction(
    async (firestoreTransaction) => {
      const snapshot =
        await firestoreTransaction.get(
          transactionDocument
        );

      if (!snapshot.exists) {
        return {
          claimed: false,
          reason: "transaction_not_found",
          transaction: null,
        };
      }

      const transaction =
        snapshot.data();

      if (
        transaction.status !==
        STATUS_PENDING
      ) {
        return {
          claimed: false,
          reason: "transaction_not_pending",
          transaction,
        };
      }

      if (
        transaction.reconciliationRequired !==
        true
      ) {
        return {
          claimed: false,
          reason:
            "reconciliation_not_required",
          transaction,
        };
      }

      if (
        transaction.reconciliationExhausted ===
        true
      ) {
        return {
          claimed: false,
          reason:
            "reconciliation_exhausted",
          transaction,
        };
      }

      const nextRetry =
        toDate(
          transaction.nextReconciliationAt
        );

      if (
        nextRetry &&
        nextRetry.getTime() >
          Date.now()
      ) {
        return {
          claimed: false,
          reason: "retry_not_due",
          transaction,
        };
      }

      const existingClaim =
        toDate(
          transaction.reconciliationClaimUntil
        );

      if (
        existingClaim &&
        existingClaim.getTime() >
          Date.now()
      ) {
        return {
          claimed: false,
          reason: "already_claimed",
          transaction,
        };
      }

      const claimUntil =
        calculateClaimExpiry();

      const attempts =
        Number(
          transaction.reconciliationAttempts
        ) || 0;

      firestoreTransaction.update(
        transactionDocument,
        {
          reconciliationStartedAt:
            now(),
          reconciliationClaimedAt:
            now(),
          reconciliationClaimUntil:
            claimUntil,
          updatedAt: now(),
        }
      );

      return {
        claimed: true,
        reason: "claimed",
        transaction: {
          id:
            transaction.id ||
            snapshot.id,
          ...transaction,
          reconciliationClaimUntil:
            claimUntil,
        },
        attempts,
      };
    }
  );
}

function normalizeProviderResult(result) {
  if (
    !result ||
    typeof result !== "object"
  ) {
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

function buildRequeryRequest(
  transaction
) {
  return {
    provider:
      normalizeString(
        transaction.provider
      ),

    serviceId:
      normalizeString(
        transaction.serviceId
      ),

    customerId:
      normalizeString(
        transaction.customerId
      ),

    transactionId:
      normalizeString(
        transaction.id
      ),

    providerRequestId:
      normalizeString(
        transaction.providerRequestId
      ),
  };
}

async function clearClaim(
  transactionId
) {
  try {
    await updateTransaction(
      transactionId,
      {
        reconciliationClaimUntil: null,
        reconciliationClaimedAt: null,
      }
    );
  } catch (error) {
    console.error(
      "[Betting Reconciliation Claim Clear Error]",
      {
        transactionId,
        message:
          getErrorMessage(error),
      }
    );
  }
}

async function reconcileTransaction(
  transaction
) {
  const transactionId =
    normalizeString(
      transaction?.id
    );

  if (!transactionId) {
    throw new Error(
      "Betting reconciliation transaction ID is missing"
    );
  }

  const uid =
    normalizeString(
      transaction?.uid
    );

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
        reconciliationExhausted: false,
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
        reconciliationExhausted: false,
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
   * The reservation is the financial authority.
   *
   * If another process already committed it, the
   * transaction is financially successful.
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
        reconciliationExhausted: false,
        reconciliationError: "",
        nextReconciliationAt: null,
        reconciliationClaimUntil: null,
        reconciliationClaimedAt: null,
      }
    );

    return {
      transactionId,
      outcome: "success",
      reason:
        "reservation_already_committed",
    };
  }

  /*
   * If another process already released the
   * reservation, the transaction is financially failed.
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
        reconciliationExhausted: false,
        reconciliationError: "",
        nextReconciliationAt: null,
        reconciliationClaimUntil: null,
        reconciliationClaimedAt: null,
        failureReason:
          transaction.failureReason ||
          "Betting transaction failed",
      }
    );

    return {
      transactionId,
      outcome: "failure",
      reason:
        "reservation_already_released",
    };
  }

  /*
   * IMPORTANT:
   *
   * Reconciliation performs ONLY a provider status
   * lookup.
   *
   * It NEVER calls the original betting funding
   * endpoint again.
   */
  let providerResult;

  try {
    providerResult =
      await requeryBetting(
        buildRequeryRequest(
          transaction
        )
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

        reconciliationRequired:
          !permanentlyWaiting,

        reconciliationExhausted:
          permanentlyWaiting,

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

        reconciliationClaimUntil:
          null,

        reconciliationClaimedAt:
          null,
      }
    );

    return {
      transactionId,
      outcome: "unknown",
      reason: permanentlyWaiting
        ? "maximum_attempts_reached"
        : "requery_error",
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
   * Provider status is terminal success.
   * Commit the reservation.
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
      const attempts =
        Number(
          transaction.reconciliationAttempts
        ) || 0;

      const nextAttempts =
        attempts + 1;

      const permanentlyWaiting =
        nextAttempts >=
        MAX_RECONCILIATION_ATTEMPTS;

      /*
       * NEVER release the reservation after
       * provider success.
       */
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

          reconciliationRequired:
            !permanentlyWaiting,

          reconciliationExhausted:
            permanentlyWaiting,

          reconciliationAttempts:
            nextAttempts,

          reconciliationError:
            `Provider succeeded but reservation commit failed: ${getErrorMessage(
              error
            )}`,

          nextReconciliationAt:
            permanentlyWaiting
              ? null
              : calculateNextRetry(
                  nextAttempts
                ),

          reconciliationClaimUntil:
            null,

          reconciliationClaimedAt:
            null,
        }
      );

      return {
        transactionId,
        outcome: "unknown",
        reason:
          permanentlyWaiting
            ? "commit_failed_max_attempts"
            : "commit_failed",
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

        reconciliationExhausted: false,

        reconciliationAttempts:
          Number(
            transaction.reconciliationAttempts
          ) || 0,

        reconciliationError: "",

        nextReconciliationAt: null,

        reconciliationClaimUntil: null,

        reconciliationClaimedAt: null,
      }
    );

    return {
      transactionId,
      outcome: "success",
      reason:
        "provider_confirmed_success",
    };
  }

  /*
   * DEFINITE FAILURE
   *
   * Release the reservation only after
   * provider confirmation.
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
      const attempts =
        Number(
          transaction.reconciliationAttempts
        ) || 0;

      const nextAttempts =
        attempts + 1;

      const permanentlyWaiting =
        nextAttempts >=
        MAX_RECONCILIATION_ATTEMPTS;

      /*
       * NEVER mark the transaction failed while
       * the reservation is still locked.
       */
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

          reconciliationRequired:
            !permanentlyWaiting,

          reconciliationExhausted:
            permanentlyWaiting,

          reconciliationAttempts:
            nextAttempts,

          reconciliationError:
            `Provider failed but reservation release failed: ${getErrorMessage(
              error
            )}`,

          nextReconciliationAt:
            permanentlyWaiting
              ? null
              : calculateNextRetry(
                  nextAttempts
                ),

          reconciliationClaimUntil:
            null,

          reconciliationClaimedAt:
            null,
        }
      );

      return {
        transactionId,
        outcome: "unknown",
        reason:
          permanentlyWaiting
            ? "release_failed_max_attempts"
            : "release_failed",
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

        reconciliationExhausted: false,

        reconciliationAttempts:
          Number(
            transaction.reconciliationAttempts
          ) || 0,

        reconciliationError: "",

        nextReconciliationAt: null,

        reconciliationClaimUntil: null,

        reconciliationClaimedAt: null,
      }
    );

    return {
      transactionId,
      outcome: "failure",
      reason:
        "provider_confirmed_failure",
    };
  }

  /*
   * UNKNOWN / PROCESSING / AMBIGUOUS
   *
   * NEVER release the reservation.
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

      reconciliationRequired:
        !permanentlyWaiting,

      reconciliationExhausted:
        permanentlyWaiting,

      reconciliationAttempts:
        nextAttempts,

      reconciliationError: "",

      nextReconciliationAt:
        permanentlyWaiting
          ? null
          : calculateNextRetry(
              nextAttempts
            ),

      reconciliationClaimUntil:
        null,

      reconciliationClaimedAt:
        null,
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
      Number(batchSize) ||
        DEFAULT_BATCH_SIZE,
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
      skipped: 0,
      errors: 0,
    };
  }

  const results = {
    scanned: 0,
    success: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    errors: 0,
  };

  for (
    const document of snapshot.docs
  ) {
    const transaction =
      {
        id: document.id,
        ...document.data(),
      };

    if (
      !isRetryDue(transaction)
    ) {
      results.skipped += 1;
      continue;
    }

    results.scanned += 1;

    let claim;

    try {
      claim =
        await claimTransaction(
          document.id
        );
    } catch (error) {
      results.errors += 1;

      console.error(
        "[Betting Reconciliation Claim Error]",
        {
          transactionId:
            document.id,
          message:
            getErrorMessage(error),
        }
      );

      continue;
    }

    if (!claim.claimed) {
      results.skipped += 1;
      continue;
    }

    try {
      const result =
        await reconcileTransaction(
          claim.transaction
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
          claim.transaction
            .reconciliationAttempts
        ) || 0;

      const nextAttempts =
        attempts + 1;

      const permanentlyWaiting =
        nextAttempts >=
        MAX_RECONCILIATION_ATTEMPTS;

      try {
        await updateTransaction(
          document.id,
          {
            status: STATUS_PENDING,

            providerOutcome:
              "unknown",

            reconciliationRequired:
              !permanentlyWaiting,

            reconciliationExhausted:
              permanentlyWaiting,

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

            reconciliationClaimUntil:
              null,

            reconciliationClaimedAt:
              null,
          }
        );
      } catch (updateError) {
        console.error(
          "[Betting Reconciliation Update Error]",
          {
            transactionId:
              document.id,
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
            document.id,
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