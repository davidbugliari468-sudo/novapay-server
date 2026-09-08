"use strict";

const {
  db,
} = require("../firebase-admin");

const {
  commitReservation,
  releaseReservation,
} = require("../wallet/reservation");

const {
  checkElectricityStatus,
} = require("./vtu");

const {
  ELECTRICITY_STATUS,
  RECONCILIATION_STATUS,
  RECONCILIATION_CONFIG,
} = require("./constants");

const COLLECTION =
  "electricityTransactions";

function transactionRef(
  transactionId
) {
  return db
    .collection(
      COLLECTION
    )
    .doc(
      transactionId
    );
}

function normalizeLimit(
  limit
) {
  const value =
    Number(
      limit
    );

  if (
    !Number.isSafeInteger(
      value
    ) ||
    value <= 0
  ) {
    return 25;
  }

  return Math.min(
    value,
    100
  );
}

function getBackoffMinutes(
  attempt
) {
  const schedule =
    Array.isArray(
      RECONCILIATION_CONFIG
        .BACKOFF_MINUTES
    )
      ? RECONCILIATION_CONFIG
          .BACKOFF_MINUTES
      : [1, 5, 15, 30, 60];

  const index =
    Math.min(
      Math.max(
        Number(attempt) || 0,
        0
      ),
      schedule.length - 1
    );

  return (
    Number(
      schedule[index]
    ) || 60
  );
}

function calculateNextReconciliationAt(
  attempt
) {
  const minutes =
    getBackoffMinutes(
      attempt
    );

  return new Date(
    Date.now() +
      minutes *
        60 *
        1000
  ).toISOString();
}

function isTransactionReconciliationCandidate(
  transaction
) {
  if (!transaction) {
    return false;
  }

  if (
    transaction.status !==
    ELECTRICITY_STATUS.UNKNOWN
  ) {
    return false;
  }

  if (
    transaction.reconciliationRequired !==
    true
  ) {
    return false;
  }

  if (
    transaction.reconciliationStatus ===
      RECONCILIATION_STATUS.RESOLVED ||
    transaction.reconciliationStatus ===
      RECONCILIATION_STATUS.ESCALATED
  ) {
    return false;
  }

  return true;
}

async function findTransactionsRequiringReconciliation(
  {
    limit = 25,
  } = {}
) {
  const safeLimit =
    normalizeLimit(
      limit
    );

  const now =
    new Date().toISOString();

  const snapshot =
    await db
      .collection(
        COLLECTION
      )
      .where(
        "status",
        "==",
        ELECTRICITY_STATUS.UNKNOWN
      )
      .where(
        "reconciliationRequired",
        "==",
        true
      )
      .limit(
        safeLimit * 3
      )
      .get();

  const transactions =
    [];

  for (
    const document of
      snapshot.docs
  ) {
    const transaction =
      {
        id:
          document.id,
        ...document.data(),
      };

    if (
      !isTransactionReconciliationCandidate(
        transaction
      )
    ) {
      continue;
    }

    /*
     * Do not repeatedly process a transaction
     * before its scheduled reconciliation time.
     */
    if (
      transaction.nextReconciliationAt &&
      transaction.nextReconciliationAt >
        now
    ) {
      continue;
    }

    transactions.push(
      transaction
    );

    if (
      transactions.length >=
      safeLimit
    ) {
      break;
    }
  }

  return transactions;
}

async function markReconciliationInProgress(
  transactionId
) {
  const ref =
    transactionRef(
      transactionId
    );

  const result =
    await db.runTransaction(
      async (
        transaction
      ) => {
        const snapshot =
          await transaction.get(
            ref
          );

        if (
          !snapshot.exists
        ) {
          return {
            process: false,
            reason:
              "not_found",
          };
        }

        const data =
          snapshot.data();

        if (
          data.status !==
          ELECTRICITY_STATUS.UNKNOWN
        ) {
          return {
            process: false,
            reason:
              "status_changed",
            transaction:
              {
                id:
                  snapshot.id,
                ...data,
              },
          };
        }

        if (
          data.reconciliationRequired !==
          true
        ) {
          return {
            process: false,
            reason:
              "reconciliation_not_required",
            transaction:
              {
                id:
                  snapshot.id,
                ...data,
              },
          };
        }

        if (
          data.reconciliationStatus ===
            RECONCILIATION_STATUS.RESOLVED ||
          data.reconciliationStatus ===
            RECONCILIATION_STATUS.ESCALATED
        ) {
          return {
            process: false,
            reason:
              "reconciliation_closed",
            transaction:
              {
                id:
                  snapshot.id,
                ...data,
              },
          };
        }

        const attempts =
          (
            Number(
              data.reconciliationAttempts
            ) || 0
          ) + 1;

        const now =
          new Date().toISOString();

        transaction.update(
          ref,
          {
            reconciliationStatus:
              RECONCILIATION_STATUS.IN_PROGRESS,

            reconciliationAttempts:
              attempts,

            lastReconciliationAt:
              now,

            updatedAt:
              now,
          }
        );

        return {
          process: true,

          transaction:
            {
              id:
                snapshot.id,
              ...data,

              reconciliationStatus:
                RECONCILIATION_STATUS.IN_PROGRESS,

              reconciliationAttempts:
                attempts,

              lastReconciliationAt:
                now,
            },
        };
      }
    );

  return result;
}

