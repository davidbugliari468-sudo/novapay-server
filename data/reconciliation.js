"use strict";

const { db } = require("../firebase-admin");

const babspay = require("./provider/babspay");

const {
  getReservation,
  commitReservation,
  releaseReservation
} = require("../wallet/reservation");

const DATA_TRANSACTIONS_COLLECTION =
  "dataTransactions";

const SERVICE_NAME = "data";
const PROVIDER_NAME = "babspay";

const STATUS_PENDING = "pending";
const STATUS_UNKNOWN = "unknown";
const STATUS_SUCCESSFUL = "successful";
const STATUS_FAILED = "failed";

const RESERVATION_PENDING = "pending";
const RESERVATION_COMMITTED = "committed";
const RESERVATION_RELEASED = "released";

const DEFAULT_INTERVAL_MS =
  60 * 1000;

const DEFAULT_BATCH_SIZE =
  25;

const DEFAULT_MAX_AGE_MS =
  24 * 60 * 60 * 1000;

const RECONCILIATION_INTERVAL_MS =
  parseIntegerEnv(
    "DATA_RECONCILIATION_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
    10_000,
    60 * 60 * 1000
  );

const RECONCILIATION_BATCH_SIZE =
  parseIntegerEnv(
    "DATA_RECONCILIATION_BATCH_SIZE",
    DEFAULT_BATCH_SIZE,
    1,
    100
  );

const RECONCILIATION_MAX_AGE_MS =
  parseIntegerEnv(
    "DATA_RECONCILIATION_MAX_AGE_MS",
    DEFAULT_MAX_AGE_MS,
    60 * 1000,
    7 * 24 * 60 * 60 * 1000
  );

let workerRunning = false;
let workerTimer = null;

function parseIntegerEnv(
  name,
  fallback,
  minimum,
  maximum
) {
  const raw =
    process.env[name];

  if (
    raw === undefined ||
    raw === null ||
    String(raw).trim() === ""
  ) {
    return fallback;
  }

  const value =
    Number.parseInt(
      String(raw).trim(),
      10
    );

  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `Invalid ${name} configuration`
    );
  }

  return value;
}

function createError(
  message,
  code = "DATA_RECONCILIATION_ERROR"
) {
  const error =
    new Error(message);

  error.code = code;

  return error;
}

function normalizeProviderReference(
  value
) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const normalized =
    String(value)
      .trim();

  if (!normalized) {
    return null;
  }

  if (
    !/^[A-Za-z0-9._:-]{1,150}$/.test(
      normalized
    )
  ) {
    return null;
  }

  return normalized;
}

function normalizeOutcome(
  result
) {
  if (
    !result ||
    typeof result !== "object"
  ) {
    return {
      outcome:
        STATUS_UNKNOWN,
      providerReference:
        null,
      message:
        "Invalid provider requery response."
    };
  }

  const rawOutcome =
    String(
      result.outcome ||
      result.status ||
      ""
    )
      .trim()
      .toLowerCase();

  const providerReference =
    normalizeProviderReference(
      result.providerReference ||
      result.ref ||
      result.reference ||
      result.transref ||
      null
    );

  const message =
    String(
      result.message ||
      result.msg ||
      ""
    )
      .trim()
      .slice(0, 500);

  if (
    rawOutcome ===
      STATUS_SUCCESSFUL ||
    rawOutcome ===
      "success"
  ) {
    return {
      outcome:
        STATUS_SUCCESSFUL,
      providerReference,
      message
    };
  }

  if (
    rawOutcome ===
      STATUS_FAILED ||
    rawOutcome ===
      "failed" ||
    rawOutcome ===
      "fail" ||
    rawOutcome ===
      "failure" ||
    rawOutcome ===
      "reversed" ||
    rawOutcome ===
      "reverse"
  ) {
    return {
      outcome:
        STATUS_FAILED,
      providerReference,
      message
    };
  }

  if (
    rawOutcome ===
      STATUS_PENDING ||
    rawOutcome ===
      "processing" ||
    rawOutcome ===
      "queued"
  ) {
    return {
      outcome:
        STATUS_PENDING,
      providerReference,
      message
    };
  }

  /*
   * This intentionally includes "not_found".
   *
   * A transaction not being found during a requery
   * is NOT proof that the provider did not process it.
   */
  return {
    outcome:
      STATUS_UNKNOWN,
    providerReference,
    message
  };
}

