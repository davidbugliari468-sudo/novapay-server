"use strict";

const { db } = require("../firebase-admin");

const {
  commitReservation,
  releaseReservation,
  getReservation,
} = require("../wallet/reservation");

const {
  normalizeTvProviderStatus,
  normalizeTvProviderCode,
  isTvDefiniteFailureCode,
  isTvDefiniteFailureMessage,
} = require("./constants");

const vtu = require("./vtu");

const COLLECTION = "tvTransactions";

const STATUS_PENDING = "pending";
const STATUS_SUCCESSFUL = "successful";
const STATUS_FAILED = "failed";

const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

function transactionRef(transactionId) {
  return db.collection(COLLECTION).doc(transactionId);
}

function addMilliseconds(date, milliseconds) {
  return new Date(date.getTime() + milliseconds);
}

function getNow() {
  return new Date();
}

function calculateBackoff(attempts) {
  const safeAttempts = Math.max(1, Number(attempts) || 1);

  const delay =
    BASE_BACKOFF_MS *
    Math.pow(2, Math.min(safeAttempts - 1, 6));

  return Math.min(delay, MAX_BACKOFF_MS);
}

function isDue(transaction) {
  if (!transaction.nextReconciliationAt) {
    return true;
  }

  const next =
    transaction.nextReconciliationAt instanceof Date
      ? transaction.nextReconciliationAt
      : new Date(transaction.nextReconciliationAt);

  if (Number.isNaN(next.getTime())) {
    return true;
  }

  return next.getTime() <= Date.now();
}

function normalizeProviderResult(result) {
  if (!result || typeof result !== "object") {
    return {
      outcome: "unknown",
      providerStatus: "",
      providerCode: "",
      providerReference: "",
      message: "Invalid provider status response",
      raw: result || null,
    };
  }

  const providerStatus = normalizeTvProviderStatus(
    result.providerStatus ??
      result.status ??
      ""
  );

  const providerCode = normalizeTvProviderCode(
    result.providerCode ??
      result.code ??
      ""
  );

  const message = String(
    result.message ??
      result.error ??
      ""
  ).trim();

  const definiteFailure =
    isTvDefiniteFailureCode(providerCode) ||
    isTvDefiniteFailureMessage(message);

  let outcome = "unknown";

  if (
    result.outcome === "success" ||
    providerStatus === "completed-api"
  ) {
    outcome = "success";
  } else if (
    result.outcome === "failure" ||
    providerStatus === "failed" ||
    providerStatus === "refunded" ||
    providerStatus === "cancelled" ||
    definiteFailure
  ) {
    outcome = "failure";
  }

  return {
    outcome,
    providerStatus,
    providerCode,

    providerReference:
      result.providerReference ??
      result.reference ??
      "",

    message,

    raw: result,
  };
}

async function claimTransaction(transactionId) {
  const ref = transactionRef(transactionId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data();

    if (data.status !== STATUS_PENDING) {
      return null;
    }

    if (data.reconciliationRequired !== true) {
      return null;
    }

    if (data.reconciliationInProgress === true) {
      return null;
    }

    if (!isDue(data)) {
      return null;
    }

    const attempts =
      Number(data.reconciliationAttempts) || 0;

    if (attempts >= MAX_ATTEMPTS) {
      return null;
    }

    const now = getNow();

    transaction.update(ref, {
      reconciliationInProgress: true,
      reconciliationAttempts: attempts + 1,
      reconciliationStartedAt: now,
      updatedAt: now,
    });

    return {
      ...data,
      reconciliationAttempts: attempts + 1,
    };
  });
}

