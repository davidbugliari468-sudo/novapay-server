"use strict";

const crypto = require("crypto");

const { db } = require("../firebase-admin");

const {
  reserveFunds,
  getReservation,
  commitReservation,
  releaseReservation,
} = require("../wallet/reservation");

const {
  isSupportedBettingServiceId,
  normalizeBettingServiceId,
  normalizeBettingCustomerId,
  isValidBettingCustomerId,
  isValidBettingAmountKobo,
  normalizeBettingProviderStatus,
  normalizeBettingProviderCode,
  isBettingDefiniteFailureCode,
  isBettingDefiniteFailureMessage,
  getBettingProviderServiceId,
} = require("./constants");

const {
  validateBettingRequest,
} = require("./validation");

const DEFAULT_PROVIDER = "vtu.ng";

const STATUS_PENDING = "pending";
const STATUS_SUCCESSFUL = "successful";
const STATUS_FAILED = "failed";

const SERVICE_NAME = "betting";
const CURRENCY = "NGN";

const bettingTransactionsRef =
  db.collection("bettingTransactions");

/*
 * --------------------------------------------------------------------------
 * General helpers
 * --------------------------------------------------------------------------
 */

function now() {
  return new Date();
}

function normalizeString(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function requireUid(uid) {
  const normalized = normalizeString(uid);

  if (!normalized) {
    throw new Error("User ID is required");
  }

  return normalized;
}

function createTransactionId() {
  return `NPBET_${Date.now()}_${crypto
    .randomBytes(16)
    .toString("hex")}`;
}

function getTransactionRef(transactionId) {
  return bettingTransactionsRef.doc(
    normalizeString(transactionId)
  );
}

/*
 * --------------------------------------------------------------------------
 * Transaction lookup
 * --------------------------------------------------------------------------
 */

async function getBettingTransaction(transactionId) {
  const normalizedId =
    normalizeString(transactionId);

  if (!normalizedId) {
    return null;
  }

  const snapshot =
    await getTransactionRef(normalizedId).get();

  if (!snapshot.exists) {
    return null;
  }

  return snapshot.data();
}

/*
 * --------------------------------------------------------------------------
 * Existing transaction validation
 * --------------------------------------------------------------------------
 *
 * Client supplied transaction IDs are idempotency keys.
 *
 * If the same ID is reused, all important transaction details must
 * match the original request.
 * --------------------------------------------------------------------------
 */

function assertMatchingExistingTransaction(
  existingTransaction,
  {
    uid,
    provider,
    customerId,
    serviceId,
    amountKobo,
  }
) {
  if (!existingTransaction) {
    return;
  }

  if (existingTransaction.uid !== uid) {
    throw new Error(
      "Transaction does not belong to this user"
    );
  }

  if (
    normalizeString(
      existingTransaction.provider
    ) !== normalizeString(provider)
  ) {
    throw new Error(
      "Transaction details do not match"
    );
  }

  if (
    normalizeString(
      existingTransaction.customerId
    ) !== normalizeString(customerId)
  ) {
    throw new Error(
      "Transaction details do not match"
    );
  }

  if (
    normalizeString(
      existingTransaction.serviceId
    ) !== normalizeString(serviceId)
  ) {
    throw new Error(
      "Transaction details do not match"
    );
  }

  if (
    Number(existingTransaction.amountKobo) !==
    Number(amountKobo)
  ) {
    throw new Error(
      "Transaction details do not match"
    );
  }
}

/*
 * --------------------------------------------------------------------------
 * Transaction creation
 * --------------------------------------------------------------------------
 *
 * Firestore create() gives us the actual uniqueness guarantee.
 *
 * We deliberately do not rely on:
 *
 *   get() -> if missing -> create()
 *
 * as the uniqueness mechanism because two requests can perform the
 * initial read concurrently.
 * --------------------------------------------------------------------------
 */

async function createTransaction({
  transactionId,
  uid,
  provider,
  customerId,
  serviceId,
  amountKobo,
}) {
  const ref =
    getTransactionRef(transactionId);

  const existingSnapshot =
    await ref.get();

  if (existingSnapshot.exists) {
    const existing =
      existingSnapshot.data();

    assertMatchingExistingTransaction(
      existing,
      {
        uid,
        provider,
        customerId,
        serviceId,
        amountKobo,
      }
    );

    return existing;
  }

  const timestamp = now();

  const transaction = {
    id: transactionId,
    uid,

    service: SERVICE_NAME,

    /*
     * Application provider ID.
     *
     * Example:
     *   bet9ja
     */
    provider,

    /*
     * Canonical provider service ID.
     *
     * Example:
     *   Bet9ja
     */
    serviceId,

    customerId,

    amountKobo,
    currency: CURRENCY,

    status: STATUS_PENDING,

    providerReference: "",
    providerRequestId: "",
    providerStatus: "",
    providerCode: "",
    providerMessage: "",

    costKobo: 0,
    gainKobo: 0,
    rewardPoints: 0,

    reservationId: null,

    providerOutcome: null,
    failureReason: "",

    reconciliationRequired: false,
    reconciliationExhausted: false,

    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    await ref.create(transaction);

    return transaction;
  } catch (error) {
    /*
     * A concurrent request may have created the same transaction
     * between our read and create.
     *
     * Reload the document and perform the normal idempotency checks.
     */
    if (
      error?.code === 6 ||
      error?.code === "already-exists" ||
      error?.code === "ALREADY_EXISTS"
    ) {
      const concurrentSnapshot =
        await ref.get();

      if (!concurrentSnapshot.exists) {
        throw error;
      }

      const existing =
        concurrentSnapshot.data();

      assertMatchingExistingTransaction(
        existing,
        {
          uid,
          provider,
          customerId,
          serviceId,
          amountKobo,
        }
      );

      return existing;
    }

    throw error;
  }
}

/*
 * --------------------------------------------------------------------------
 * Transaction update
 * --------------------------------------------------------------------------
 */

async function updateTransaction(
  transactionId,
  updates
) {
  const ref =
    getTransactionRef(transactionId);

  await ref.update({
    ...updates,
    updatedAt: now(),
  });

  return getBettingTransaction(
    transactionId
  );
}

/*
 * --------------------------------------------------------------------------
 * Provider result normalization
 * --------------------------------------------------------------------------
 *
 * There are three possible financial outcomes:
 *
 *   success  -> commit reservation
 *   failure  -> release reservation
 *   unknown  -> keep reservation locked and reconcile
 *
 * Unknown is intentionally the safe default.
 * --------------------------------------------------------------------------
 */

function validateProviderResult(
  providerResult
) {
  if (
    !providerResult ||
    typeof providerResult !== "object"
  ) {
    return {
      outcome: "unknown",
      providerReference: "",
      providerRequestId: "",
      providerStatus: "",
      providerCode: "",
      message: "",
      amountKobo: null,
    };
  }

  const providerStatus =
    normalizeBettingProviderStatus(
      providerResult.providerStatus ||
        providerResult.status
    );

  const providerCode =
    normalizeBettingProviderCode(
      providerResult.providerCode ||
        providerResult.code
    );

  const message =
    normalizeString(
      providerResult.message ||
        providerResult.providerMessage
    );

  const providerReference =
    normalizeString(
      providerResult.providerReference ||
        providerResult.reference
    );

  const providerRequestId =
    normalizeString(
      providerResult.providerRequestId ||
        providerResult.requestId
    );

  const amountKobo =
    Number.isFinite(
      Number(providerResult.amountKobo)
    )
      ? Number(providerResult.amountKobo)
      : null;

  /*
   * Explicit success from our adapter is authoritative.
   */
  if (
    providerResult.outcome === "success"
  ) {
    return {
      outcome: "success",
      providerReference,
      providerRequestId,
      providerStatus,
      providerCode,
      message,
      amountKobo,
    };
  }

  /*
   * Explicit failure from our adapter is authoritative.
   *
   * The adapter is responsible for only returning outcome=failure
   * when the provider response is definitely unsuccessful.
   */
  if (
    providerResult.outcome === "failure"
  ) {
    return {
      outcome: "failure",
      providerReference,
      providerRequestId,
      providerStatus,
      providerCode,
      message,
      amountKobo,
    };
  }

  /*
   * A known definite failure code/message can also be converted
   * into a financial failure.
   */
  if (
    isBettingDefiniteFailureCode(
      providerCode
    ) ||
    isBettingDefiniteFailureMessage(
      message
    )
  ) {
    return {
      outcome: "failure",
      providerReference,
      providerRequestId,
      providerStatus,
      providerCode,
      message,
      amountKobo,
    };
  }

  /*
   * Everything else is ambiguous.
   *
   * IMPORTANT:
   * We do not release the customer's reservation here.
   */
  return {
    outcome: "unknown",
    providerReference,
    providerRequestId,
    providerStatus,
    providerCode,
    message,
    amountKobo,
  };
}

/*
 * --------------------------------------------------------------------------
 * Provider metadata helper
 * --------------------------------------------------------------------------
 */

function getProviderMetadata(
  providerResult
) {
  return {
    providerReference:
      normalizeString(
        providerResult.providerReference
      ),

    providerRequestId:
      normalizeString(
        providerResult.providerRequestId
      ),

    providerStatus:
      normalizeBettingProviderStatus(
        providerResult.providerStatus
      ),

    providerCode:
      normalizeBettingProviderCode(
        providerResult.providerCode
      ),

    providerMessage:
      normalizeString(
        providerResult.message
      ),
  };
}

/*
 * --------------------------------------------------------------------------
 * Successful transaction
 * --------------------------------------------------------------------------
 *
 * Financial sequence:
 *
 *   reservation -> committed
 *   transaction -> successful
 *
 * If transaction update fails after commit, reconciliation can observe
 * the committed reservation and restore the transaction to successful.
 * --------------------------------------------------------------------------
 */

async function handleSuccessfulBettingTransaction({
  transactionId,
  uid,
  reservationId,
  providerResult,
}) {
  await commitReservation({
    uid,
    reservationId,
  });

  const metadata =
    getProviderMetadata(
      providerResult
    );

  return updateTransaction(
    transactionId,
    {
      status: STATUS_SUCCESSFUL,

      ...metadata,

      providerOutcome: "success",

      failureReason: "",

      reconciliationRequired: false,

      reconciliationExhausted: false,
    }
  );
}

/*
 * --------------------------------------------------------------------------
 * Failed transaction
 * --------------------------------------------------------------------------
 *
 * Financial sequence:
 *
 *   reservation -> released
 *   transaction -> failed
 *
 * A definite provider rejection releases the customer's locked funds.
 * --------------------------------------------------------------------------
 */

async function handleFailedBettingTransaction({
  transactionId,
  uid,
  reservationId,
  providerResult,
}) {
  await releaseReservation({
    uid,
    reservationId,
  });

  const metadata =
    getProviderMetadata(
      providerResult
    );

  return updateTransaction(
    transactionId,
    {
      status: STATUS_FAILED,

      ...metadata,

      providerOutcome: "failure",

      failureReason:
        normalizeString(
          providerResult.message
        ) ||
        "Betting account funding was rejected",

      reconciliationRequired: false,

      reconciliationExhausted: false,
    }
  );
}

/*
 * --------------------------------------------------------------------------
 * Unknown transaction
 * --------------------------------------------------------------------------
 *
 * An unknown provider response must NOT move customer funds.
 *
 * We inspect the reservation because the financial operation might have
 * completed before our application received the provider response.
 * --------------------------------------------------------------------------
 */

async function handleUnknownBettingTransaction({
  transactionId,
  uid,
  reservationId,
  providerResult,
}) {
  const reservation =
    await getReservation(
      reservationId
    );

  if (!reservation) {
    throw new Error(
      "Betting transaction reservation could not be found"
    );
  }

  if (
    reservation.uid !== uid
  ) {
    throw new Error(
      "Betting transaction reservation does not belong to this user"
    );
  }

  const metadata =
    getProviderMetadata(
      providerResult
    );

  /*
   * If the reservation is already committed,
   * the money has been permanently deducted.
   */
  if (
    reservation.status === "committed"
  ) {
    return updateTransaction(
      transactionId,
      {
        status: STATUS_SUCCESSFUL,

        ...metadata,

        providerOutcome: "success",

        failureReason: "",

        reconciliationRequired: false,

        reconciliationExhausted: false,
      }
    );
  }

  /*
   * If the reservation is already released,
   * the money is available again.
   */
  if (
    reservation.status === "released"
  ) {
    return updateTransaction(
      transactionId,
      {
        status: STATUS_FAILED,

        ...metadata,

        providerOutcome: "failure",

        failureReason:
          normalizeString(
            providerResult.message
          ) ||
          "Betting transaction failed",

        reconciliationRequired: false,

        reconciliationExhausted: false,
      }
    );
  }

  /*
   * Active reservation + unknown provider outcome.
   *
   * Funds stay locked.
   */
  return updateTransaction(
    transactionId,
    {
      status: STATUS_PENDING,

      ...metadata,

      providerOutcome: "unknown",

      failureReason: "",

      reconciliationRequired: true,

      reconciliationExhausted: false,
    }
  );
}

/*
 * --------------------------------------------------------------------------
 * Provider/service normalization
 * --------------------------------------------------------------------------
 *
 * Application provider:
 *
 *   bet9ja
 *
 * VTU service ID:
 *
 *   Bet9ja
 * --------------------------------------------------------------------------
 */

function normalizeProvider(provider) {
  const normalized =
    normalizeString(provider)
      .toLowerCase();

  if (!normalized) {
    return "";
  }

  return normalized;
}

function resolveServiceId({
  provider,
  serviceId,
}) {
  /*
   * Prefer the application provider because it gives us one
   * canonical source of truth.
   */
  const normalizedProvider =
    normalizeProvider(provider);

  if (normalizedProvider) {
    const mappedServiceId =
      getBettingProviderServiceId(
        normalizedProvider
      );

    if (mappedServiceId) {
      return mappedServiceId;
    }
  }

  /*
   * Backwards compatibility:
   * allow an already canonical service ID.
   */
  const normalizedServiceId =
    normalizeBettingServiceId(
      serviceId
    );

  if (
    normalizedServiceId &&
    isSupportedBettingServiceId(
      normalizedServiceId
    )
  ) {
    return normalizedServiceId;
  }

  return "";
}

/*
 * --------------------------------------------------------------------------
 * Verify betting customer
 * --------------------------------------------------------------------------
 */

async function verifyBettingCustomer({
  providerClient,
  provider,
  customerId,
  serviceId,
}) {
  if (
    !providerClient ||
    typeof providerClient.verifyBettingCustomer !==
      "function"
  ) {
    throw new Error(
      "Betting provider verification client is unavailable"
    );
  }

  const normalizedProvider =
    normalizeProvider(provider);

  const normalizedCustomerId =
    normalizeBettingCustomerId(
      customerId
    );

  const normalizedServiceId =
    resolveServiceId({
      provider:
        normalizedProvider,
      serviceId,
    });

  if (
    !normalizedCustomerId ||
    !isValidBettingCustomerId(
      normalizedCustomerId
    )
  ) {
    throw new Error(
      "Invalid betting customer ID"
    );
  }

  if (
    !normalizedServiceId ||
    !isSupportedBettingServiceId(
      normalizedServiceId
    )
  ) {
    throw new Error(
      "Unsupported betting service"
    );
  }

  const result =
    await providerClient.verifyBettingCustomer({
      customerId:
        normalizedCustomerId,

      serviceId:
        normalizedServiceId,

      provider:
        normalizedProvider,
    });

  /*
   * Verification must explicitly succeed.
   */
  if (
    !result ||
    result.outcome !== "success"
  ) {
    const error =
      new Error(
        result?.message ||
          "Unable to verify the betting customer"
      );

    /*
     * Preserve provider rejection classification when the adapter
     * supplies it.
     */
    if (
      result?.kind ===
      "provider_rejection"
    ) {
      error.kind =
        "provider_rejection";
    }

    if (
      result?.type ===
      "provider_rejection"
    ) {
      error.type =
        "provider_rejection";
    }

    if (
      Number.isInteger(
        result?.httpStatus
      )
    ) {
      error.httpStatus =
        result.httpStatus;
    }

    if (
      typeof result?.providerCode ===
      "string"
    ) {
      error.providerCode =
        result.providerCode;
    }

    if (
      typeof result?.providerStatus ===
      "string"
    ) {
      error.providerStatus =
        result.providerStatus;
    }

    throw error;
  }

  return {
    outcome: "success",

    customerId:
      normalizeBettingCustomerId(
        result.customerId ||
          normalizedCustomerId
      ),

    requestedCustomerId:
      normalizedCustomerId,

    provider:
      normalizedProvider,

    serviceId:
      normalizedServiceId,

    customerName:
      normalizeString(
        result.customerName
      ),

    balance:
      result.balance ?? null,

    providerReference:
      normalizeString(
        result.providerReference
      ),

    providerRequestId:
      normalizeString(
        result.providerRequestId
      ),

    providerStatus:
      normalizeBettingProviderStatus(
        result.providerStatus
      ),

    providerCode:
      normalizeBettingProviderCode(
        result.providerCode
      ),

    message:
      normalizeString(
        result.message
      ),
  };
}

/*
 * --------------------------------------------------------------------------
 * Purchase/funding
 * --------------------------------------------------------------------------
 *
 * Financial state machine:
 *
 * 1. Validate request.
 * 2. Create/reuse transaction.
 * 3. If already settled, return it.
 * 4. If reservation already exists, NEVER fund again.
 * 5. Reserve customer funds.
 * 6. Call VTU exactly once.
 * 7. Success    -> commit reservation.
 * 8. Failure    -> release reservation.
 * 9. Ambiguous  -> keep reservation locked + reconcile.
 * --------------------------------------------------------------------------
 */

async function purchaseBettingAccount({
  uid,
  provider = DEFAULT_PROVIDER,
  customerId,
  serviceId,
  amountKobo,
  transactionId,
  providerClient,
}) {
  const normalizedUid =
    requireUid(uid);

  /*
   * Validate through the central validation contract.
   */
  const validation =
    validateBettingRequest({
      provider,
      customerId,
      serviceId:
        serviceId || provider,
      amountKobo,
      transactionId,
    });

  if (
    !validation ||
    validation.valid !== true
  ) {
    throw new Error(
      validation?.error ||
        "Invalid betting request"
    );
  }

  /*
   * IMPORTANT:
   *
   * validation.data is the actual normalized payload.
   */
  const validated =
    validation.data;

  const normalizedProvider =
    normalizeProvider(
      validated.provider
    );

  const normalizedCustomerId =
    normalizeBettingCustomerId(
      validated.customerId
    );

  const normalizedServiceId =
    resolveServiceId({
      provider:
        normalizedProvider,
      serviceId:
        validated.serviceId,
    });

  const normalizedAmountKobo =
    Number(
      validated.amountKobo
    );

  if (
    !normalizedProvider ||
    !isSupportedBettingServiceId(
      normalizedServiceId
    )
  ) {
    throw new Error(
      "Unsupported betting service"
    );
  }

  if (
    !isValidBettingCustomerId(
      normalizedCustomerId
    )
  ) {
    throw new Error(
      "Invalid betting customer ID"
    );
  }

  if (
    !isValidBettingAmountKobo(
      normalizedAmountKobo
    )
  ) {
    throw new Error(
      "Invalid betting amount"
    );
  }

  if (
    !providerClient ||
    typeof providerClient.fundBettingAccount !==
      "function"
  ) {
    throw new Error(
      "Betting provider funding client is unavailable"
    );
  }

  const id =
    normalizeString(
      validated.transactionId
    ) ||
    createTransactionId();

  let transaction =
    await createTransaction({
      transactionId: id,
      uid: normalizedUid,
      provider:
        normalizedProvider,
      customerId:
        normalizedCustomerId,
      serviceId:
        normalizedServiceId,
      amountKobo:
        normalizedAmountKobo,
    });

  /*
   * Idempotent terminal states.
   *
   * Never call VTU again.
   */
  if (
    transaction.status ===
      STATUS_SUCCESSFUL ||
    transaction.status ===
      STATUS_FAILED
  ) {
    return transaction;
  }

  /*
   * ----------------------------------------------------------------------
   * Existing reservation
   * ----------------------------------------------------------------------
   *
   * This is critical for preventing duplicate provider funding.
   *
   * If a previous attempt already reserved the money, the same
   * transaction must not send another funding request.
   * ----------------------------------------------------------------------
   */

  if (transaction.reservationId) {
    const existingReservation =
      await getReservation(
        transaction.reservationId
      );

    if (!existingReservation) {
      throw new Error(
        "Existing betting transaction reservation could not be found"
      );
    }

    if (
      existingReservation.uid !==
      normalizedUid
    ) {
      throw new Error(
        "Betting transaction reservation does not belong to this user"
      );
    }

    /*
     * The financial state says the transaction succeeded.
     */
    if (
      existingReservation.status ===
      "committed"
    ) {
      return updateTransaction(
        id,
        {
          status:
            STATUS_SUCCESSFUL,

          providerOutcome:
            "success",

          reconciliationRequired:
            false,

          reconciliationExhausted:
            false,
        }
      );
    }

    /*
     * The financial state says the transaction failed.
     */
    if (
      existingReservation.status ===
      "released"
    ) {
      return updateTransaction(
        id,
        {
          status:
            STATUS_FAILED,

          providerOutcome:
            "failure",

          reconciliationRequired:
            false,

          reconciliationExhausted:
            false,

          failureReason:
            transaction.failureReason ||
            "Betting transaction failed",
        }
      );
    }

    /*
     * Reservation is active.
     *
     * Do NOT call VTU again.
     *
     * Reconciliation owns the next provider-status check.
     */
    return transaction;
  }

  /*
   * ----------------------------------------------------------------------
   * Reserve customer funds BEFORE calling VTU.
   * ----------------------------------------------------------------------
   */

  const reservation =
    await reserveFunds({
      uid: normalizedUid,

      amountKobo:
        normalizedAmountKobo,

      reference: id,

      service:
        SERVICE_NAME,
    });

  /*
   * Link the reservation to the transaction.
   */
  transaction =
    await updateTransaction(
      id,
      {
        reservationId:
          reservation.id,
      }
    );

  /*
   * ----------------------------------------------------------------------
   * Provider funding
   * ----------------------------------------------------------------------
   *
   * The adapter must translate our internal amountKobo/request identity
   * into the exact VTU API request.
   *
   * We do not retry here after an exception.
   */
  let providerResult;

  try {
    providerResult =
      await providerClient.fundBettingAccount({
        transactionId: id,

        provider:
          normalizedProvider,

        customerId:
          normalizedCustomerId,

        serviceId:
          normalizedServiceId,

        amountKobo:
          normalizedAmountKobo,
      });
  } catch (error) {
    /*
     * A network error, timeout, connection reset, or similar exception
     * does NOT prove that VTU rejected the transaction.
     *
     * Therefore:
     *
     *   reservation stays locked
     *   transaction stays pending
     *   reconciliation queries provider status later
     *
     * NEVER retry the funding request here.
     */
    return handleUnknownBettingTransaction({
      transactionId: id,

      uid: normalizedUid,

      reservationId:
        reservation.id,

      providerResult: {
        outcome: "unknown",

        providerReference: "",

        providerRequestId: "",

        providerStatus: "",

        providerCode: "",

        message:
          error?.message ||
          "Unable to determine the betting transaction result",
      },
    });
  }

  /*
   * Normalize the provider response into our three-state model.
   */
  const normalizedProviderResult =
    validateProviderResult(
      providerResult
    );

  /*
   * ----------------------------------------------------------------------
   * DEFINITE SUCCESS
   * ----------------------------------------------------------------------
   */
  if (
    normalizedProviderResult.outcome ===
    "success"
  ) {
    return handleSuccessfulBettingTransaction({
      transactionId: id,

      uid: normalizedUid,

      reservationId:
        reservation.id,

      providerResult:
        normalizedProviderResult,
    });
  }

  /*
   * ----------------------------------------------------------------------
   * DEFINITE FAILURE
   * ----------------------------------------------------------------------
   */
  if (
    normalizedProviderResult.outcome ===
    "failure"
  ) {
    return handleFailedBettingTransaction({
      transactionId: id,

      uid: normalizedUid,

      reservationId:
        reservation.id,

      providerResult:
        normalizedProviderResult,
    });
  }

  /*
   * ----------------------------------------------------------------------
   * AMBIGUOUS / UNKNOWN
   * ----------------------------------------------------------------------
   *
   * Funds remain reserved.
   * Reconciliation takes over.
   * ----------------------------------------------------------------------
   */
  return handleUnknownBettingTransaction({
    transactionId: id,

    uid: normalizedUid,

    reservationId:
      reservation.id,

    providerResult:
      normalizedProviderResult,
  });
}

/*
 * --------------------------------------------------------------------------
 * Exports
 * --------------------------------------------------------------------------
 */

module.exports = {
  STATUS_PENDING,
  STATUS_SUCCESSFUL,
  STATUS_FAILED,

  SERVICE_NAME,
  CURRENCY,

  verifyBettingCustomer,
  purchaseBettingAccount,
  getBettingTransaction,
};