function getTransactionRef(
  transactionId
) {
  return db
    .collection(
      DATA_TRANSACTIONS_COLLECTION
    )
    .doc(transactionId);
}

async function getTransaction(
  transactionId
) {
  const reference =
    getTransactionRef(
      transactionId
    );

  const snapshot =
    await reference.get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id:
      snapshot.id,
    ...snapshot.data()
  };
}

async function updateTransaction(
  transactionId,
  updates
) {
  const reference =
    getTransactionRef(
      transactionId
    );

  await reference.update({
    ...updates,
    updatedAt:
      new Date()
  });
}

function transactionIdFromDocument(
  document
) {
  if (
    document &&
    document.id
  ) {
    return document.id;
  }

  return null;
}

function reservationMatchesTransaction(
  reservation,
  transaction
) {
  if (
    !reservation ||
    !transaction
  ) {
    return false;
  }

  if (
    String(reservation.uid || "") !==
    String(transaction.uid || "")
  ) {
    return false;
  }

  if (
    String(
      reservation.reference || ""
    ) !==
    String(
      transaction.reference || ""
    )
  ) {
    return false;
  }

  if (
    String(
      reservation.service || ""
    ).toLowerCase() !==
    SERVICE_NAME
  ) {
    return false;
  }

  if (
    String(
      reservation.id || ""
    ) !==
    String(
      transaction.reservationId || ""
    )
  ) {
    return false;
  }

  if (
    Number(
      reservation.amountKobo
    ) !==
    Number(
      transaction.customerPriceKobo
    )
  ) {
    return false;
  }

  if (
    String(
      reservation.currency || ""
    ).toUpperCase() !==
    String(
      transaction.currency || "NGN"
    ).toUpperCase()
  ) {
    return false;
  }

  return true;
}

function normalizeComparablePhone(
  value
) {
  const phone =
    String(value || "")
      .trim()
      .replace(/\s+/g, "");

  if (!phone) {
    return null;
  }

  if (
    /^\+234\d{10}$/.test(
      phone
    )
  ) {
    return `0${phone.slice(4)}`;
  }

  if (
    /^234\d{10}$/.test(
      phone
    )
  ) {
    return `0${phone.slice(3)}`;
  }

  return phone;
}

/*
 * The reservation record currently stores the financial
 * identity of the transaction, while the Data transaction
 * stores the commercial/provider identity.
 *
 * Therefore reconciliation validates the two records using
 * the fields that actually exist in both records.
 *
 * We deliberately do NOT require reservation.metadata,
 * because wallet/reservation.js does not depend on such a
 * structure.
 */
function transactionIdentityIsValid(
  transaction
) {
  if (
    !transaction ||
    typeof transaction !==
      "object"
  ) {
    return false;
  }

  if (
    String(
      transaction.service || ""
    ).toLowerCase() !==
    SERVICE_NAME
  ) {
    return false;
  }

  if (
    String(
      transaction.provider || ""
    ).toLowerCase() !==
    PROVIDER_NAME
  ) {
    return false;
  }

  if (
    !transaction.uid ||
    !transaction.reference ||
    !transaction.reservationId
  ) {
    return false;
  }

  if (
    !transaction.planId ||
    !transaction.networkId
  ) {
    return false;
  }

  if (
    !transaction.phoneNumber
  ) {
    return false;
  }

  if (
    !Number.isSafeInteger(
      Number(
        transaction.providerPriceKobo
      )
    ) ||
    Number(
      transaction.providerPriceKobo
    ) <= 0
  ) {
    return false;
  }

  if (
    !Number.isSafeInteger(
      Number(
        transaction.customerPriceKobo
      )
    ) ||
    Number(
      transaction.customerPriceKobo
    ) <= 0
  ) {
    return false;
  }

  return true;
}

