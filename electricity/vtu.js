"use strict";

const {
  getAccessToken,
  clearAccessToken,
  VtuProviderError,
} = require("../airtime/vtu");

const {
  ELECTRICITY_LIMITS,
  ELECTRICITY_INPUT_LIMITS,
  isSupportedElectricityServiceId,
  isSupportedMeterType,
} = require("./constants");

const VTU_BASE_URL =
  String(
    process.env.VTU_BASE_URL ||
      "https://vtu.ng/wp-json"
  )
    .trim()
    .replace(/\/+$/, "");

const VTU_API_URL =
  `${VTU_BASE_URL}/api/v2`;

const configuredTimeout =
  Number(
    process.env.VTU_REQUEST_TIMEOUT_MS
  );

const VTU_REQUEST_TIMEOUT_MS =
  Number.isSafeInteger(
    configuredTimeout
  ) &&
  configuredTimeout > 0
    ? configuredTimeout
    : 15000;

function normalizeString(
  value
) {
  return String(
    value ?? ""
  ).trim();
}

function requireTransactionId(
  transactionId
) {
  const value =
    normalizeString(
      transactionId
    );

  if (!value) {
    throw new VtuProviderError(
      "Transaction ID is required.",
      {
        kind: "validation",
      }
    );
  }

  if (value.length > 200) {
    throw new VtuProviderError(
      "Transaction ID is too long.",
      {
        kind: "validation",
      }
    );
  }

  return value;
}

function validateServiceId(
  serviceId
) {
  const value =
    normalizeString(
      serviceId
    ).toLowerCase();

  if (
    !isSupportedElectricityServiceId(
      value
    )
  ) {
    throw new VtuProviderError(
      "Unsupported electricity distribution company.",
      {
        kind: "validation",
        providerCode:
          "invalid_service_id",
      }
    );
  }

  return value;
}

function validateMeterType(
  meterType
) {
  const value =
    normalizeString(
      meterType
    ).toLowerCase();

  if (
    !isSupportedMeterType(
      value
    )
  ) {
    throw new VtuProviderError(
      "Invalid electricity meter type.",
      {
        kind: "validation",
        providerCode:
          "invalid_variation_id",
      }
    );
  }

  return value;
}

function validateCustomerId(
  customerId
) {
  const value =
    normalizeString(
      customerId
    );

  if (!value) {
    throw new VtuProviderError(
      "Electricity meter number is required.",
      {
        kind: "validation",
      }
    );
  }

  if (
    value.length <
      ELECTRICITY_INPUT_LIMITS
        .METER_NUMBER_MIN_LENGTH ||
    value.length >
      ELECTRICITY_INPUT_LIMITS
        .METER_NUMBER_MAX_LENGTH
  ) {
    throw new VtuProviderError(
      "Invalid electricity meter number.",
      {
        kind: "validation",
      }
    );
  }

  /*
   * Meter/account identifiers can differ by provider,
   * so we deliberately do not force a numeric-only rule here.
   * The provider remains authoritative during verification.
   */
  if (
    !/^[A-Za-z0-9._:/-]+$/.test(
      value
    )
  ) {
    throw new VtuProviderError(
      "Invalid electricity meter number.",
      {
        kind: "validation",
      }
    );
  }

  return value;
}

function validateAmountKobo(
  amountKobo
) {
  const value =
    Number(
      amountKobo
    );

  if (
    !Number.isSafeInteger(
      value
    ) ||
    value <= 0
  ) {
    throw new VtuProviderError(
      "Invalid electricity purchase amount.",
      {
        kind: "validation",
      }
    );
  }

  if (
    value >
    ELECTRICITY_LIMITS
      .MAX_AMOUNT_KOBO
  ) {
    throw new VtuProviderError(
      "Electricity purchase amount exceeds the maximum allowed amount.",
      {
        kind: "validation",
      }
    );
  }

  /*
   * NovaPay wallet amounts are stored in kobo.
   * VTU.ng electricity accepts whole NGN amounts.
   */
  if (
    value % 100 !== 0
  ) {
    throw new VtuProviderError(
      "Electricity purchase amount must be a whole-naira amount.",
      {
        kind: "validation",
      }
    );
  }

  return value;
}

