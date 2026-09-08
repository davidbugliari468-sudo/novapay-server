"use strict";

const {
  getAccessToken,
  clearAccessToken,
  VtuProviderError,
} = require("../airtime/vtu");

const {
  ELECTRICITY_LIMITS,
  ELECTRICITY_INPUT_LIMITS,
  normalizeElectricityServiceId,
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

function normalizeString(value) {
  return String(
    value ?? ""
  ).trim();
}

function requireTransactionId(transactionId) {
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

function validateServiceId(serviceId) {
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

  /*
   * The frontend can send:
   *
   *   ikedc
   *   ekedc
   *   phed
   *   etc.
   *
   * NovaPay converts those identifiers to the
   * official VTU.ng service IDs at the provider boundary.
   */
  return normalizeElectricityServiceId(
    value
  );
}

function validateMeterType(meterType) {
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

function validateCustomerId(customerId) {
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
   * so we deliberately do not force a numeric-only rule.
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

function validateAmountKobo(amountKobo) {
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
    ELECTRICITY_LIMITS.MAX_AMOUNT_KOBO
  ) {
    throw new VtuProviderError(
      "Electricity purchase amount exceeds the maximum allowed amount.",
      {
        kind: "validation",
      }
    );
  }

  /*
   * NovaPay stores money in kobo.
   * VTU.ng electricity accepts whole NGN.
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

function createProviderRequestId(transactionId) {
  const normalized =
    requireTransactionId(
      transactionId
    );

  const crypto =
    require("crypto");

  /*
   * VTU.ng request_id maximum = 50 characters.
   *
   * NPE + 47 hexadecimal characters = 50 characters.
   */
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

  /*
   * Reuse the Airtime VTU authentication
   * implementation so we do not maintain a
   * second independent token cache.
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

function extractPayload(data) {
  if (
    data?.data &&
    typeof data.data ===
      "object"
  ) {
    return data.data;
  }

  return data || {};
}

function extractProviderReference(data) {
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

function extractProviderStatus(data) {
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

function extractProviderCode(data) {
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

function extractProviderMessage(data) {
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

function extractToken(data) {
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

function extractUnits(data) {
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

function normalizeProviderStatus(status) {
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

function normalizeProviderCode(code) {
  const normalized =
    normalizeString(
      code
    ).toLowerCase();

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
   * Provider status has priority for PURCHASE
   * responses.
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
   * Explicit provider failure code.
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
   * This includes:
   *
   * - timeout
   * - network failure
   * - malformed provider response
   * - 5xx
   * - duplicate_request_id
   * - duplicate_request
   * - duplicate_order
   * - processing-api
   * - queued-api
   * - initiated-api
   * - pending
   * - on-hold
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

/*
 * VTU.ng's verify-customer response is different
 * from a purchase response.
 *
 * A successful verification looks like:
 *
 * {
 *   "code": "success",
 *   "message": "Customer Details Retrieved",
 *   "data": {
 *      "customer_id": "...",
 *      "customer_name": "...",
 *      ...
 *   }
 * }
 *
 * There is no requirement for:
 *
 *   data.status === "completed-api"
 *
 * Therefore verification must NOT use the purchase
 * status classifier as its success condition.
 */
function isSuccessfulVerificationResponse(
  data
) {
  const payload =
    extractPayload(
      data
    );

  const code =
    normalizeString(
      data?.code
    ).toLowerCase();

  const customerId =
    normalizeString(
      payload?.customer_id
    );

  return (
    code ===
      "success" &&
    Boolean(
      customerId
    )
  );
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

  /*
   * IMPORTANT:
   *
   * Verify-customer uses code=success rather than
   * purchase-style status=completed-api.
   */
  if (
    isSuccessfulVerificationResponse(
      result.data
    )
  ) {
    const payload =
      extractPayload(
        result.data
      );

    return {
      outcome: "success",

      customerId:
        input.customerId,

      /*
       * Return the provider service ID because that
       * is what VTU actually accepted.
       */
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
          payload?.customer_address ||
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
        payload?.customer_arrears ??
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
        extractProviderReference(
          result.data
        ),

      providerStatus:
        extractProviderStatus(
          result.data
        ),

      providerCode:
        extractProviderCode(
          result.data
        ),

      message:
        extractProviderMessage(
          result.data
        ),
    };
  }

  /*
   * If VTU explicitly reports a failure, this is a
   * definite verification failure.
   */
  const providerCode =
    extractProviderCode(
      result.data
    );

  const providerMessage =
    extractProviderMessage(
      result.data
    );

  const codeOutcome =
    normalizeProviderCode(
      providerCode
    );

  const messageOutcome =
    normalizeProviderMessageOutcome(
      providerMessage
    );

  if (
    codeOutcome ===
      "failure" ||
    messageOutcome ===
      "failure" ||
    normalizeString(
      providerCode
    ).toLowerCase() ===
      "failure"
  ) {
    throw new VtuProviderError(
      providerMessage ||
        "VTU.ng rejected the electricity customer verification.",
      {
        kind:
          "provider_rejection",

        httpStatus:
          result.response.status,

        providerCode:
          providerCode,

        providerStatus:
          extractProviderStatus(
            result.data
          ),

        providerReference:
          extractProviderReference(
            result.data
          ),

        rawMessage:
          providerMessage,
      }
    );
  }

  /*
   * Anything that is not an explicit successful
   * verification or definite rejection remains
   * unresolved.
   */
  throw new VtuProviderError(
    "Electricity customer verification could not be confirmed.",
    {
      kind: "unknown",

      httpStatus:
        result.response.status,

      providerCode,

      providerStatus:
        extractProviderStatus(
          result.data
        ),

      providerReference:
        extractProviderReference(
          result.data
        ),

      rawMessage:
        providerMessage,
    }
  );
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
     * The request may have reached VTU.ng even if
     * NovaPay did not receive the response.
     *
     * Therefore the caller MUST keep the reservation
     * locked and reconcile later.
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
     * This adapter never changes wallet state.
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