async function safelyLoadReservation(
  transaction
) {
  if (
    !transaction.reservationId
  ) {
    throw createError(
      "Data transaction has no reservation ID.",
      "MISSING_RESERVATION_ID"
    );
  }

  if (
    !transactionIdentityIsValid(
      transaction
    )
  ) {
    throw createError(
      "Data transaction identity is invalid.",
      "INVALID_TRANSACTION_IDENTITY"
    );
  }

  const reservation =
    await getReservation(
      transaction.reservationId
    );

  if (
    !reservationMatchesTransaction(
      reservation,
      transaction
    )
  ) {
    throw createError(
      "Reservation does not match the Data transaction.",
      "RESERVATION_TRANSACTION_MISMATCH"
    );
  }

  return reservation;
}

async function reconcileTransaction(
  transaction
) {
  if (
    !transaction ||
    typeof transaction !==
      "object"
  ) {
    throw createError(
      "Invalid Data transaction."
    );
  }

  const transactionId =
    transaction.id ||
    transaction.transactionId ||
    null;

  if (!transactionId) {
    throw createError(
      "Data transaction ID is missing."
    );
  }

  if (
    transaction.service !==
    SERVICE_NAME
  ) {
    return {
      ok:
        false,
      status:
        "ignored",
      transactionId
    };
  }

  if (
    transaction.status ===
      STATUS_SUCCESSFUL ||
    transaction.status ===
      STATUS_FAILED
  ) {
    return {
      ok:
        true,
      status:
        transaction.status,
      transactionId
    };
  }

  let reservation;

  try {
    reservation =
      await safelyLoadReservation(
        transaction
      );
  } catch (error) {
    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        reconciliationError:
          error.code ||
          "RESERVATION_VALIDATION_ERROR"
      }
    );

    return {
      ok:
        false,
      status:
        STATUS_UNKNOWN,
      transactionId,
      error:
        error.code
    };
  }

  /*
   * If wallet settlement already happened, never debit
   * again. Just synchronize the Data transaction.
   */
  if (
    reservation.status ===
    RESERVATION_COMMITTED
  ) {
    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_SUCCESSFUL,

        reconciliationRequired:
          false,

        completedAt:
          transaction.completedAt ||
          new Date(),

        walletReservationStatus:
          RESERVATION_COMMITTED,

        reconciliationError:
          null
      }
    );

    return {
      ok:
        true,
      status:
        STATUS_SUCCESSFUL,
      transactionId
    };
  }

  /*
   * If funds were already released, never release
   * them again.
   */
  if (
    reservation.status ===
    RESERVATION_RELEASED
  ) {
    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_FAILED,

        reconciliationRequired:
          false,

        completedAt:
          transaction.completedAt ||
          new Date(),

        walletReservationStatus:
          RESERVATION_RELEASED,

        reconciliationError:
          null
      }
    );

    return {
      ok:
        true,
      status:
        STATUS_FAILED,
      transactionId
    };
  }

  /*
   * Only a pending reservation can be settled here.
   */
  if (
    reservation.status !==
    RESERVATION_PENDING
  ) {
    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        reconciliationError:
          "INVALID_RESERVATION_STATE"
      }
    );

    return {
      ok:
        false,
      status:
        STATUS_UNKNOWN,
      transactionId
    };
  }

  const existingProviderReference =
    normalizeProviderReference(
      transaction.providerReference
    );

  const transactionReference =
    normalizeProviderReference(
      transaction.reference
    );

  if (
    !transactionReference
  ) {
    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        reconciliationError:
          "MISSING_TRANSACTION_REFERENCE"
      }
    );

    return {
      ok:
        false,
      status:
        STATUS_UNKNOWN,
      transactionId
    };
  }

  const requeryReference =
    existingProviderReference ||
    transactionReference;

  let providerResult;

  try {
    /*
     * BabsPay adapter handles:
     *
     * GET
     * /api/transaction/status?reference=...
     */
    providerResult =
      await babspay.requeryTransaction({
        reference:
          requeryReference
      });
  } catch (error) {
    /*
     * Requery failure is ambiguous.
     *
     * NEVER release the wallet here.
     */
    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        reconciliationError:
          "PROVIDER_REQUERY_UNAVAILABLE"
      }
    );

    return {
      ok:
        false,
      status:
        STATUS_UNKNOWN,
      transactionId
    };
  }

  const outcome =
    normalizeOutcome(
      providerResult
    );

  /*
   * Provider reference returned by BabsPay must not
   * contradict an already-known provider reference.
   */
  if (
    existingProviderReference &&
    outcome.providerReference &&
    existingProviderReference !==
      outcome.providerReference
  ) {
    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        reconciliationError:
          "PROVIDER_REFERENCE_MISMATCH"
      }
    );

    return {
      ok:
        false,
      status:
        STATUS_UNKNOWN,
      transactionId
    };
  }

  if (
    outcome.outcome ===
    STATUS_SUCCESSFUL
  ) {
    /*
     * BabsPay requery success is authoritative for the
     * provider transaction referenced by our unique
     * transaction reference.
     *
     * The wallet commit itself is idempotent.
     */
    let committedReservation;

    try {
      committedReservation =
        await commitReservation({
          uid:
            transaction.uid,

          reservationId:
            transaction.reservationId
        });
    } catch (error) {
      /*
       * Provider success + wallet settlement failure
       * must remain unresolved.
       *
       * NEVER release after confirmed provider success.
       */
      await updateTransaction(
        transactionId,
        {
          status:
            STATUS_UNKNOWN,

          reconciliationRequired:
            true,

          reconciliationError:
            error.code ||
            "WALLET_COMMIT_FAILED",

          providerReference:
            outcome.providerReference ||
            existingProviderReference ||
            null
        }
      );

      return {
        ok:
          false,
        status:
          STATUS_UNKNOWN,
        transactionId
      };
    }

    const completedAt =
      committedReservation.committedAt ||
      new Date();

    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_SUCCESSFUL,

        providerReference:
          outcome.providerReference ||
          existingProviderReference ||
          null,

        providerMessage:
          outcome.message ||
          "BabsPay transaction confirmed successfully.",

        reconciliationRequired:
          false,

        reconciliationError:
          null,

        completedAt,

        walletReservationStatus:
          RESERVATION_COMMITTED
      }
    );

    return {
      ok:
        true,
      status:
        STATUS_SUCCESSFUL,
      transactionId
    };
  }

  if (
    outcome.outcome ===
    STATUS_FAILED
  ) {
    /*
     * Only an explicit provider failure/reversal
     * permits release of the wallet reservation.
     */
    let releasedReservation;

    try {
      releasedReservation =
        await releaseReservation({
          uid:
            transaction.uid,

          reservationId:
            transaction.reservationId
        });
    } catch (error) {
      /*
       * Do not mark the transaction failed unless
       * the wallet release actually succeeds.
       */
      await updateTransaction(
        transactionId,
        {
          status:
            STATUS_UNKNOWN,

          reconciliationRequired:
            true,

          reconciliationError:
            error.code ||
            "WALLET_RELEASE_FAILED",

          providerReference:
            outcome.providerReference ||
            existingProviderReference ||
            null
        }
      );

      return {
        ok:
          false,
        status:
          STATUS_UNKNOWN,
        transactionId
      };
    }

    const completedAt =
      releasedReservation.releasedAt ||
      new Date();

    await updateTransaction(
      transactionId,
      {
        status:
          STATUS_FAILED,

        providerReference:
          outcome.providerReference ||
          existingProviderReference ||
          null,

        providerMessage:
          outcome.message ||
          "BabsPay confirmed that the transaction failed.",

        reconciliationRequired:
          false,

        reconciliationError:
          null,

        completedAt,

        walletReservationStatus:
          RESERVATION_RELEASED
      }
    );

    return {
      ok:
        true,
      status:
        STATUS_FAILED,
      transactionId
    };
  }

  /*
   * Pending, unknown, not-found, malformed, or otherwise
   * ambiguous responses remain unresolved.
   *
   * The wallet remains reserved.
   */
  await updateTransaction(
    transactionId,
    {
      status:
        outcome.outcome ===
        STATUS_PENDING
          ? STATUS_PENDING
          : STATUS_UNKNOWN,

      providerReference:
        outcome.providerReference ||
        existingProviderReference ||
        null,

      providerMessage:
        outcome.message ||
        "BabsPay has not returned a conclusive transaction result.",

      reconciliationRequired:
        true,

      reconciliationError:
        null
    }
  );

  return {
    ok:
      false,
    status:
      outcome.outcome ===
      STATUS_PENDING
        ? STATUS_PENDING
        : STATUS_UNKNOWN,
    transactionId
  };
}