function createProviderRequestId(
  transactionId
) {
  const normalized =
    requireTransactionId(
      transactionId
    );

  /*
   * VTU.ng allows request_id up to 50 characters.
   *
   * The transaction ID is hashed so the provider request
   * identifier is deterministic, short, and safe to reuse
   * during reconciliation without creating a new purchase.
   */
  const crypto =
    require("crypto");

  return (
    "NPE" +
    crypto
      .createHash(
        "sha256"
      )
      .update(
        normalized,
        "utf8"
      )
      .digest(
        "hex"
      )
      .slice(
        0,
        47
      )
  );
}

async function fetchWithTimeout(
  url,
  options = {}
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      VTU_REQUEST_TIMEOUT_MS
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal,
      }
    );
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      throw new VtuProviderError(
        "VTU.ng electricity request timed out.",
        {
          kind: "timeout",
        }
      );
    }

    throw new VtuProviderError(
      "Unable to reach VTU.ng.",
      {
        kind: "network",
        rawMessage:
          String(
            error?.message ||
              ""
          ).slice(
            0,
            300
          ),
      }
    );
  } finally {
    clearTimeout(
      timeout
    );
  }
}

async function parseJsonResponse(
  response
) {
  const text =
    await response.text();

  if (
    !text.trim()
  ) {
    throw new VtuProviderError(
      "VTU.ng returned an empty response.",
      {
        kind: "unknown",
        httpStatus:
          response.status,
      }
    );
  }

  try {
    return JSON.parse(
      text
    );
  } catch {
    throw new VtuProviderError(
      "VTU.ng returned an invalid response.",
      {
        kind: "unknown",
        httpStatus:
          response.status,
        rawMessage:
          text.slice(
            0,
            300
          ),
      }
    );
  }
}

async function authenticatedRequest(
  path,
  {
    method = "GET",
    body = null,
    retryAuthentication = true,
  } = {}
) {
  let token =
    await getAccessToken();

  let response;

  try {
    response =
      await fetchWithTimeout(
        `${VTU_API_URL}/${path}`,
        {
          method,

          headers: {
            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json",

            Accept:
              "application/json",
          },

          body:
            body === null
              ? undefined
              : JSON.stringify(
                  body
                ),
        }
      );
  } catch (error) {
    throw error;
  }

  /*
   * Reuse the current Airtime VTU authentication
   * implementation. We never create a separate token cache.
   */
  if (
    (
      response.status ===
        401 ||
      response.status ===
        403
    ) &&
    retryAuthentication
  ) {
    clearAccessToken();

    token =
      await getAccessToken({
        forceRefresh:
          true,
      });

    response =
      await fetchWithTimeout(
        `${VTU_API_URL}/${path}`,
        {
          method,

          headers: {
            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json",

            Accept:
              "application/json",
          },

          body:
            body === null
              ? undefined
              : JSON.stringify(
                  body
                ),
        }
      );
  }

  let data;

  try {
    data =
      await parseJsonResponse(
        response
      );
  } catch (error) {
    if (
      error instanceof
      VtuProviderError
    ) {
      error.httpStatus =
        response.status;

      throw error;
    }

    throw new VtuProviderError(
      "VTU.ng electricity response could not be verified.",
      {
        kind: "unknown",
        httpStatus:
          response.status,
      }
    );
  }

  return {
    response,
    data,
  };
}

function extractPayload(
  data
) {
  if (
    data?.data &&
    typeof data.data ===
      "object"
  ) {
    return data.data;
  }

  return data || {};
}

function extractProviderReference(
  data
) {
  const payload =
    extractPayload(
      data
    );

  const candidates = [
    payload?.order_id,
    payload?.reference,
    payload?.transaction_id,
  ];

  for (
    const candidate of
      candidates
  ) {
    if (
      candidate ===
        null ||
      candidate ===
        undefined
    ) {
      continue;
    }

    const value =
      normalizeString(
        candidate
      );

    if (value) {
      return value;
    }
  }

  return null;
}

function extractProviderStatus(
  data
) {
  const payload =
    extractPayload(
      data
    );

  const status =
    normalizeString(
      payload?.status ||
        data?.status
    ).toLowerCase();

  return status || null;
}

function extractProviderCode(
  data
) {
  const payload =
    extractPayload(
      data
    );

  return (
    payload?.code ??
    data?.code ??
    null
  );
}

