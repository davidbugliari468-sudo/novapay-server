"use strict";

const crypto = require("crypto");

const { db } = require("../firebase-admin");
const babspay = require("./provider/babspay");

const {
  validatePurchaseInput,
  validateUid,
  normalizeReference,
} = require("./validation");

const {
  getPlanById,
} = require("./catalog");

const {
  reserveFunds,
  getReservation,
  commitReservation,
  releaseReservation,
} = require("../wallet/reservation");

const DATA_TRANSACTIONS_COLLECTION = "dataTransactions";

const SERVICE_NAME = "data";
const PROVIDER_NAME = "babspay";
const CURRENCY = "NGN";

const STATUS_PENDING = "pending";
const STATUS_UNKNOWN = "unknown";
const STATUS_SUCCESSFUL = "successful";
const STATUS_FAILED = "failed";

const DEFAULT_MARKUP_KOBO = 0;
const DEFAULT_MAX_CUSTOMER_PRICE_KOBO = 5_000_000;

function createServiceError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = Boolean(details.retryable);
  error.httpStatus = details.httpStatus ?? null;
  return error;
}

function getMarkupKobo() {
  const raw = process.env.DATA_CUSTOMER_MARKUP_KOBO;

  if (
    raw === undefined ||
    raw === null ||
    String(raw).trim() === ""
  ) {
    return DEFAULT_MARKUP_KOBO;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw createServiceError(
      "DATA_CUSTOMER_MARKUP_KOBO is invalid.",
      "INVALID_DATA_MARKUP"
    );
  }

  return value;
}

function getMaxCustomerPriceKobo() {
  const raw = process.env.DATA_MAX_CUSTOMER_PRICE_KOBO;

  if (
    raw === undefined ||
    raw === null ||
    String(raw).trim() === ""
  ) {
    return DEFAULT_MAX_CUSTOMER_PRICE_KOBO;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createServiceError(
      "DATA_MAX_CUSTOMER_PRICE_KOBO is invalid.",
      "INVALID_DATA_PRICE_LIMIT"
    );
  }

  return value;
}

function calculateCustomerPriceKobo(providerPriceKobo) {
  const providerPrice = Number(providerPriceKobo);

  if (
    !Number.isSafeInteger(providerPrice) ||
    providerPrice <= 0
  ) {
    throw createServiceError(
      "Invalid provider data plan price.",
      "INVALID_PROVIDER_PLAN_PRICE"
    );
  }

  const markupKobo = getMarkupKobo();
  const customerPrice = providerPrice + markupKobo;
  const maxCustomerPrice = getMaxCustomerPriceKobo();

  if (
    !Number.isSafeInteger(customerPrice) ||
    customerPrice <= 0 ||
    customerPrice > maxCustomerPrice
  ) {
    throw createServiceError(
      "Data plan price is outside the allowed range.",
      "DATA_PRICE_OUT_OF_RANGE"
    );
  }

  return customerPrice;
}

function createReservationIdForData(uid, reference) {
  const hash = crypto
    .createHash("sha256")
    .update(`${uid}:${reference}`)
    .digest("hex");

  return `NPRES_${hash}`;
}

function createTransactionId(reservationId) {
  return `DATA_${reservationId}`;
}

function transactionRef(transactionId) {
  return db
    .collection(DATA_TRANSACTIONS_COLLECTION)
    .doc(transactionId);
}

function normalizeProviderStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeMoneyToKobo(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const numeric = Number(
    String(value)
      .replace(/,/g, "")
      .trim()
  );

  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  const kobo = Math.round(numeric * 100);

  return Number.isSafeInteger(kobo) ? kobo : null;
}

function normalizeComparablePhone(value) {
  const raw = String(value || "")
    .trim()
    .replace(/[\s()-]/g, "");

  if (!raw) {
    return null;
  }

  if (/^\+234[789]\d{9}$/.test(raw)) {
    return `0${raw.slice(4)}`;
  }

  if (/^234[789]\d{9}$/.test(raw)) {
    return `0${raw.slice(3)}`;
  }

  return raw;
}