async function markWaiting(
  transactionId,
  transactionData,
  providerResult
) {
  const attempts =
    Number(
      transactionData.reconciliationAttempts
    ) || 1;

  const delay = calculateBackoff(attempts);

  const nextAttempt = addMilliseconds(
    getNow(),
    delay
  );

  const now = getNow();

  await transactionRef(transactionId).update({
    status: STATUS_PENDING,

    providerStatus:
      providerResult.providerStatus || "",

    providerCode:
      providerResult.providerCode || "",

    providerReference:
      providerResult.providerReference || "",

    providerOutcome:
      providerResult.raw,

    reconciliationRequired: true,

    reconciliationInProgress: false,

    nextReconciliationAt: nextAttempt,

    lastReconciliationAt: now,

    failureReason:
      providerResult.message ||
      "Provider outcome remains unknown",

    updatedAt: now,
  });

  return {
    status: STATUS_PENDING,
    transactionId,
    reconciliationRequired: true,
  };
}

async function resolveSuccess(
  transactionId,
  transactionData,
  providerResult
) {
  const reservationId =
    transactionData.reservationId;

  if (!reservationId) {
    throw new Error(
      "Successful TV transaction has no reservation"
    );
  }

  if (
    typeof transactionData.uid !== "string" ||
    !transactionData.uid.trim()
  ) {
    throw new Error(
      "Successful TV transaction has no valid user ID"
    );
  }

  const reservation =
    await getReservation(reservationId);

  if (!reservation) {
    throw new Error(
      "TV transaction reservation not found"
    );
  }

  if (
    reservation.uid &&
    reservation.uid !== transactionData.uid
  ) {
    throw new Error(
      "TV transaction reservation ownership mismatch"
    );
  }

  if (reservation.status !== "committed") {
    await commitReservation({
      uid: transactionData.uid,
      reservationId,
    });
  }

  const now = getNow();

  await transactionRef(transactionId).update({
    status: STATUS_SUCCESSFUL,

    providerStatus:
      providerResult.providerStatus || "",

    providerCode:
      providerResult.providerCode || "",

    providerReference:
      providerResult.providerReference || "",

    providerOutcome:
      providerResult.raw,

    reconciliationRequired: false,

    reconciliationInProgress: false,

    nextReconciliationAt: null,

    lastReconciliationAt: now,

    failureReason: "",

    updatedAt: now,
  });

  return {
    status: STATUS_SUCCESSFUL,
    transactionId,
  };
}

async function resolveFailure(
  transactionId,
  transactionData,
  providerResult
) {
  const reservationId =
    transactionData.reservationId;

  if (!reservationId) {
    throw new Error(
      "Failed TV transaction has no reservation"
    );
  }

  if (
    typeof transactionData.uid !== "string" ||
    !transactionData.uid.trim()
  ) {
    throw new Error(
      "Failed TV transaction has no valid user ID"
    );
  }

  const reservation =
    await getReservation(reservationId);

  if (!reservation) {
    throw new Error(
      "TV transaction reservation not found"
    );
  }

  if (
    reservation.uid &&
    reservation.uid !== transactionData.uid
  ) {
    throw new Error(
      "TV transaction reservation ownership mismatch"
    );
  }

  if (reservation.status === "reserved") {
    await releaseReservation({
      uid: transactionData.uid,
      reservationId,
    });
  } else if (reservation.status === "committed") {
    /*
     * Never reverse a committed reservation.
     *
     * A committed reservation means the financial
     * operation has already been finalized successfully.
     */
    throw new Error(
      "Cannot release a committed TV reservation"
    );
  }

  const now = getNow();

  await transactionRef(transactionId).update({
    status: STATUS_FAILED,

    providerStatus:
      providerResult.providerStatus || "",

    providerCode:
      providerResult.providerCode || "",

    providerReference:
      providerResult.providerReference || "",

    providerOutcome:
      providerResult.raw,

    reconciliationRequired: false,

    reconciliationInProgress: false,

    nextReconciliationAt: null,

    lastReconciliationAt: now,

    failureReason:
      providerResult.message ||
      "TV provider rejected the purchase",

    updatedAt: now,
  });

  return {
    status: STATUS_FAILED,
    transactionId,
  };
}