function extractProviderMessage(
  data
) {
  const payload =
    extractPayload(
      data
    );

  const message =
    normalizeString(
      payload?.message ??
        data?.message
    );

  return (
    message.slice(
      0,
      500
    ) ||
    null
  );
}

function extractToken(
  data
) {
  const payload =
    extractPayload(
      data
    );

  const tokenCandidates = [
    payload?.token,
    data?.token,
  ];

  for (
    const candidate of
      tokenCandidates
  ) {
    const value =
      normalizeString(
        candidate
      );

    if (value) {
      return value;
    }
  }

  return null;
}

function extractUnits(
  data
) {
  const payload =
    extractPayload(
      data
    );

  const candidates = [
    payload?.units,
    payload?.unit,
    payload?.electricity_units,
  ];

  for (
    const candidate of
      candidates
  ) {
    if (
      candidate ===
        null ||
      candidate ===
        undefined
    ) {
      continue;
    }

    const value =
      normalizeString(
        candidate
      );

    if (value) {
      return value;
    }
  }

  return null;
}

function normalizeProviderStatus(
  status
) {
  const normalized =
    normalizeString(
      status
    ).toLowerCase();

  if (
    normalized ===
    "completed-api"
  ) {
    return "success";
  }

  if (
    normalized ===
      "failed" ||
    normalized ===
      "refunded" ||
    normalized ===
      "cancelled"
  ) {
    return "failure";
  }

  /*
   * processing-api
   * queued-api
   * initiated-api
   * pending
   * on-hold
   *
   * remain unknown.
   */
  return "unknown";
}

function normalizeProviderCode(
  code
) {
  const normalized =
    normalizeString(
      code
    ).toLowerCase();

  /*
   * These represent explicit provider rejection/failure.
   *
   * We deliberately do NOT classify generic HTTP errors
   * or arbitrary "failed" messages here.
   */
  const definiteFailureCodes =
    new Set([
      "insufficient_funds",
      "insufficient-funds",
      "insufficient balance",
      "insufficient_balance",

      "below_minimum_amount",
      "below-minimum-amount",

      "below_customer_arrears",
      "below-customer-arrears",

      "invalid_service",
      "invalid_service_id",
      "invalid_variation_id",

      "missing_fields",

      "duplicate_request_id",
      "duplicate_request",
      "duplicate_order",

      "order_failed",
      "order-failed",

      "product_unavailable",
      "product-unavailable",
    ]);

  if (
    definiteFailureCodes.has(
      normalized
    )
  ) {
    return "failure";
  }

  return "unknown";
}

function normalizeProviderMessageOutcome(
  message
) {
  const normalized =
    normalizeString(
      message
    ).toLowerCase();

  if (!normalized) {
    return "unknown";
  }

  const definiteFailurePatterns = [
    "insufficient funds",
    "insufficient_funds",
    "insufficient-funds",

    "below minimum amount",
    "below_minimum_amount",

    "below customer arrears",
    "below_customer_arrears",

    "invalid service",
    "invalid service id",
    "invalid variation",

    "duplicate request",
    "duplicate order",

    "product unavailable",

    "order failed",
    "order_failed",
    "order-failed",
  ];

  for (
    const pattern of
      definiteFailurePatterns
  ) {
    if (
      normalized.includes(
        pattern
      )
    ) {
      return "failure";
    }
  }

  return "unknown";
}

