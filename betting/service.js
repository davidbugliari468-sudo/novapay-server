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
  BETTING_SERVICES,
  isSupportedBettingServiceId,
  normalizeBettingServiceId,
  isValidBettingCustomerId,
  normalizeBettingCustomerId,
  isValidBettingAmountKobo,
  normalizeBettingProviderStatus,
  normalizeBettingProviderCode,
  isBettingDefiniteFailureCode,
  isBettingDefiniteFailureMessage,
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

const bettingTransactionsRef = db.collection("bettingTransactions");

function now() {
  return new Date();
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
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
  return bettingTransactionsRef.doc(transactionId);
}

async function getBettingTransaction(transactionId) {
  const normalizedId = normalizeString(transactionId);

  if (!normalizedId) {
    return null;
  }

  const snapshot = await getTransactionRef(normalizedId).get();

  if (!snapshot.exists) {
    return null;
  }

  return snapshot.data();
}

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
    throw new Error("Transaction does not belong to this user");
  }

  if (
    normalizeString(existingTransaction.provider) !==
    normalizeString(provider)
  ) {
    throw new Error("Transaction details do not match");
  }

  if (
    normalizeString(existingTransaction.customerId) !==
    normalizeString(customerId)
  ) {
    throw new Error("Transaction details do not match");
  }

  if (
    normalizeString(existingTransaction.serviceId) !==
    normalizeString(serviceId)
  ) {
    throw new Error("Transaction details do not match");
  }

  if (Number(existingTransaction.amountKobo) !== Number(amountKobo)) {
    throw new Error("Transaction details do not match");
  }
}

async function createTransaction({
  transactionId,
  uid,
  provider,
  customerId,
  serviceId,
  amountKobo,
}) {
  const ref = getTransactionRef(transactionId);
  const existingSnapshot = await ref.get();

  if (existingSnapshot.exists) {
    const existing = existingSnapshot.data();

    assertMatchingExistingTransaction(existing, {
      uid,
      provider,
      customerId,
      serviceId,
      amountKobo,
    });

    return existing;
  }

  const timestamp = now();

  const transaction = {
    id: transactionId,
    uid,

    service: SERVICE_NAME,
    provider,

    customerId,
    serviceId,

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

    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await ref.create(transaction);

  return transaction;
}

async function updateTransaction(transactionId, updates) {
  const ref = getTransactionRef(transactionId);

  await ref.update({
    ...updates,
    updatedAt: now(),
  });

  return getBettingTransaction(transactionId);
}

async function validateProviderResult(providerResult) {
  if (!providerResult || typeof providerResult !== "object") {
    return {
      outcome: "unknown",
      providerReference: "",
      providerRequestId: "",
      providerStatus: "",
      providerCode: "",
      message: "",
    };
  }

  const providerStatus = normalizeBettingProviderStatus(
    providerResult.providerStatus || providerResult.status
  );

  const providerCode = normalizeBettingProviderCode(
    providerResult.providerCode || providerResult.code
  );

  const message = normalizeString(
    providerResult.message ||
      providerResult.providerMessage
  );

  if (
    providerResult.outcome === "success"
  ) {
    return {
      outcome: "success",
      providerReference:
        normalizeString(providerResult.providerReference),
      providerRequestId:
        normalizeString(providerResult.providerRequestId),
      providerStatus,
      providerCode,
      message,
      amountKobo:
        providerResult.amountKobo ?? null,
    };
  }

  if (
    providerResult.outcome === "failure"
  ) {
    return {
      outcome: "failure",
      providerReference:
        normalizeString(providerResult.providerReference),
      providerRequestId:
        normalizeString(providerResult.providerRequestId),
      providerStatus,
      providerCode,
      message,
      amountKobo:
        providerResult.amountKobo ?? null,
    };
  }

  if (
    isBettingDefiniteFailureCode(providerCode) ||
    isBettingDefiniteFailureMessage(message)
  ) {
    return {
      outcome: "failure",
      providerReference:
        normalizeString(providerResult.providerReference),
      providerRequestId:
        normalizeString(providerResult.providerRequestId),
      providerStatus,
      providerCode,
      message,
      amountKobo:
        providerResult.amountKobo ?? null,
    };
  }

  return {
    outcome: "unknown",
    providerReference:
      normalizeString(providerResult.providerReference),
    providerRequestId:
      normalizeString(providerResult.providerRequestId),
    providerStatus,
    providerCode,
    message,
    amountKobo:
      providerResult.amountKobo ?? null,
  };
}

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

  return updateTransaction(transactionId, {
    status: STATUS_SUCCESSFUL,

    providerReference:
      normalizeString(providerResult.providerReference),

    providerRequestId:
      normalizeString(providerResult.providerRequestId),

    providerStatus:
      normalizeBettingProviderStatus(
        providerResult.providerStatus
      ),

    providerCode:
      normalizeBettingProviderCode(
        providerResult.providerCode
      ),

    providerMessage:
      normalizeString(providerResult.message),

    providerOutcome: "success",

    failureReason: "",

    reconciliationRequired: false,
  });
}

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

  return updateTransaction(transactionId, {
    status: STATUS_FAILED,

    providerReference:
      normalizeString(providerResult.providerReference),

    providerRequestId:
      normalizeString(providerResult.providerRequestId),

    providerStatus:
      normalizeBettingProviderStatus(
        providerResult.providerStatus
      ),

    providerCode:
      normalizeBettingProviderCode(
        providerResult.providerCode
      ),

    providerMessage:
      normalizeString(providerResult.message),

    providerOutcome: "failure",

    failureReason:
      normalizeString(providerResult.message) ||
      "Betting account funding was rejected",

    reconciliationRequired: false,
  });
}

