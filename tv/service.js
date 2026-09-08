"use strict";

const crypto = require("crypto");

const db = require("../firebase-admin");

const {
  reserveFunds,
  getReservation,
  commitReservation,
  releaseReservation,
} = require("../wallet/reservation");

const {
  TV_PROVIDER_LIMITS,
  isSupportedTvServiceId,
  normalizeTvServiceId,
  isValidTvCustomerId,
  normalizeTvCustomerId,
  isValidTvVariationId,
  normalizeTvVariationId,
  isValidTvAmountKobo,
  normalizeTvProviderStatus,
  normalizeTvProviderCode,
  isTvDefiniteFailureCode,
  isTvDefiniteFailureMessage,
} = require("./constants");

const COLLECTION = "tvTransactions";

const SERVICE = "tv";
const CURRENCY = "NGN";

const STATUS_PENDING = "pending";
const STATUS_SUCCESSFUL = "successful";
const STATUS_FAILED = "failed";

const OUTCOME_SUCCESS = "success";
const OUTCOME_FAILURE = "failure";
const OUTCOME_UNKNOWN = "unknown";

const RECONCILIATION_REQUIRED = true;

function transactionRef(transactionId) {
  return db.collection(COLLECTION).doc(transactionId);
}

function normalizeProvider(provider) {
  const normalized = normalizeTvServiceId(provider);

  if (!isSupportedTvServiceId(normalized)) {
    throw new Error("Unsupported TV provider");
  }

  return normalized;
}

function normalizeCustomerId(customerId) {
  const normalized = normalizeTvCustomerId(customerId);

  if (!isValidTvCustomerId(normalized)) {
    throw new Error(
      "Invalid customer or smartcard number"
    );
  }

  return normalized;
}

function normalizeServiceId(serviceId) {
  const normalized = normalizeTvServiceId(serviceId);

  if (!isSupportedTvServiceId(normalized)) {
    throw new Error("Invalid TV service ID");
  }

  return normalized;
}

function normalizeVariationId(variationId) {
  const normalized = normalizeTvVariationId(variationId);

  if (!isValidTvVariationId(normalized)) {
    throw new Error("Invalid TV variation");
  }

  return normalized;
}

function normalizeAmountKobo(amountKobo) {
  if (!isValidTvAmountKobo(amountKobo)) {
    throw new Error("Invalid TV purchase amount");
  }

  return Number(amountKobo);
}

function normalizeSubscriptionType(subscriptionType) {
  if (
    subscriptionType === undefined ||
    subscriptionType === null ||
    subscriptionType === ""
  ) {
    return "change";
  }

  if (typeof subscriptionType !== "string") {
    throw new Error("Invalid subscription type");
  }

  const normalized = subscriptionType
    .trim()
    .toLowerCase();

  if (
    normalized !== "change" &&
    normalized !== "renew"
  ) {
    throw new Error("Invalid subscription type");
  }

  return normalized;
}

function generateTransactionId() {
  return (
    "NPTV_" +
    Date.now() +
    "_" +
    crypto.randomBytes(16).toString("hex")
  );
}

function requireUid(uid) {
  if (
    typeof uid !== "string" ||
    uid.trim().length === 0
  ) {
    throw new Error("User authentication required");
  }

  return uid.trim();
}

function requireProviderClient(providerClient) {
  if (
    !providerClient ||
    typeof providerClient !== "object"
  ) {
    throw new Error("TV provider client is required");
  }

  return providerClient;
}