function getProviderPlanId(response) {
  if (!response || typeof response !== "object") {
    return null;
  }

  const value =
    response.plan ??
    response.plan_id ??
    response.data_plan ??
    null;

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  return String(value).trim() || null;
}

function getProviderNetworkId(response) {
  if (!response || typeof response !== "object") {
    return null;
  }

  const value =
    response.network ??
    response.network_id ??
    null;

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  return String(value).trim() || null;
}

function getProviderPhone(response) {
  if (!response || typeof response !== "object") {
    return null;
  }

  const value =
    response.mobile_number ??
    response.phone ??
    response.phone_number ??
    null;

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  return String(value).trim() || null;
}

function getProviderPlanAmountKobo(response) {
  if (!response || typeof response !== "object") {
    return null;
  }

  return normalizeMoneyToKobo(
    response.plan_amount ??
      response.amount ??
      null
  );
}

function getProviderCustomerReference(response) {
  if (!response || typeof response !== "object") {
    return null;
  }

  const value =
    response.customer_ref ??
    response.customerReference ??
    null;

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  return String(value).trim() || null;
}

function verifyProviderSuccess({
  providerResult,
  transaction,
}) {
  if (
    !providerResult ||
    typeof providerResult !== "object"
  ) {
    return {
      verified: false,
      reason: "missing_provider_result",
    };
  }

  const response =
    providerResult.response;

  if (
    !response ||
    typeof response !== "object"
  ) {
    return {
      verified: false,
      reason: "missing_provider_response",
    };
  }

  const requestedPlanId =
    String(transaction.planId);

  const requestedNetworkId =
    String(transaction.networkId);

  const requestedPhone =
    normalizeComparablePhone(
      transaction.phoneNumber
    );

  const returnedPlanId =
    getProviderPlanId(response);

  const returnedNetworkId =
    getProviderNetworkId(response);

  const returnedPhone =
    normalizeComparablePhone(
      getProviderPhone(response)
    );

  const returnedPlanAmountKobo =
    getProviderPlanAmountKobo(response);

  const returnedCustomerReference =
    getProviderCustomerReference(response);

  if (
    returnedPlanId !== null &&
    returnedPlanId !== requestedPlanId
  ) {
    return {
      verified: false,
      reason: "provider_plan_mismatch",
    };
  }

  if (
    returnedNetworkId !== null &&
    returnedNetworkId !== requestedNetworkId
  ) {
    return {
      verified: false,
      reason: "provider_network_mismatch",
    };
  }

  if (
    returnedPhone !== null &&
    returnedPhone !== requestedPhone
  ) {
    return {
      verified: false,
      reason: "provider_phone_mismatch",
    };
  }

  if (
    returnedPlanAmountKobo !== null &&
    returnedPlanAmountKobo !==
      transaction.providerPriceKobo
  ) {
    return {
      verified: false,
      reason: "provider_amount_mismatch",
    };
  }

  if (
    providerResult.customerReference &&
    providerResult.customerReference !==
      transaction.reference
  ) {
    return {
      verified: false,
      reason:
        "provider_customer_reference_mismatch",
    };
  }

  if (
    returnedCustomerReference &&
    returnedCustomerReference !==
      transaction.reference
  ) {
    return {
      verified: false,
      reason:
        "provider_customer_reference_mismatch",
    };
  }

  if (
    !providerResult.providerReference
  ) {
    return {
      verified: false,
      reason: "missing_provider_reference",
    };
  }

  return {
    verified: true,
    reason: null,
  };
}