async function markReconciliationWaiting(
  transactionId,
  {
    providerReference = null,
    providerStatus = null,
    providerCode = null,
    message = null,
    nextReconciliationAt,
  }
) {
  const ref =
    transactionRef(
      transactionId
    );

  const now =
    new Date().toISOString();

  await ref.update({
    status:
      ELECTRICITY_STATUS.UNKNOWN,

    reconciliationRequired:
      true,

    reconciliationStatus:
      RECONCILIATION_STATUS.WAITING,

    providerReference:
      providerReference ||
      null,

    providerStatus:
      providerStatus ||
      null,

    providerCode:
      providerCode ||
      null,

    failureReason:
      message ||
      "",

    nextReconciliationAt:
      nextReconciliationAt,

    updatedAt:
      now,
  });

  return {
    transactionId,
    status:
      ELECTRICITY_STATUS.UNKNOWN,

    reconciliationStatus:
      RECONCILIATION_STATUS.WAITING,

    nextReconciliationAt,
  };
}

async function markReconciliationEscalated(
  transactionId,
  {
    providerReference = null,
    providerStatus = null,
    providerCode = null,
    message = null,
  } = {}
) {
  const ref =
    transactionRef(
      transactionId
    );

  const now =
    new Date().toISOString();

  await ref.update({
    status:
      ELECTRICITY_STATUS.MANUAL_REVIEW,

    reconciliationRequired:
      false,

    reconciliationStatus:
      RECONCILIATION_STATUS.ESCALATED,

    providerReference:
      providerReference ||
      null,

    providerStatus:
      providerStatus ||
      null,

    providerCode:
      providerCode ||
      null,

    failureReason:
      message ||
      "Electricity transaction requires manual review.",

    nextReconciliationAt:
      null,

    escalatedAt:
      now,

    updatedAt:
      now,
  });

  return {
    transactionId,

    status:
      ELECTRICITY_STATUS.MANUAL_REVIEW,

    reconciliationStatus:
      RECONCILIATION_STATUS.ESCALATED,
  };
}