async function handleUnknownBettingTransaction({
  transactionId,
  uid,
  reservationId,
  providerResult,
}) {
  const reservation = await getReservation(reservationId);

  if (!reservation) {
    throw new Error(
      "Betting transaction reservation could not be found"
    );
  }

  if (reservation.uid !== uid) {
    throw new Error(
      "Betting transaction reservation does not belong to this user"
    );
  }

  if (reservation.status === "committed") {
    return updateTransaction(transactionId, {
      status: STATUS_SUCCESSFUL,

      providerReference:
        normalizeString(providerResult.providerReference),

      providerRequestId:
        normalizeString(providerResult.providerRequestId),

      providerStatus:
        normalizeBettingProviderStatus(
          providerResult.providerStatus
        ),

      providerCode:
        normalizeBettingProviderCode(
          providerResult.providerCode
        ),

      providerMessage:
        normalizeString(providerResult.message),

      providerOutcome: "success",

      failureReason: "",

      reconciliationRequired: false,
    });
  }

  if (reservation.status === "released") {
    return updateTransaction(transactionId, {
      status: STATUS_FAILED,

      providerReference:
        normalizeString(providerResult.providerReference),

      providerRequestId:
        normalizeString(providerResult.providerRequestId),

      providerStatus:
        normalizeBettingProviderStatus(
          providerResult.providerStatus
        ),

      providerCode:
        normalizeBettingProviderCode(
          providerResult.providerCode
        ),

      providerMessage:
        normalizeString(providerResult.message),

      providerOutcome: "failure",

      failureReason:
        normalizeString(providerResult.message) ||
        "Betting transaction failed",

      reconciliationRequired: false,
    });
  }

  return updateTransaction(transactionId, {
    status: STATUS_PENDING,

    providerReference:
      normalizeString(providerResult.providerReference),

    providerRequestId:
      normalizeString(providerResult.providerRequestId),

    providerStatus:
      normalizeBettingProviderStatus(
        providerResult.providerStatus
      ),

    providerCode:
      normalizeBettingProviderCode(
        providerResult.providerCode
      ),

    providerMessage:
      normalizeString(providerResult.message),

    providerOutcome: "unknown",

    failureReason: "",

    reconciliationRequired: true,
  });
}

async function verifyBettingCustomer({
  providerClient,
  customerId,
  serviceId,
}) {
  if (
    !providerClient ||
    typeof providerClient.verifyBettingCustomer !== "function"
  ) {
    throw new Error(
      "Betting provider verification client is unavailable"
    );
  }

  const normalizedCustomerId =
    normalizeBettingCustomerId(customerId);

  const normalizedServiceId =
    normalizeBettingServiceId(serviceId);

  if (!isValidBettingCustomerId(normalizedCustomerId)) {
    throw new Error("Invalid betting customer ID");
  }

  if (
    !normalizedServiceId ||
    !isSupportedBettingServiceId(normalizedServiceId)
  ) {
    throw new Error("Unsupported betting service");
  }

  try {
    const result =
      await providerClient.verifyBettingCustomer({
        customerId: normalizedCustomerId,
        serviceId: normalizedServiceId,
      });

    if (!result || result.outcome !== "success") {
      throw new Error(
        result?.message ||
          "Unable to verify the betting customer"
      );
    }

    return {
      outcome: "success",

      customerId:
        normalizeBettingCustomerId(
          result.customerId || normalizedCustomerId
        ),

      requestedCustomerId:
        normalizedCustomerId,

      serviceId:
        normalizedServiceId,

      customerName:
        normalizeString(result.customerName),

      balance:
        result.balance ?? null,

      providerReference:
        normalizeString(result.providerReference),

      providerStatus:
        normalizeBettingProviderStatus(
          result.providerStatus
        ),

      providerCode:
        normalizeBettingProviderCode(
          result.providerCode
        ),

      message:
        normalizeString(result.message),
    };
  } catch (error) {
    throw error;
  }
}