function normalizeProviderOutcome(providerResult) {
  if (!providerResult || typeof providerResult !== "object") {
    return {
      outcome: OUTCOME_UNKNOWN,
      providerOutcome: providerResult ?? null,
    };
  }

  const status = normalizeTvProviderStatus(
    providerResult.providerStatus ??
      providerResult.status ??
      providerResult.data?.status
  );

  const code = normalizeTvProviderCode(
    providerResult.providerCode ??
      providerResult.code ??
      providerResult.data?.code
  );

  const message =
    providerResult.message ??
    providerResult.providerMessage ??
    providerResult.data?.message ??
    "";

  if (
    providerResult.outcome === OUTCOME_SUCCESS ||
    providerResult.success === true ||
    status === "completed-api"
  ) {
    return {
      outcome: OUTCOME_SUCCESS,
      providerStatus: status,
      providerCode: code,
      message,
      providerOutcome: providerResult,
    };
  }

  if (
    providerResult.outcome === OUTCOME_FAILURE ||
    status === "failed" ||
    status === "refunded" ||
    status === "cancelled" ||
    isTvDefiniteFailureCode(code) ||
    isTvDefiniteFailureMessage(message)
  ) {
    return {
      outcome: OUTCOME_FAILURE,
      providerStatus: status,
      providerCode: code,
      message,
      providerOutcome: providerResult,
    };
  }

  return {
    outcome: OUTCOME_UNKNOWN,
    providerStatus: status,
    providerCode: code,
    message,
    providerOutcome: providerResult,
  };
}

async function createTransaction({
  transactionId,
  uid,
  provider,
  customerId,
  serviceId,
  variationId,
  amountKobo,
  subscriptionType,
}) {
  const ref = transactionRef(transactionId);

  const existing = await ref.get();

  if (existing.exists) {
    const existingData = existing.data();

    if (
      existingData.uid !== uid ||
      existingData.provider !== provider ||
      existingData.customerId !== customerId ||
      existingData.serviceId !== serviceId ||
      existingData.variationId !== variationId ||
      Number(existingData.amountKobo) !== amountKobo ||
      existingData.subscriptionType !== subscriptionType
    ) {
      throw new Error(
        "Transaction ID is already associated with different transaction details"
      );
    }

    return {
      ...existingData,
      id: transactionId,
    };
  }

  const now = new Date();

  const transaction = {
    id: transactionId,
    uid,
    service: SERVICE,

    provider,

    customerId,
    serviceId,
    variationId,
    subscriptionType,

    amountKobo,
    currency: CURRENCY,

    status: STATUS_PENDING,

    providerReference: null,
    providerRequestId: null,
    providerStatus: null,
    providerCode: null,
    providerMessage: null,

    costKobo: 0,
    gainKobo: 0,
    rewardPoints: 0,

    reservationId: null,

    providerOutcome: null,

    failureReason: "",

    reconciliationRequired: false,

    createdAt: now,
    updatedAt: now,
  };

  await ref.create(transaction);

  return transaction;
}

async function updateTransaction(
  transactionId,
  updates
) {
  await transactionRef(transactionId).update({
    ...updates,
    updatedAt: new Date(),
  });
}

async function linkReservation(
  transactionId,
  reservationId
) {
  await updateTransaction(transactionId, {
    reservationId,
  });
}

async function handleSuccessfulPurchase({
  transaction,
  providerResult,
  providerOutcome,
}) {
  if (!transaction.reservationId) {
    throw new Error(
      "Successful TV transaction has no reservation"
    );
  }

  await commitReservation({
    uid: transaction.uid,
    reservationId: transaction.reservationId,
  });

  await updateTransaction(transaction.id, {
    status: STATUS_SUCCESSFUL,

    providerReference:
      providerResult.providerReference ??
      providerResult.reference ??
      null,

    providerRequestId:
      providerResult.providerRequestId ??
      providerResult.requestId ??
      null,

    providerStatus:
      providerOutcome.providerStatus ?? null,

    providerCode:
      providerOutcome.providerCode ?? null,

    providerMessage:
      providerOutcome.message ?? null,

    costKobo:
      Number(
        providerResult.costKobo ??
          providerResult.cost ??
          0
      ),

    gainKobo:
      Number(
        providerResult.gainKobo ??
          providerResult.gain ??
          0
      ),

    providerOutcome:
      providerOutcome.providerOutcome,

    failureReason: "",

    reconciliationRequired: false,
  });

  return {
    ...transaction,
    status: STATUS_SUCCESSFUL,
    reservationId: transaction.reservationId,
    providerReference:
      providerResult.providerReference ??
      providerResult.reference ??
      null,
  };
}