function normalizeProviderOutcome(providerResult) {
  if (
    !providerResult ||
    typeof providerResult !== "object"
  ) {
    return {
      outcome: STATUS_UNKNOWN,
      providerReference: null,
      customerReference: null,
    };
  }

  const rawOutcome =
    normalizeProviderStatus(
      providerResult.outcome
    );

  let outcome = rawOutcome;

  if (rawOutcome === "reversed") {
    outcome = STATUS_FAILED;
  }

  if (
    outcome !== STATUS_SUCCESSFUL &&
    outcome !== STATUS_PENDING &&
    outcome !== STATUS_FAILED &&
    outcome !== STATUS_UNKNOWN
  ) {
    outcome = STATUS_UNKNOWN;
  }

  return {
    outcome,
    providerReference:
      providerResult.providerReference ||
      null,
    customerReference:
      providerResult.customerReference ||
      null,
  };
}

function createSafeTransactionSnapshot(
  transaction
) {
  return {
    transactionId:
      transaction.transactionId,

    uid: transaction.uid,

    service:
      transaction.service,

    provider:
      transaction.provider,

    reference:
      transaction.reference,

    providerReference:
      transaction.providerReference ||
      null,

    networkId:
      transaction.networkId,

    networkName:
      transaction.networkName ||
      null,

    planId:
      transaction.planId,

    planCode:
      transaction.planCode ||
      null,

    planName:
      transaction.planName ||
      null,

    planType:
      transaction.planType ||
      null,

    validity:
      transaction.validity ||
      null,

    phoneNumber:
      transaction.phoneNumber,

    providerPriceKobo:
      transaction.providerPriceKobo,

    customerPriceKobo:
      transaction.customerPriceKobo,

    status:
      transaction.status,

    reconciliationRequired:
      Boolean(
        transaction.reconciliationRequired
      ),

    createdAt:
      transaction.createdAt,

    updatedAt:
      transaction.updatedAt,

    completedAt:
      transaction.completedAt ||
      null,

    failureCode:
      transaction.failureCode ||
      null,

    failureReason:
      transaction.failureReason ||
      null,
  };
}

async function getTransaction(
  transactionId
) {
  const id =
    String(transactionId || "").trim();

  if (
    !/^DATA_NPRES_[a-f0-9]{64}$/.test(id)
  ) {
    throw createServiceError(
      "Invalid data transaction ID.",
      "INVALID_DATA_TRANSACTION_ID"
    );
  }

  const snapshot =
    await transactionRef(id).get();

  if (!snapshot.exists) {
    throw createServiceError(
      "Data transaction not found.",
      "DATA_TRANSACTION_NOT_FOUND"
    );
  }

  return {
    transactionId:
      snapshot.id,
    ...snapshot.data(),
  };
}

async function createTransactionRecord(
  transaction
) {
  await transactionRef(
    transaction.transactionId
  ).create(transaction);

  return transaction;
}

async function updateTransaction(
  transactionId,
  updates
) {
  await transactionRef(
    transactionId
  ).update({
    ...updates,
    updatedAt:
      new Date().toISOString(),
  });
}

async function getLivePlan({
  planId,
  network,
  type,
}) {
  const normalizedPlanId =
    String(planId || "").trim();

  const normalizedNetwork =
    String(network || "").trim();

  const normalizedType =
    String(type || "")
      .trim()
      .toLowerCase();

  if (!normalizedPlanId) {
    throw createServiceError(
      "Data plan ID is required.",
      "INVALID_DATA_PLAN"
    );
  }

  if (!normalizedNetwork) {
    throw createServiceError(
      "Data network is required.",
      "INVALID_DATA_NETWORK"
    );
  }

  const plan =
    await getPlanById(
      normalizedPlanId,
      {
        network:
          normalizedNetwork,

        type:
          normalizedType ||
          undefined,

        forceRefresh: true,
      }
    );

  if (!plan) {
    throw createServiceError(
      "Selected data plan is no longer available.",
      "DATA_PLAN_NOT_AVAILABLE"
    );
  }

  if (
    String(plan.networkId) !==
    normalizedNetwork
  ) {
    throw createServiceError(
      "Selected data plan does not belong to the requested network.",
      "DATA_PLAN_NETWORK_MISMATCH"
    );
  }

  if (
    normalizedType &&
    String(plan.planType || "")
      .trim()
      .toLowerCase() !==
      normalizedType
  ) {
    throw createServiceError(
      "Selected data plan type is no longer available.",
      "DATA_PLAN_TYPE_MISMATCH"
    );
  }

  if (
    String(plan.status || "")
      .trim()
      .toLowerCase() !== "active"
  ) {
    throw createServiceError(
      "Selected data plan is no longer available.",
      "DATA_PLAN_NOT_ACTIVE"
    );
  }

  return plan;
}