async function reconcileTransaction(transactionId) {
  const claimed =
    await claimTransaction(transactionId);

  if (!claimed) {
    return {
      skipped: true,
      transactionId,
    };
  }

  let providerResult;

  try {
    /*
     * IMPORTANT:
     * This is a status lookup only.
     *
     * We NEVER call purchaseTv() from reconciliation.
     */
    providerResult =
      await vtu.requeryTv({
        transactionId,

        /*
         * Our TV transaction stores the provider request
         * identifier as providerRequestId.
         */
        requestId:
          claimed.providerRequestId ||
          transactionId,
      });
  } catch (error) {
    /*
     * A network/timeout/provider communication error
     * is UNKNOWN.
     *
     * The reservation therefore remains locked.
     */
    providerResult = {
      outcome: "unknown",

      providerStatus: "",

      providerCode:
        "RECONCILIATION_REQUEST_UNKNOWN",

      providerReference: "",

      message:
        error?.message ||
        "Unable to query TV provider",
    };
  }

  const normalized =
    normalizeProviderResult(providerResult);

  if (normalized.outcome === "success") {
    try {
      return await resolveSuccess(
        transactionId,
        claimed,
        normalized
      );
    } catch (error) {
      /*
       * If commitReservation() succeeded but the transaction
       * update failed, the next reconciliation attempt sees
       * the committed reservation and safely completes the
       * transaction update.
       *
       * If the commit itself failed, the reservation remains
       * protected and reconciliation retries later.
       */
      const now = getNow();

      await transactionRef(transactionId).update({
        status: STATUS_PENDING,

        reconciliationRequired: true,

        reconciliationInProgress: false,

        lastReconciliationAt: now,

        nextReconciliationAt:
          addMilliseconds(
            now,
            BASE_BACKOFF_MS
          ),

        failureReason:
          "Provider succeeded but financial resolution is pending",

        updatedAt: now,
      });

      throw error;
    }
  }

  if (normalized.outcome === "failure") {
    try {
      return await resolveFailure(
        transactionId,
        claimed,
        normalized
      );
    } catch (error) {
      /*
       * Never turn a financial-resolution error into a
       * successful/failed final state blindly.
       *
       * The transaction stays pending and protected.
       */
      const now = getNow();

      await transactionRef(transactionId).update({
        status: STATUS_PENDING,

        reconciliationRequired: true,

        reconciliationInProgress: false,

        lastReconciliationAt: now,

        nextReconciliationAt:
          addMilliseconds(
            now,
            BASE_BACKOFF_MS
          ),

        failureReason:
          "Provider failure received but financial resolution is pending",

        updatedAt: now,
      });

      throw error;
    }
  }

  /*
   * UNKNOWN:
   *
   * No reservation release.
   * No purchase retry.
   * Keep the transaction pending.
   */
  return markWaiting(
    transactionId,
    claimed,
    normalized
  );
}

async function findPendingTransactions(limit = 25) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 25, 1),
    100
  );

  const snapshot = await db
    .collection(COLLECTION)
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
    .limit(safeLimit)
    .get();

  return snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter(isDue);
}

async function reconcilePendingTransactions(
  limit = 25
) {
  const transactions =
    await findPendingTransactions(limit);

  const results = [];

  for (const transaction of transactions) {
    try {
      const result =
        await reconcileTransaction(
          transaction.id
        );

      results.push(result);
    } catch (error) {
      console.error(
        "TV reconciliation error:",
        {
          transactionId: transaction.id,

          message:
            error?.message ||
            "Unknown reconciliation error",
        }
      );

      results.push({
        status: STATUS_PENDING,
        transactionId: transaction.id,
        error: true,
      });
    }
  }

  return {
    processed: results.length,
    results,
  };
}

module.exports = {
  reconcileTransaction,
  reconcilePendingTransactions,
};