async function handleFailedPurchase({
  transaction,
  providerResult,
  providerOutcome,
}) {
  if (transaction.reservationId) {
    await releaseReservation({
      uid: transaction.uid,
      reservationId: transaction.reservationId,
    });
  }

  await updateTransaction(transaction.id, {
    status: STATUS_FAILED,

    providerReference:
      providerResult.providerReference ??
      providerResult.reference ??
      null,

    providerRequestId:
      providerResult.providerRequestId ??
      providerResult.requestId ??
      null,

    providerStatus:
      providerOutcome.providerStatus ?? null,

    providerCode:
      providerOutcome.providerCode ?? null,

    providerMessage:
      providerOutcome.message ?? null,

    providerOutcome:
      providerOutcome.providerOutcome,

    failureReason:
      providerOutcome.message ||
      "TV provider rejected the transaction",

    reconciliationRequired: false,
  });

  return {
    ...transaction,
    status: STATUS_FAILED,
    reservationId: transaction.reservationId,
    failureReason:
      providerOutcome.message ||
      "TV provider rejected the transaction",
  };
}

async function handleUnknownPurchase({
  transaction,
  providerResult,
  providerOutcome,
}) {
  if (transaction.reservationId) {
    const reservation = await getReservation(
      transaction.reservationId
    );

    if (!reservation) {
      throw new Error(
        "TV transaction reservation could not be found"
      );
    }

    if (reservation.uid !== transaction.uid) {
      throw new Error(
        "TV transaction reservation ownership mismatch"
      );
    }

    if (reservation.status === "committed") {
      await updateTransaction(transaction.id, {
        status: STATUS_SUCCESSFUL,

        providerReference:
          providerResult.providerReference ??
          providerResult.reference ??
          null,

        providerRequestId:
          providerResult.providerRequestId ??
          providerResult.requestId ??
          null,

        providerStatus:
          providerOutcome.providerStatus ?? null,

        providerCode:
          providerOutcome.providerCode ?? null,

        providerMessage:
          providerOutcome.message ?? null,

        providerOutcome:
          providerOutcome.providerOutcome,

        reconciliationRequired: false,
      });

      return {
        ...transaction,
        status: STATUS_SUCCESSFUL,
      };
    }

    if (reservation.status === "released") {
      throw new Error(
        "TV transaction has an already released reservation"
      );
    }
  }

  await updateTransaction(transaction.id, {
    status: STATUS_PENDING,

    providerReference:
      providerResult.providerReference ??
      providerResult.reference ??
      null,

    providerRequestId:
      providerResult.providerRequestId ??
      providerResult.requestId ??
      null,

    providerStatus:
      providerOutcome.providerStatus ?? null,

    providerCode:
      providerOutcome.providerCode ?? null,

    providerMessage:
      providerOutcome.message ?? null,

    providerOutcome:
      providerOutcome.providerOutcome,

    reconciliationRequired:
      RECONCILIATION_REQUIRED,

    failureReason: "",
  });

  return {
    ...transaction,
    status: STATUS_PENDING,
    reconciliationRequired:
      RECONCILIATION_REQUIRED,
  };
}

/**
 * Verify a TV customer/smartcard.
 *
 * This operation does NOT reserve funds, commit funds,
 * release funds, or create a financial transaction.
 */