function toMillis(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return 0;
  }

  if (
    typeof value.toMillis ===
    "function"
  ) {
    return value.toMillis();
  }

  if (
    value instanceof Date
  ) {
    return value.getTime();
  }

  if (
    typeof value ===
      "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (
    typeof value ===
      "string"
  ) {
    const parsed =
      Date.parse(value);

    return Number.isFinite(parsed)
      ? parsed
      : 0;
  }

  return 0;
}

function isOlderThanMaximumAge(
  transaction
) {
  const createdAtMillis =
    toMillis(
      transaction.createdAt
    );

  if (
    createdAtMillis <= 0
  ) {
    return false;
  }

  return (
    Date.now() -
      createdAtMillis >
    RECONCILIATION_MAX_AGE_MS
  );
}

async function findTransactionsForReconciliation() {
  /*
   * We intentionally query by status only and filter
   * service in application code.
   *
   * This avoids depending on a compound Firestore index
   * and also handles our current Date/string timestamp
   * representation safely.
   */
  const [pendingSnapshot, unknownSnapshot] =
    await Promise.all([
      db
        .collection(
          DATA_TRANSACTIONS_COLLECTION
        )
        .where(
          "status",
          "==",
          STATUS_PENDING
        )
        .limit(
          RECONCILIATION_BATCH_SIZE
        )
        .get(),

      db
        .collection(
          DATA_TRANSACTIONS_COLLECTION
        )
        .where(
          "status",
          "==",
          STATUS_UNKNOWN
        )
        .limit(
          RECONCILIATION_BATCH_SIZE
        )
        .get()
    ]);

  const records =
    new Map();

  for (
    const document of
    pendingSnapshot.docs
  ) {
    const transaction =
      {
        id:
          transactionIdFromDocument(
            document
          ),
        ...document.data()
      };

    if (
      transaction.service ===
      SERVICE_NAME
    ) {
      records.set(
        transaction.id,
        transaction
      );
    }
  }

  for (
    const document of
    unknownSnapshot.docs
  ) {
    const transaction =
      {
        id:
          transactionIdFromDocument(
            document
          ),
        ...document.data()
      };

    if (
      transaction.service ===
      SERVICE_NAME
    ) {
      records.set(
        transaction.id,
        transaction
      );
    }
  }

  const transactions =
    Array.from(
      records.values()
    );

  transactions.sort(
    (a, b) =>
      toMillis(a.createdAt) -
      toMillis(b.createdAt)
  );

  /*
   * Old transactions are NOT automatically released.
   *
   * They remain visible to reconciliation/manual review.
   *
   * We process them as well rather than silently
   * abandoning customer funds.
   */
  const staleTransactions =
    transactions.filter(
      isOlderThanMaximumAge
    );

  const normalTransactions =
    transactions.filter(
      (transaction) =>
        !isOlderThanMaximumAge(
          transaction
        )
    );

  /*
   * Process normal transactions first.
   * Stale transactions remain eligible so that a
   * delayed provider result can still be recovered.
   */
  return [
    ...normalTransactions,
    ...staleTransactions
  ].slice(
    0,
    RECONCILIATION_BATCH_SIZE
  );
}