async function purchaseBettingAccount({
  uid,
  provider = DEFAULT_PROVIDER,
  customerId,
  serviceId,
  amountKobo,
  transactionId,
  providerClient,
}) {
  const normalizedUid = requireUid(uid);

  const validated = validateBettingRequest({
    provider,
    customerId,
    serviceId,
    amountKobo,
    transactionId,
  });

  const normalizedProvider =
    normalizeString(validated.provider) ||
    DEFAULT_PROVIDER;

  const normalizedCustomerId =
    normalizeBettingCustomerId(
      validated.customerId
    );

  const normalizedServiceId =
    normalizeBettingServiceId(
      validated.serviceId
    );

  const normalizedAmountKobo =
    Number(validated.amountKobo);

  if (
    !isSupportedBettingServiceId(
      normalizedServiceId
    )
  ) {
    throw new Error("Unsupported betting service");
  }

  if (
    !isValidBettingCustomerId(
      normalizedCustomerId
    )
  ) {
    throw new Error("Invalid betting customer ID");
  }

  if (
    !isValidBettingAmountKobo(
      normalizedAmountKobo
    )
  ) {
    throw new Error("Invalid betting amount");
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
    normalizeString(transactionId) ||
    createTransactionId();

  let transaction =
    await createTransaction({
      transactionId: id,
      uid: normalizedUid,
      provider: normalizedProvider,
      customerId: normalizedCustomerId,
      serviceId: normalizedServiceId,
      amountKobo: normalizedAmountKobo,
    });

  if (
    transaction.status === STATUS_SUCCESSFUL ||
    transaction.status === STATUS_FAILED
  ) {
    return transaction;
  }

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

    if (
      existingReservation.status ===
      "committed"
    ) {
      return updateTransaction(id, {
        status: STATUS_SUCCESSFUL,
        providerOutcome: "success",
        reconciliationRequired: false,
      });
    }

    if (
      existingReservation.status ===
      "released"
    ) {
      return updateTransaction(id, {
        status: STATUS_FAILED,
        providerOutcome: "failure",
        reconciliationRequired: false,
        failureReason:
          transaction.failureReason ||
          "Betting transaction failed",
      });
    }

    return transaction;
  }

  const reservation =
    await reserveFunds({
      uid: normalizedUid,
      amountKobo: normalizedAmountKobo,
      reference: id,
      service: SERVICE_NAME,
    });

  transaction =
    await updateTransaction(id, {
      reservationId: reservation.id,
    });

  let providerResult;

  try {
    providerResult =
      await providerClient.fundBettingAccount({
        transactionId: id,
        customerId: normalizedCustomerId,
        serviceId: normalizedServiceId,
        amountKobo: normalizedAmountKobo,
      });
  } catch (error) {
    return handleUnknownBettingTransaction({
      transactionId: id,
      uid: normalizedUid,
      reservationId: reservation.id,
      providerResult: {
        outcome: "unknown",
        providerReference: "",
        providerRequestId: "",
        providerStatus: "",
        providerCode: "",
        message:
          error?.message ||
          "Unable to determine the VTU.ng betting transaction result",
      },
    });
  }

  const normalizedProviderResult =
    await validateProviderResult(
      providerResult
    );

  if (
    normalizedProviderResult.outcome ===
    "success"
  ) {
    return handleSuccessfulBettingTransaction({
      transactionId: id,
      uid: normalizedUid,
      reservationId: reservation.id,
      providerResult:
        normalizedProviderResult,
    });
  }

  if (
    normalizedProviderResult.outcome ===
    "failure"
  ) {
    return handleFailedBettingTransaction({
      transactionId: id,
      uid: normalizedUid,
      reservationId: reservation.id,
      providerResult:
        normalizedProviderResult,
    });
  }

  return handleUnknownBettingTransaction({
    transactionId: id,
    uid: normalizedUid,
    reservationId: reservation.id,
    providerResult:
      normalizedProviderResult,
  });
}

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