async function verifyTvCustomer({
  uid,
  provider,
  customerId,
  providerClient,
}) {
  requireUid(uid);

  const client =
    requireProviderClient(providerClient);

  const normalizedProvider =
    normalizeProvider(provider);

  const normalizedCustomerId =
    normalizeCustomerId(customerId);

  if (
    typeof client.verifyTvCustomer !==
    "function"
  ) {
    throw new Error(
      "TV provider verification is not available"
    );
  }

  try {
    const result =
      await client.verifyTvCustomer({
        customerId:
          normalizedCustomerId,

        serviceId:
          normalizedProvider,
      });

    return {
      outcome:
        result?.outcome ??
        OUTCOME_SUCCESS,

      provider:
        normalizedProvider,

      customerId:
        normalizedCustomerId,

      serviceId:
        normalizedProvider,

      customerName:
        result?.customerName ??
        result?.name ??
        result?.data?.customerName ??
        result?.data?.name ??
        null,

      address:
        result?.address ??
        result?.customerAddress ??
        result?.data?.address ??
        null,

      balance:
        result?.balance ??
        result?.data?.balance ??
        null,

      providerReference:
        result?.providerReference ??
        result?.reference ??
        null,

      providerStatus:
        result?.providerStatus ??
        result?.status ??
        null,

      providerCode:
        result?.providerCode ??
        result?.code ??
        null,

      message:
        result?.message ??
        null,

      providerOutcome:
        result ?? null,
    };
  } catch (error) {
    /*
     * Verification has no wallet side effects.
     *
     * Provider/network ambiguity is returned as unknown
     * rather than being interpreted as a successful customer
     * verification.
     */
    return {
      outcome: OUTCOME_UNKNOWN,

      provider:
        normalizedProvider,

      customerId:
        normalizedCustomerId,

      serviceId:
        normalizedProvider,

      customerName: null,
      address: null,
      balance: null,

      providerReference: null,
      providerStatus: null,
      providerCode:
        error?.code ?? null,

      message:
        error?.message ??
        "Unable to verify TV customer",

      providerOutcome: null,
    };
  }
}