async function reconcileBatch() {
  const transactions =
    await findTransactionsForReconciliation();

  const summary = {
    scanned:
      transactions.length,

    successful:
      0,

    failed:
      0,

    pending:
      0,

    unknown:
      0,

    errors:
      0
  };

  for (
    const transaction of
    transactions
  ) {
    try {
      const result =
        await reconcileTransaction(
          transaction
        );

      if (
        result.status ===
        STATUS_SUCCESSFUL
      ) {
        summary.successful += 1;
      } else if (
        result.status ===
        STATUS_FAILED
      ) {
        summary.failed += 1;
      } else if (
        result.status ===
        STATUS_PENDING
      ) {
        summary.pending += 1;
      } else {
        summary.unknown += 1;
      }
    } catch (error) {
      summary.errors += 1;

      try {
        await updateTransaction(
          transaction.id,
          {
            status:
              STATUS_UNKNOWN,

            reconciliationRequired:
              true,

            reconciliationError:
              error.code ||
              "RECONCILIATION_ERROR"
          }
        );
      } catch {
        /*
         * Nothing financially destructive is attempted
         * after an unexpected reconciliation error.
         */
      }
    }
  }

  return summary;
}

async function runReconciliationOnce() {
  if (
    workerRunning
  ) {
    return {
      skipped:
        true,

      reason:
        "Reconciliation worker is already running."
    };
  }

  workerRunning = true;

  try {
    const summary =
      await reconcileBatch();

    console.log(
      "Data reconciliation completed:",
      summary
    );

    return summary;
  } catch (error) {
    console.error(
      "Data reconciliation failed:",
      error.message
    );

    return {
      scanned:
        0,

      successful:
        0,

      failed:
        0,

      pending:
        0,

      unknown:
        0,

      errors:
        1
    };
  } finally {
    workerRunning = false;
  }
}