async function recoverExistingTransaction({
  transactionId,
  uid,
  reference,
  network,
  phoneNumber,
  planId,
}) {
  let transaction;

  try {
    transaction =
      await getTransaction(transactionId);
  } catch (error) {
    if (
      error.code ===
      "DATA_TRANSACTION_NOT_FOUND"
    ) {
      return null;
    }

    throw error;
  }

  if (transaction.uid !== uid) {
    throw createServiceError(
      "Transaction ownership mismatch.",
      "DATA_TRANSACTION_OWNERSHIP_MISMATCH"
    );
  }

  if (
    transaction.reference !==
    reference
  ) {
    throw createServiceError(
      "Transaction reference mismatch.",
      "DATA_TRANSACTION_REFERENCE_MISMATCH"
    );
  }

  if (
    String(transaction.networkId) !==
    String(network)
  ) {
    throw createServiceError(
      "Existing transaction network does not match this purchase request.",
      "DATA_TRANSACTION_REQUEST_MISMATCH"
    );
  }

  if (
    String(transaction.planId) !==
    String(planId)
  ) {
    throw createServiceError(
      "Existing transaction plan does not match this purchase request.",
      "DATA_TRANSACTION_REQUEST_MISMATCH"
    );
  }

  if (
    normalizeComparablePhone(
      transaction.phoneNumber
    ) !==
    normalizeComparablePhone(
      phoneNumber
    )
  ) {
    throw createServiceError(
      "Existing transaction phone number does not match this purchase request.",
      "DATA_TRANSACTION_REQUEST_MISMATCH"
    );
  }

  return transaction;
}

async function ensureReservationOwnership({
  reservationId,
  uid,
}) {
  const reservation =
    await getReservation(
      reservationId
    );

  if (!reservation) {
    throw createServiceError(
      "Wallet reservation was not found.",
      "RESERVATION_NOT_FOUND"
    );
  }

  if (
    reservation.uid !== uid
  ) {
    throw createServiceError(
      "Reservation ownership mismatch.",
      "RESERVATION_OWNERSHIP_MISMATCH"
    );
  }

  return reservation;
}