async function purchaseTv({
  uid,
  provider,
  customerId,
  serviceId,
  variationId,
  amountKobo,
  subscriptionType,
  transactionId,
  providerClient,
}) {
  const normalizedUid = requireUid(uid);

  const client =
    requireProviderClient(providerClient);

  const normalizedProvider =
    normalizeProvider(provider);

  const normalizedCustomerId =
    normalizeCustomerId(customerId);

  const normalizedServiceId =
    normalizeServiceId(serviceId);

  if (
    normalizedProvider !==
    normalizedServiceId
  ) {
    throw new Error(
      "TV service does not match provider"
    );
  }

  const normalizedVariationId =
    normalizeVariationId(variationId);

  const normalizedAmountKobo =
    normalizeAmountKobo(amountKobo);

  const normalizedSubscriptionType =
    normalizeSubscriptionType(
      subscriptionType
    );

  let normalizedTransactionId =
    transactionId;

  if (
    normalizedTransactionId !==
      undefined &&
    normalizedTransactionId !== null
  ) {
    if (
      typeof normalizedTransactionId !==
      "string"
    ) {
      throw new Error(
        "Invalid transaction ID"
      );
    }

    normalizedTransactionId =
      normalizedTransactionId.trim();

    if (
      normalizedTransactionId.length <
        10 ||
      normalizedTransactionId.length >
        120 ||
      !/^[A-Za-z0-9_-]+$/.test(
        normalizedTransactionId
      )
    ) {
      throw new Error(
        "Invalid transaction ID"
      );
    }
  } else {
    normalizedTransactionId =
      generateTransactionId();
  }

  const transaction =
    await createTransaction({
      transactionId:
        normalizedTransactionId,

      uid: normalizedUid,

      provider:
        normalizedProvider,

      customerId:
        normalizedCustomerId,

      serviceId:
        normalizedServiceId,

      variationId:
        normalizedVariationId,

      amountKobo:
        normalizedAmountKobo,

      subscriptionType:
        normalizedSubscriptionType,
    });

  /*
   * Idempotency:
   *
   * Never submit another provider purchase when the
   * transaction has already reached a terminal state.
   */
  if (
    transaction.status ===
    STATUS_SUCCESSFUL
  ) {
    return transaction;
  }

  if (
    transaction.status ===
    STATUS_FAILED
  ) {
    return transaction;
  }

  /*
   * If this transaction already has a reservation,
   * do not reserve again and do not submit another
   * provider purchase.
   *
   * This protects against duplicate requests after
   * a reservation was already created.
   */
  if (transaction.reservationId) {
    return {
      ...transaction,
      status:
        transaction.status ||
        STATUS_PENDING,
      reconciliationRequired:
        transaction.reconciliationRequired ||
        false,
    };
  }

  /*
   * Reserve customer funds BEFORE calling the provider.
   */
  const reservation =
    await reserveFunds({
      uid: normalizedUid,
      amountKobo:
        normalizedAmountKobo,
      reference:
        normalizedTransactionId,
      service: SERVICE,
    });

  await linkReservation(
    normalizedTransactionId,
    reservation.id
  );

  const linkedTransaction = {
    ...transaction,
    reservationId:
      reservation.id,
  };

  let providerResult;

  try {
    providerResult =
      await client.purchaseTv({
        transactionId:
          normalizedTransactionId,

        customerId:
          normalizedCustomerId,

        serviceId:
          normalizedServiceId,

        variationId:
          normalizedVariationId,

        amountKobo:
          normalizedAmountKobo,

        subscriptionType:
          normalizedSubscriptionType,
      });
  } catch (error) {
    /*
     * Provider/network ambiguity:
     *
     * DO NOT release the reservation.
     *
     * The provider may have received and completed
     * the purchase even though our request failed.
     */
    await updateTransaction(
      normalizedTransactionId,
      {
        status: STATUS_PENDING,

        providerReference:
          error?.providerReference ??
          null,

        providerRequestId:
          error?.providerRequestId ??
          null,

        providerStatus:
          error?.providerStatus ??
          null,

        providerCode:
          error?.code ??
          null,

        providerMessage:
          error?.message ??
          "TV provider request outcome is unknown",

        providerOutcome: null,

        reconciliationRequired:
          RECONCILIATION_REQUIRED,

        failureReason: "",
      }
    );

    return {
      ...linkedTransaction,

      status: STATUS_PENDING,

      reconciliationRequired:
        RECONCILIATION_REQUIRED,

      providerStatus:
        error?.providerStatus ??
        null,

      providerCode:
        error?.code ??
        null,

      providerMessage:
        error?.message ??
        "TV provider request outcome is unknown",
    };
  }

  const providerOutcome =
    normalizeProviderOutcome(
      providerResult
    );

  if (
    providerOutcome.outcome ===
    OUTCOME_SUCCESS
  ) {
    return handleSuccessfulPurchase({
      transaction:
        linkedTransaction,

      providerResult,

      providerOutcome,
    });
  }

  if (
    providerOutcome.outcome ===
    OUTCOME_FAILURE
  ) {
    return handleFailedPurchase({
      transaction:
        linkedTransaction,

      providerResult,

      providerOutcome,
    });
  }

  return handleUnknownPurchase({
    transaction:
      linkedTransaction,

    providerResult,

    providerOutcome,
  });
}

async function getTvTransaction(
  transactionId
) {
  if (
    typeof transactionId !== "string" ||
    transactionId.trim().length === 0
  ) {
    throw new Error(
      "Invalid transaction ID"
    );
  }

  const ref =
    transactionRef(
      transactionId.trim()
    );

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    ...snapshot.data(),
    id: snapshot.id,
  };
}

module.exports = {
  purchaseTv,
  verifyTvCustomer,
  getTvTransaction,

  STATUS_PENDING,
  STATUS_SUCCESSFUL,
  STATUS_FAILED,

  OUTCOME_SUCCESS,
  OUTCOME_FAILURE,
  OUTCOME_UNKNOWN,

  TV_PROVIDER_LIMITS,
};