async function reconcileElectricityTransaction(
  {
    transactionId,
  }
) {
  if (
    !transactionId ||
    typeof transactionId !==
      "string"
  ) {
    throw new Error(
      "transactionId is required."
    );
  }

  const ref =
    transactionRef(
      transactionId
    );

  const snapshot =
    await ref.get();

  if (
    !snapshot.exists
  ) {
    throw new Error(
      "Electricity transaction not found."
    );
  }

  const transaction =
    {
      id:
        snapshot.id,
      ...snapshot.data(),
    };

  /*
   * Only UNKNOWN transactions requiring
   * reconciliation are eligible.
   */
  if (
    !isTransactionReconciliationCandidate(
      transaction
    )
  ) {
    return {
      transactionId,

      status:
        transaction.status,

      reconciliationStatus:
        transaction.reconciliationStatus ||
        RECONCILIATION_STATUS.NOT_REQUIRED,

      action:
        "skipped",
    };
  }

  const inProgress =
    await markReconciliationInProgress(
      transactionId
    );

  if (
    !inProgress.process
  ) {
    return {
      transactionId,

      status:
        inProgress.transaction?.status ||
        null,

      reconciliationStatus:
        inProgress.transaction
          ?.reconciliationStatus ||
        null,

      action:
        "skipped",

      reason:
        inProgress.reason,
    };
  }

  const currentTransaction =
    inProgress.transaction;

  let providerResult;

  try {
    /*
     * CRITICAL:
     *
     * Reconciliation only REQUERIES the existing
     * provider request ID.
     *
     * It NEVER creates another electricity purchase.
     */
    providerResult =
      await checkElectricityStatus({
        transactionId:
          currentTransaction.id,

        providerRequestId:
          currentTransaction.providerRequestId ||
          null,
      });
  } catch (error) {
    /*
     * A failed requery tells us nothing about the
     * original provider order.
     *
     * Therefore:
     *
     * - do NOT release funds
     * - do NOT commit funds
     * - keep transaction UNKNOWN
     */
    const attempts =
      Number(
        currentTransaction.reconciliationAttempts
      ) || 1;

    const nextReconciliationAt =
      calculateNextReconciliationAt(
        attempts
      );

    return markReconciliationWaiting(
      transactionId,
      {
        providerReference:
          currentTransaction.providerReference ||
          null,

        providerStatus:
          error?.providerStatus ||
          currentTransaction.providerStatus ||
          null,

        providerCode:
          error?.providerCode ||
          currentTransaction.providerCode ||
          null,

        message:
          error?.message ||
          "Electricity reconciliation could not contact VTU.ng.",

        nextReconciliationAt,
      }
    );
  }

  /*
   * PROVIDER SUCCESS
   *
   * The provider says the electricity order completed.
   *
   * Now the NovaPay reservation can be committed.
   */
  if (
    providerResult.outcome ===
    "success"
  ) {
    try {
      await commitReservation({
        uid:
          currentTransaction.uid,

        reservationId:
          currentTransaction.reservationId,
      });
    } catch (error) {
      /*
       * The provider already succeeded.
       *
       * NEVER release the reservation here.
       *
       * Leave the transaction unresolved so another
       * reconciliation/repair pass can safely retry
       * the commit operation.
       */
      return markReconciliationWaiting(
        transactionId,
        {
          providerReference:
            providerResult.providerReference,

          providerStatus:
            providerResult.providerStatus,

          providerCode:
            providerResult.providerCode,

          message:
            "VTU.ng electricity order succeeded, but NovaPay could not commit the wallet reservation.",

          nextReconciliationAt:
            calculateNextReconciliationAt(
              Number(
                currentTransaction.reconciliationAttempts
              ) || 1
            ),
        }
      );
    }

    const now =
      new Date().toISOString();

    await ref.update({
      status:
        ELECTRICITY_STATUS.SUCCESS,

      providerRequestId:
        providerResult.providerRequestId,

      providerReference:
        providerResult.providerReference ||
        null,

      providerStatus:
        providerResult.providerStatus ||
        null,

      providerCode:
        providerResult.providerCode ||
        null,

      providerToken:
        providerResult.token ||
        null,

      providerUnits:
        providerResult.units ||
        null,

      providerOutcome:
        "success",

      reconciliationRequired:
        false,

      reconciliationStatus:
        RECONCILIATION_STATUS.RESOLVED,

      nextReconciliationAt:
        null,

      updatedAt:
        now,
    });

    return {
      transactionId,

      status:
        ELECTRICITY_STATUS.SUCCESS,

      reconciliationStatus:
        RECONCILIATION_STATUS.RESOLVED,

      action:
        "committed",
    };
  }

  /*
   * DEFINITE PROVIDER FAILURE
   *
   * The provider explicitly says the order failed,
   * was refunded, or was cancelled.
   *
   * The reservation can therefore be released.
   */
  if (
    providerResult.outcome ===
    "failure"
  ) {
    try {
      await releaseReservation({
        uid:
          currentTransaction.uid,

        reservationId:
          currentTransaction.reservationId,
      });
    } catch (error) {
      /*
       * Do not mark the transaction failed if we
       * could not release the customer's reservation.
       *
       * Money must remain protected until the release
       * operation succeeds.
       */
      return markReconciliationWaiting(
        transactionId,
        {
          providerReference:
            providerResult.providerReference,

          providerStatus:
            providerResult.providerStatus,

          providerCode:
            providerResult.providerCode,

          message:
            "VTU.ng rejected/refunded the electricity order, but NovaPay could not release the wallet reservation.",

          nextReconciliationAt:
            calculateNextReconciliationAt(
              Number(
                currentTransaction.reconciliationAttempts
              ) || 1
            ),
        }
      );
    }

    const now =
      new Date().toISOString();

    await ref.update({
      status:
        ELECTRICITY_STATUS.FAILED,

      providerRequestId:
        providerResult.providerRequestId,

      providerReference:
        providerResult.providerReference ||
        null,

      providerStatus:
        providerResult.providerStatus ||
        null,

      providerCode:
        providerResult.providerCode ||
        null,

      providerOutcome:
        "failure",

      failureReason:
        providerResult.message ||
        "VTU.ng electricity order failed.",

      reconciliationRequired:
        false,

      reconciliationStatus:
        RECONCILIATION_STATUS.RESOLVED,

      nextReconciliationAt:
        null,

      updatedAt:
        now,
    });

    return {
      transactionId,

      status:
        ELECTRICITY_STATUS.FAILED,

      reconciliationStatus:
        RECONCILIATION_STATUS.RESOLVED,

      action:
        "released",
    };
  }

  /*
   * UNKNOWN / STILL PROCESSING
   *
   * No wallet operation is allowed.
   */
  const attempts =
    Number(
      currentTransaction.reconciliationAttempts
    ) || 1;

  const nextReconciliationAt =
    calculateNextReconciliationAt(
      attempts
    );

  return markReconciliationWaiting(
    transactionId,
    {
      providerReference:
        providerResult.providerReference,

      providerStatus:
        providerResult.providerStatus,

      providerCode:
        providerResult.providerCode,

      message:
        providerResult.message ||
        "VTU.ng electricity order is still unresolved.",

      nextReconciliationAt,
    }
  );
}

module.exports = {
  findTransactionsRequiringReconciliation,
  reconcileElectricityTransaction,
  calculateNextReconciliationAt,
};