async function purchaseData({
  uid,
  network,
  phoneNumber,
  planId,
  reference,
  type,
}) {
  const normalizedUid =
    validateUid(uid);

  const validation =
    validatePurchaseInput({
      network,
      phoneNumber,
      planId,
      reference,
    });

  const validatedNetwork =
    validation.network;

  const validatedPhone =
    validation.phoneNumber;

  const validatedPlanId =
    validation.planId;

  let validatedReference =
    normalizeReference(
      validation.reference
    );

  /*
   * The frontend normally supplies a unique reference.
   * If an older client omits it, generate one on the server.
   *
   * This keeps financial values server-controlled while allowing
   * legacy callers to continue functioning.
   */
  if (!validatedReference) {
    validatedReference =
      `DATA_${crypto
        .randomBytes(24)
        .toString("hex")}`;
  }

  const livePlan =
    await getLivePlan({
      planId:
        validatedPlanId,

      network:
        validatedNetwork,

      type,
    });

  const providerPriceKobo =
    Number(
      livePlan.providerPriceKobo
    );

  if (
    !Number.isSafeInteger(
      providerPriceKobo
    ) ||
    providerPriceKobo <= 0
  ) {
    throw createServiceError(
      "The selected data plan has an invalid price.",
      "INVALID_DATA_PLAN_PRICE"
    );
  }

  const customerPriceKobo =
    calculateCustomerPriceKobo(
      providerPriceKobo
    );

  const reservationId =
    createReservationIdForData(
      normalizedUid,
      validatedReference
    );

  const transactionId =
    createTransactionId(
      reservationId
    );

  const existingTransaction =
    await recoverExistingTransaction({
      transactionId,
      uid:
        normalizedUid,
      reference:
        validatedReference,
      network:
        validatedNetwork,
      phoneNumber:
        validatedPhone,
      planId:
        validatedPlanId,
    });

  if (existingTransaction) {
    return createSafeTransactionSnapshot(
      existingTransaction
    );
  }

  const reservation =
    await reserveFunds({
      uid:
        normalizedUid,

      amountKobo:
        customerPriceKobo,

      currency:
        CURRENCY,

      service:
        SERVICE_NAME,

      reference:
        validatedReference,
    });

  if (
    !reservation ||
    !reservation.id
  ) {
    throw createServiceError(
      "Unable to reserve wallet funds.",
      "RESERVATION_FAILED",
      {
        retryable: true,
      }
    );
  }

  if (
    reservation.id !==
    reservationId
  ) {
    throw createServiceError(
      "Wallet reservation identity mismatch.",
      "RESERVATION_IDENTITY_MISMATCH"
    );
  }

  const transaction = {
    transactionId,
    reservationId:
      reservation.id,

    uid:
      normalizedUid,

    service:
      SERVICE_NAME,

    provider:
      PROVIDER_NAME,

    reference:
      validatedReference,

    providerReference:
      null,

    networkId:
      validatedNetwork,

    networkName:
      livePlan.networkName ||
      null,

    planId:
      validatedPlanId,

    planCode:
      livePlan.planCode ||
      null,

    planName:
      livePlan.planName ||
      null,

    planType:
      livePlan.planType ||
      null,

    validity:
      livePlan.validity ||
      null,

    phoneNumber:
      validatedPhone,

    providerPriceKobo,

    customerPriceKobo,

    currency:
      CURRENCY,

    status:
      STATUS_PENDING,

    reconciliationRequired:
      false,

    createdAt:
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString(),

    completedAt:
      null,

    providerOutcome:
      null,

    providerCustomerReference:
      null,

    failureCode:
      null,

    failureReason:
      null,
  };

  try {
    await createTransactionRecord(
      transaction
    );
  } catch (error) {
    /*
     * Never assume the failed create means the reservation
     * disappeared. The wallet reservation remains authoritative.
     *
     * If the transaction was actually created despite the client
     * receiving an error, recover it and continue idempotently.
     */
    let recovered = null;

    try {
      recovered =
        await recoverExistingTransaction({
          transactionId,
          uid:
            normalizedUid,
          reference:
            validatedReference,
          network:
            validatedNetwork,
          phoneNumber:
            validatedPhone,
          planId:
            validatedPlanId,
        });
    } catch (recoveryError) {
      throw recoveryError;
    }

    if (recovered) {
      return createSafeTransactionSnapshot(
        recovered
      );
    }

    throw createServiceError(
      "Unable to create the data transaction record. The reserved wallet funds require reconciliation.",
      "DATA_TRANSACTION_RECORD_CREATE_FAILED",
      {
        retryable: true,
      }
    );
  }

  let providerResult;

  try {
    providerResult =
      await babspay.purchaseData({
        network:
          validatedNetwork,

        phoneNumber:
          validatedPhone,

        planId:
          validatedPlanId,

        reference:
          validatedReference,
      });
  } catch (error) {
    const failureCode =
      error.code ||
      "BABSPAY_REQUEST_ERROR";

    try {
      await updateTransaction(
        transactionId,
        {
          status:
            STATUS_UNKNOWN,

          reconciliationRequired:
            true,

          providerOutcome:
            STATUS_UNKNOWN,

          failureCode,

          failureReason:
            "The provider outcome could not be confirmed.",
        }
      );
    } catch {
      /*
       * Do not replace the original provider uncertainty with a
       * database-update error. The reservation remains locked and
       * requires reconciliation.
       */
    }

    return createSafeTransactionSnapshot({
      ...transaction,

      status:
        STATUS_UNKNOWN,

      reconciliationRequired:
        true,

      providerOutcome:
        STATUS_UNKNOWN,

      failureCode,

      failureReason:
        "The provider outcome could not be confirmed.",
    });
  }

  const providerOutcome =
    normalizeProviderOutcome(
      providerResult
    );

  if (
    providerOutcome.outcome ===
    STATUS_SUCCESSFUL
  ) {
    const verification =
      verifyProviderSuccess({
        providerResult,
        transaction,
      });

    if (!verification.verified) {
      await updateTransaction(
        transactionId,
        {
          status:
            STATUS_UNKNOWN,

          reconciliationRequired:
            true,

          providerReference:
            providerOutcome.providerReference,

          providerCustomerReference:
            providerOutcome.customerReference,

          providerOutcome:
            STATUS_UNKNOWN,

          failureCode:
            "BABSPAY_RESPONSE_VERIFICATION_FAILED",

          failureReason:
            verification.reason,
        }
      );

      return createSafeTransactionSnapshot({
        ...transaction,

        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        providerReference:
          providerOutcome.providerReference,

        providerCustomerReference:
          providerOutcome.customerReference,

        providerOutcome:
          STATUS_UNKNOWN,

        failureCode:
          "BABSPAY_RESPONSE_VERIFICATION_FAILED",

        failureReason:
          verification.reason,
      });
    }

    try {
      await ensureReservationOwnership({
        reservationId:
          reservation.id,

        uid:
          normalizedUid,
      });

      const committed =
        await commitReservation({
          uid:
            normalizedUid,

          reservationId:
            reservation.id,
        });

      const completedAt =
        committed.committedAt ||
        new Date().toISOString();

      await updateTransaction(
        transactionId,
        {
          status:
            STATUS_SUCCESSFUL,

          reconciliationRequired:
            false,

          providerReference:
            providerOutcome.providerReference,

          providerCustomerReference:
            providerOutcome.customerReference,

          providerOutcome:
            STATUS_SUCCESSFUL,

          failureCode:
            null,

          failureReason:
            null,

          completedAt,
        }
      );

      return createSafeTransactionSnapshot({
        ...transaction,

        status:
          STATUS_SUCCESSFUL,

        reconciliationRequired:
          false,

        providerReference:
          providerOutcome.providerReference,

        providerCustomerReference:
          providerOutcome.customerReference,

        providerOutcome:
          STATUS_SUCCESSFUL,

        completedAt,
      });
    } catch (error) {
      /*
       * Provider success is already established.
       *
       * We must NEVER release the reservation here merely because
       * wallet settlement or transaction updating encountered an
       * error. The reconciliation worker can safely determine
       * whether the reservation was already committed.
       */
      try {
        await updateTransaction(
          transactionId,
          {
            status:
              STATUS_UNKNOWN,

            reconciliationRequired:
              true,

            providerReference:
              providerOutcome.providerReference,

            providerCustomerReference:
              providerOutcome.customerReference,

            providerOutcome:
              STATUS_SUCCESSFUL,

            failureCode:
              error.code ||
              "WALLET_COMMIT_FAILED",

            failureReason:
              "Provider success was confirmed, but wallet settlement requires reconciliation.",
          }
        );
      } catch {
        /*
         * The reservation remains authoritative and locked/committed
         * according to the wallet transaction. Reconciliation can
         * recover the final transaction state.
         */
      }

      return createSafeTransactionSnapshot({
        ...transaction,

        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        providerReference:
          providerOutcome.providerReference,

        providerCustomerReference:
          providerOutcome.customerReference,

        providerOutcome:
          STATUS_SUCCESSFUL,

        failureCode:
          error.code ||
          "WALLET_COMMIT_FAILED",

        failureReason:
          "Provider success was confirmed, but wallet settlement requires reconciliation.",
      });
    }
  }

  if (
    providerOutcome.outcome ===
    STATUS_FAILED
  ) {
    try {
      await ensureReservationOwnership({
        reservationId:
          reservation.id,

        uid:
          normalizedUid,
      });

      await releaseReservation({
        uid:
          normalizedUid,

        reservationId:
          reservation.id,
      });

      const completedAt =
        new Date().toISOString();

      await updateTransaction(
        transactionId,
        {
          status:
            STATUS_FAILED,

          reconciliationRequired:
            false,

          providerReference:
            providerOutcome.providerReference,

          providerCustomerReference:
            providerOutcome.customerReference,

          providerOutcome:
            STATUS_FAILED,

          failureCode:
            "BABSPAY_TRANSACTION_FAILED",

          failureReason:
            "The data provider reported that the transaction failed.",

          completedAt,
        }
      );

      return createSafeTransactionSnapshot({
        ...transaction,

        status:
          STATUS_FAILED,

        reconciliationRequired:
          false,

        providerReference:
          providerOutcome.providerReference,

        providerCustomerReference:
          providerOutcome.customerReference,

        providerOutcome:
          STATUS_FAILED,

        failureCode:
          "BABSPAY_TRANSACTION_FAILED",

        failureReason:
          "The data provider reported that the transaction failed.",

        completedAt,
      });
    } catch (error) {
      try {
        await updateTransaction(
          transactionId,
          {
            status:
              STATUS_UNKNOWN,

            reconciliationRequired:
              true,

            providerReference:
              providerOutcome.providerReference,

            providerCustomerReference:
              providerOutcome.customerReference,

            providerOutcome:
              STATUS_FAILED,

            failureCode:
              error.code ||
              "WALLET_RELEASE_FAILED",

            failureReason:
              "Provider failure was received, but wallet release requires reconciliation.",
          }
        );
      } catch {
        /*
         * Preserve the reservation until reconciliation establishes
         * the final wallet state.
         */
      }

      return createSafeTransactionSnapshot({
        ...transaction,

        status:
          STATUS_UNKNOWN,

        reconciliationRequired:
          true,

        providerReference:
          providerOutcome.providerReference,

        providerCustomerReference:
          providerOutcome.customerReference,

        providerOutcome:
          STATUS_FAILED,

        failureCode:
          error.code ||
          "WALLET_RELEASE_FAILED",

        failureReason:
          "Provider failure was received, but wallet release requires reconciliation.",
      });
    }
  }

  /*
   * Pending and unknown are never treated as failures.
   *
   * The wallet reservation remains locked until reconciliation
   * obtains a definitive provider outcome.
   */
  const finalStatus =
    providerOutcome.outcome ===
    STATUS_PENDING
      ? STATUS_PENDING
      : STATUS_UNKNOWN;

  await updateTransaction(
    transactionId,
    {
      status:
        finalStatus,

      reconciliationRequired:
        true,

      providerReference:
        providerOutcome.providerReference,

      providerCustomerReference:
        providerOutcome.customerReference,

      providerOutcome:
        finalStatus,

      failureCode:
        null,

      failureReason:
        null,
    }
  );

  return createSafeTransactionSnapshot({
    ...transaction,

    status:
      finalStatus,

    reconciliationRequired:
      true,

    providerReference:
      providerOutcome.providerReference,

    providerCustomerReference:
      providerOutcome.customerReference,

    providerOutcome:
      finalStatus,
  });
}

async function getPurchaseStatus({
  uid,
  transactionId,
}) {
  const normalizedUid =
    validateUid(uid);

  const transaction =
    await getTransaction(
      transactionId
    );

  if (
    transaction.uid !==
    normalizedUid
  ) {
    throw createServiceError(
      "Transaction ownership mismatch.",
      "DATA_TRANSACTION_OWNERSHIP_MISMATCH"
    );
  }

  return createSafeTransactionSnapshot(
    transaction
  );
}

module.exports = {
  purchaseData,
  getPurchaseStatus,
  calculateCustomerPriceKobo,
};