function startReconciliationWorker() {
  if (
    workerTimer
  ) {
    return {
      running:
        true,

      intervalMs:
        RECONCILIATION_INTERVAL_MS,

      batchSize:
        RECONCILIATION_BATCH_SIZE,

      maxAgeMs:
        RECONCILIATION_MAX_AGE_MS
    };
  }

  workerTimer =
    setInterval(
      () => {
        runReconciliationOnce()
          .catch(
            (error) => {
              console.error(
                "Unhandled Data reconciliation error:",
                error.message
              );
            }
          );
      },
      RECONCILIATION_INTERVAL_MS
    );

  if (
    workerTimer &&
    typeof workerTimer.unref ===
      "function"
  ) {
    workerTimer.unref();
  }

  console.log(
    "Data reconciliation worker started:",
    {
      intervalMs:
        RECONCILIATION_INTERVAL_MS,

      batchSize:
        RECONCILIATION_BATCH_SIZE,

      maxAgeMs:
        RECONCILIATION_MAX_AGE_MS
    }
  );

  return {
    running:
      true,

    intervalMs:
      RECONCILIATION_INTERVAL_MS,

    batchSize:
      RECONCILIATION_BATCH_SIZE,

    maxAgeMs:
      RECONCILIATION_MAX_AGE_MS
  };
}

function stopReconciliationWorker() {
  if (
    workerTimer
  ) {
    clearInterval(
      workerTimer
    );

    workerTimer = null;
  }

  return {
    running:
      false
  };
}

module.exports = {
  reconcileTransaction,
  reconcileBatch,
  runReconciliationOnce,
  startReconciliationWorker,
  stopReconciliationWorker
};