function normalizeProviderResponse(
  data,
  httpStatus
) {
  const providerStatus =
    extractProviderStatus(
      data
    );

  const providerCode =
    extractProviderCode(
      data
    );

  const message =
    extractProviderMessage(
      data
    );

  const providerReference =
    extractProviderReference(
      data
    );

  /*
   * Provider status always has priority.
   */
  const statusOutcome =
    normalizeProviderStatus(
      providerStatus
    );

  if (
    statusOutcome ===
    "success"
  ) {
    return {
      outcome: "success",
      providerStatus,
      providerCode,
      providerReference,
      message,
      token:
        extractToken(
          data
        ),
      units:
        extractUnits(
          data
        ),
      httpStatus,
    };
  }

  if (
    statusOutcome ===
    "failure"
  ) {
    return {
      outcome: "failure",
      providerStatus,
      providerCode,
      providerReference,
      message,
      token:
        extractToken(
          data
        ),
      units:
        extractUnits(
          data
        ),
      httpStatus,
    };
  }

  /*
   * Explicit provider code.
   */
  const codeOutcome =
    normalizeProviderCode(
      providerCode
    );

  if (
    codeOutcome ===
    "failure"
  ) {
    return {
      outcome: "failure",
      providerStatus:
        providerStatus ||
        null,
      providerCode,
      providerReference,
      message,
      token:
        extractToken(
          data
        ),
      units:
        extractUnits(
          data
        ),
      httpStatus,
    };
  }

  /*
   * Explicit definite failure message.
   */
  const messageOutcome =
    normalizeProviderMessageOutcome(
      message
    );

  if (
    messageOutcome ===
    "failure"
  ) {
    return {
      outcome: "failure",
      providerStatus:
        providerStatus ||
        null,
      providerCode,
      providerReference,
      message,
      token:
        extractToken(
          data
        ),
      units:
        extractUnits(
          data
        ),
      httpStatus,
    };
  }

  /*
   * Everything else remains UNKNOWN.
   *
   * This is critical:
   *
   * timeout/network/5xx/malformed/processing/queued/
   * pending/on-hold must never release the reservation.
   */
  return {
    outcome: "unknown",
    providerStatus:
      providerStatus ||
      null,
    providerCode,
    providerReference,
    message,
    token:
      extractToken(
        data
      ),
    units:
      extractUnits(
        data
      ),
    httpStatus,
  };
}

function validateVerificationInput({
  customerId,
  serviceId,
  meterType,
}) {
  return {
    customerId:
      validateCustomerId(
        customerId
      ),

    serviceId:
      validateServiceId(
        serviceId
      ),

    meterType:
      validateMeterType(
        meterType
      ),
  };
}

async function verifyElectricityCustomer({
  customerId,
  serviceId,
  meterType,
}) {
  const input =
    validateVerificationInput({
      customerId,
      serviceId,
      meterType,
    });

  let result;

  try {
    result =
      await authenticatedRequest(
        "verify-customer",
        {
          method: "POST",

          body: {
            customer_id:
              input.customerId,

            service_id:
              input.serviceId,

            variation_id:
              input.meterType,
          },
        }
      );
  } catch (error) {
    if (
      error instanceof
      VtuProviderError
    ) {
      throw error;
    }

    throw new VtuProviderError(
      "Electricity customer verification could not be verified.",
      {
        kind: "unknown",
      }
    );
  }

  const normalized =
    normalizeProviderResponse(
      result.data,
      result.response.status
    );

  /*
   * Verification is different from a purchase.
   *
   * We require an actual provider response before accepting
   * customer details. An ambiguous verification response is
   * never treated as successful verification.
   */
  if (
    normalized.outcome ===
    "failure"
  ) {
    throw new VtuProviderError(
      normalized.message ||
        "VTU.ng rejected the electricity customer verification.",
      {
        kind: "provider_rejection",
        httpStatus:
          normalized.httpStatus,
        providerCode:
          normalized.providerCode,
        providerStatus:
          normalized.providerStatus,
        providerReference:
          normalized.providerReference,
        rawMessage:
          normalized.message,
      }
    );
  }

  if (
    normalized.outcome ===
    "unknown"
  ) {
    throw new VtuProviderError(
      "Electricity customer verification could not be confirmed.",
      {
        kind: "unknown",
        httpStatus:
          normalized.httpStatus,
        providerCode:
          normalized.providerCode,
        providerStatus:
          normalized.providerStatus,
        providerReference:
          normalized.providerReference,
        rawMessage:
          normalized.message,
      }
    );
  }

  const payload =
    extractPayload(
      result.data
    );

  return {
    outcome:
      "success",

    customerId:
      input.customerId,

    serviceId:
      input.serviceId,

    meterType:
      input.meterType,

    customerName:
      normalizeString(
        payload?.customer_name
      ) || null,

    address:
      normalizeString(
        payload?.address
      ) || null,

    meterNumber:
      normalizeString(
        payload?.meter_number ||
          payload?.meter ||
          input.customerId
      ) || null,

    accountNumber:
      normalizeString(
        payload?.account_number ||
          payload?.account
      ) || null,

    arrears:
      payload?.arrears ??
      payload?.outstanding ??
      null,

    minPurchaseAmount:
      payload?.min_purchase_amount ??
      null,

    maxPurchaseAmount:
      payload?.max_purchase_amount ??
      null,

    providerReference:
      normalized.providerReference,

    providerStatus:
      normalized.providerStatus,

    providerCode:
      normalized.providerCode,

    message:
      normalized.message,
  };
}

async function purchaseElectricity({
  transactionId,
  customerId,
  serviceId,
  meterType,
  amountKobo,
}) {
  const normalizedTransactionId =
    requireTransactionId(
      transactionId
    );

  const normalizedCustomerId =
    validateCustomerId(
      customerId
    );

  const normalizedServiceId =
    validateServiceId(
      serviceId
    );

  const normalizedMeterType =
    validateMeterType(
      meterType
    );

  const normalizedAmountKobo =
    validateAmountKobo(
      amountKobo
    );

  const providerRequestId =
    createProviderRequestId(
      normalizedTransactionId
    );

  const amountNaira =
    normalizedAmountKobo /
    100;

  let result;

  try {
    result =
      await authenticatedRequest(
        "electricity",
        {
          method: "POST",

          body: {
            request_id:
              providerRequestId,

            customer_id:
              normalizedCustomerId,

            service_id:
              normalizedServiceId,

            variation_id:
              normalizedMeterType,

            amount:
              amountNaira,
          },
        }
      );
  } catch (error) {
    /*
     * A timeout/network error means NovaPay does not know
     * whether VTU.ng accepted the order.
     *
     * The caller MUST keep the reservation locked.
     */
    if (
      error instanceof
      VtuProviderError
    ) {
      throw error;
    }

    throw new VtuProviderError(
      "VTU.ng electricity request could not be verified.",
      {
        kind: "unknown",
      }
    );
  }

  const normalized =
    normalizeProviderResponse(
      result.data,
      result.response.status
    );

  return {
    outcome:
      normalized.outcome,

    providerRequestId,

    providerReference:
      normalized.providerReference,

    providerStatus:
      normalized.providerStatus,

    providerCode:
      normalized.providerCode,

    message:
      normalized.message,

    token:
      normalized.token,

    units:
      normalized.units,
  };
}

async function requeryElectricity(
  transactionId
) {
  const normalizedTransactionId =
    requireTransactionId(
      transactionId
    );

  const providerRequestId =
    createProviderRequestId(
      normalizedTransactionId
    );

  let result;

  try {
    result =
      await authenticatedRequest(
        "requery",
        {
          method: "POST",

          body: {
            request_id:
              providerRequestId,
          },
        }
      );
  } catch (error) {
    /*
     * Reconciliation errors remain unresolved.
     * No wallet operation belongs in this adapter.
     */
    if (
      error instanceof
      VtuProviderError
    ) {
      throw error;
    }

    throw new VtuProviderError(
      "Unable to verify the VTU.ng electricity order.",
      {
        kind: "unknown",
      }
    );
  }

  const normalized =
    normalizeProviderResponse(
      result.data,
      result.response.status
    );

  return {
    outcome:
      normalized.outcome,

    providerRequestId,

    providerReference:
      normalized.providerReference,

    providerStatus:
      normalized.providerStatus,

    providerCode:
      normalized.providerCode,

    message:
      normalized.message,

    token:
      normalized.token,

    units:
      normalized.units,
  };
}

async function checkElectricityStatus({
  transactionId,
  providerRequestId = null,
}) {
  const normalizedTransactionId =
    requireTransactionId(
      transactionId
    );

  const expectedProviderRequestId =
    createProviderRequestId(
      normalizedTransactionId
    );

  if (
    providerRequestId !==
      null &&
    normalizeString(
      providerRequestId
    ) !==
      expectedProviderRequestId
  ) {
    throw new VtuProviderError(
      "VTU.ng provider request ID does not match the NovaPay transaction.",
      {
        kind: "validation",
      }
    );
  }

  return requeryElectricity(
    normalizedTransactionId
  );
}

module.exports = {
  verifyElectricityCustomer,
  purchaseElectricity,
  requeryElectricity,
  checkElectricityStatus,

  createProviderRequestId,

  normalizeProviderStatus,
  normalizeProviderResponse,

  VtuProviderError,
};