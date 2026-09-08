"use strict";

const crypto = require("crypto");

const {
  getAccessToken,
  clearAccessToken,
  VtuProviderError,
} = require("../airtime/vtu");

const {
  TV_SERVICES,
  TV_PROVIDER_LIMITS,
  isSupportedTvServiceId,
  normalizeTvServiceId,
  isValidTvCustomerId,
  normalizeTvCustomerId,
  isValidTvVariationId,
  normalizeTvVariationId,
  isValidTvAmountKobo,
  tvKoboToNaira,
  normalizeTvProviderStatus,
  isTvProviderSuccessStatus,
  isTvProviderFailureStatus,
  normalizeTvProviderCode,
  isTvDefiniteFailureCode,
  isTvDefiniteFailureMessage,
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

/*
 * -------------------------------------------------------
 * Basic helpers
 * -------------------------------------------------------
 */

function normalizeString(value) {
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

/*
 * -------------------------------------------------------
 * Input validation
 * -------------------------------------------------------
 */

function validateServiceId(
  serviceId
) {
  const normalized =
    normalizeTvServiceId(
      serviceId
    );

  if (
    !isSupportedTvServiceId(
      normalized
    )
  ) {
    throw new VtuProviderError(
      "Unsupported TV provider.",
      {
        kind: "validation",
        providerCode:
          "invalid_service_id",
      }
    );
  }

  return normalized;
}

function validateCustomerId(
  customerId
) {
  const normalized =
    normalizeTvCustomerId(
      customerId
    );

  if (
    !isValidTvCustomerId(
      normalized
    )
  ) {
    throw new VtuProviderError(
      "Invalid TV customer number.",
      {
        kind: "validation",
        providerCode:
          "invalid_customer_id",
      }
    );
  }

  return normalized;
}

function validateVariationId(
  variationId
) {
  const normalized =
    normalizeTvVariationId(
      variationId
    );

  if (
    !isValidTvVariationId(
      normalized
    )
  ) {
    throw new VtuProviderError(
      "Invalid TV package variation.",
      {
        kind: "validation",
        providerCode:
          "invalid_variation_id",
      }
    );
  }

  return normalized;
}

function validateAmountKobo(
  amountKobo
) {
  if (
    !isValidTvAmountKobo(
      amountKobo
    )
  ) {
    throw new VtuProviderError(
      "Invalid TV purchase amount.",
      {
        kind: "validation",
      }
    );
  }

  return Number(
    amountKobo
  );
}

/*
 * -------------------------------------------------------
 * Provider request ID
 * -------------------------------------------------------
 *
 * VTU.ng request_id must be <= 50 characters.
 *
 * NPTV + 46 hexadecimal characters = 50 characters.
 *
 * The request ID is deterministic from the NovaPay
 * transaction ID so a retry/requery refers to the
 * same provider order.
 */

function createProviderRequestId(
  transactionId
) {
  const normalized =
    requireTransactionId(
      transactionId
    );

  const digest =
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
      );

  const requestId =
    `NPTV${digest.slice(
      0,
      46
    )}`;

  if (
    requestId.length >
    TV_PROVIDER_LIMITS
      .REQUEST_ID_MAX_LENGTH
  ) {
    throw new VtuProviderError(
      "Generated TV provider request ID is invalid.",
      {
        kind: "validation",
      }
    );
  }

  return requestId;
}

/*
 * -------------------------------------------------------
 * HTTP helpers
 * -------------------------------------------------------
 */

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
        "VTU.ng TV request timed out.",
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
          normalizeString(
            error?.message
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

/*
 * -------------------------------------------------------
 * Shared VTU authentication
 * -------------------------------------------------------
 *
 * TV deliberately reuses the Airtime VTU token cache.
 *
 * DO NOT create another TV-specific login/token cache.
 */

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

  let response =
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
   * If the cached token has become invalid,
   * clear it and refresh once.
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
      "VTU.ng TV response could not be verified.",
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

/*
 * -------------------------------------------------------
 * Provider response helpers
 * -------------------------------------------------------
 */

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
    data?.order_id,
    data?.reference,
    data?.transaction_id,
  ];

  for (
    const candidate of
      candidates
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

function extractProviderStatus(
  data
) {
  const payload =
    extractPayload(
      data
    );

  const status =
    normalizeTvProviderStatus(
      payload?.status ||
        data?.status
    );

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
        data?.message ??
        payload?.description ??
        data?.description
    );

  return (
    message.slice(
      0,
      500
    ) ||
    null
  );
}

function extractCustomerName(
  data
) {
  const payload =
    extractPayload(
      data
    );

  return (
    normalizeString(
      payload?.customer_name ??
        payload?.name ??
        payload?.customerName
    ) ||
    null
  );
}

function extractCustomerNumber(
  data
) {
  const payload =
    extractPayload(
      data
    );

  return (
    normalizeString(
      payload?.customer_id ??
        payload?.customer_number ??
        payload?.smartcard_number ??
        payload?.smartcard ??
        payload?.iuc
    ) ||
    null
  );
}

function extractCustomerAddress(
  data
) {
  const payload =
    extractPayload(
      data
    );

  return (
    normalizeString(
      payload?.customer_address ??
        payload?.address
    ) ||
    null
  );
}

function extractCustomerBalance(
  data
) {
  const payload =
    extractPayload(
      data
    );

  return (
    payload?.balance ??
    payload?.customer_balance ??
    null
  );
}

function extractProviderAmount(
  data
) {
  const payload =
    extractPayload(
      data
    );

  return (
    payload?.amount ??
    payload?.amount_charged ??
    null
  );
}

/*
 * -------------------------------------------------------
 * Purchase response normalization
 * -------------------------------------------------------
 *
 * The most important safety rule in this file:
 *
 * We only return "success" when the provider gives a
 * status that explicitly means completed.
 *
 * We only return "failure" when the provider gives a
 * status/code/message that we know definitively means
 * the order did not complete.
 *
 * Everything else = unknown.
 */

function normalizePurchaseResponse(
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

  const providerMessage =
    extractProviderMessage(
      data
    );

  const providerReference =
    extractProviderReference(
      data
    );

  /*
   * 1. Explicit successful provider status.
   */
  if (
    isTvProviderSuccessStatus(
      providerStatus
    )
  ) {
    return {
      outcome: "success",

      providerStatus,

      providerCode,

      providerReference,

      message:
        providerMessage,

      amount:
        extractProviderAmount(
          data
        ),

      httpStatus,
    };
  }

  /*
   * 2. Explicit failed/refunded/cancelled status.
   */
  if (
    isTvProviderFailureStatus(
      providerStatus
    )
  ) {
    return {
      outcome: "failure",

      providerStatus,

      providerCode,

      providerReference,

      message:
        providerMessage,

      amount:
        extractProviderAmount(
          data
        ),

      httpStatus,
    };
  }

  /*
   * 3. Known definite failure code.
   *
   * Duplicate codes are intentionally NOT included
   * in TV_DEFINITE_FAILURE_CODES.
   */
  if (
    isTvDefiniteFailureCode(
      providerCode
    )
  ) {
    return {
      outcome: "failure",

      providerStatus:
        providerStatus ||
        null,

      providerCode,

      providerReference,

      message:
        providerMessage,

      amount:
        extractProviderAmount(
          data
        ),

      httpStatus,
    };
  }

  /*
   * 4. Known definite failure message.
   */
  if (
    isTvDefiniteFailureMessage(
      providerMessage
    )
  ) {
    return {
      outcome: "failure",

      providerStatus:
        providerStatus ||
        null,

      providerCode,

      providerReference,

      message:
        providerMessage,

      amount:
        extractProviderAmount(
          data
        ),

      httpStatus,
    };
  }

  /*
   * 5. Everything else remains UNKNOWN.
   *
   * Examples:
   *
   * processing-api
   * queued-api
   * initiated-api
   * pending
   * on-hold
   * duplicate_request
   * duplicate_request_id
   * duplicate_order
   * unexpected provider response
   */
  return {
    outcome: "unknown",

    providerStatus:
      providerStatus ||
      null,

    providerCode,

    providerReference,

    message:
      providerMessage,

    amount:
      extractProviderAmount(
        data
      ),

    httpStatus,
  };
}

/*
 * -------------------------------------------------------
 * TV package variations
 * -------------------------------------------------------
 *
 * VTU.ng exposes TV variations publicly.
 *
 * We deliberately retrieve them from the provider
 * rather than maintaining a stale hard-coded package
 * list.
 */

async function getTvVariations(
  serviceId = null
) {
  let normalizedServiceId =
    null;

  if (
    serviceId !== null &&
    serviceId !== undefined &&
    normalizeString(
      serviceId
    )
  ) {
    normalizedServiceId =
      validateServiceId(
        serviceId
      );
  }

  const query =
    normalizedServiceId
      ? `?service_id=${encodeURIComponent(
          normalizedServiceId
        )}`
      : "";

  let response;

  try {
    /*
     * The variations endpoint is public according
     * to VTU.ng's API documentation, so we do not
     * send authentication credentials here.
     */
    response =
      await fetchWithTimeout(
        `${VTU_API_URL}/variations/tv${query}`,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json",
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
      "Unable to retrieve TV packages from VTU.ng.",
      {
        kind: "unknown",
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
      throw error;
    }

    throw new VtuProviderError(
      "VTU.ng TV package response could not be verified.",
      {
        kind: "unknown",
        httpStatus:
          response.status,
      }
    );
  }

  /*
   * A non-2xx response does not automatically mean
   * that a customer purchase failed.
   *
   * This endpoint only retrieves packages, so we
   * classify an unsuccessful request as provider
   * rejection/unknown for the caller rather than
   * touching wallet state.
   */
  if (
    response.status <
      200 ||
    response.status >=
      300
  ) {
    const code =
      extractProviderCode(
        data
      );

    const message =
      extractProviderMessage(
        data
      );

    if (
      isTvDefiniteFailureCode(
        code
      ) ||
      isTvDefiniteFailureMessage(
        message
      )
    ) {
      throw new VtuProviderError(
        message ||
          "VTU.ng rejected the TV package request.",
        {
          kind:
            "provider_rejection",

          httpStatus:
            response.status,

          providerCode:
            code,

          providerStatus:
            extractProviderStatus(
              data
            ),

          providerReference:
            extractProviderReference(
              data
            ),

          rawMessage:
            message,
        }
      );
    }

    throw new VtuProviderError(
      "VTU.ng TV package request could not be verified.",
      {
        kind: "unknown",

        httpStatus:
          response.status,

        providerCode:
          code,

        providerStatus:
          extractProviderStatus(
            data
          ),

        providerReference:
          extractProviderReference(
            data
          ),

        rawMessage:
          message,
      }
    );
  }

  const payload =
    extractPayload(
      data
    );

  /*
   * VTU.ng may expose the variations directly under
   * data or inside data.data depending on response
   * shape.
   */
  let variations = [];

  if (
    Array.isArray(
      payload
    )
  ) {
    variations =
      payload;
  } else if (
    Array.isArray(
      payload?.variations
    )
  ) {
    variations =
      payload.variations;
  } else if (
    Array.isArray(
      data?.variations
    )
  ) {
    variations =
      data.variations;
  }

  return {
    outcome: "success",

    serviceId:
      normalizedServiceId,

    variations,
  };
}

/*
 * -------------------------------------------------------
 * TV customer verification
 * -------------------------------------------------------
 */

async function verifyTvCustomer({
  customerId,
  serviceId,
}) {
  const normalizedCustomerId =
    validateCustomerId(
      customerId
    );

  const normalizedServiceId =
    validateServiceId(
      serviceId
    );

  let result;

  try {
    result =
      await authenticatedRequest(
        "verify-customer",
        {
          method: "POST",

          body: {
            customer_id:
              normalizedCustomerId,

            service_id:
              normalizedServiceId,
          },
        }
      );
  } catch (error) {
    /*
     * A timeout/network error means we cannot know
     * whether verification succeeded.
     *
     * No wallet operation happens here.
     */
    if (
      error instanceof
      VtuProviderError
    ) {
      throw error;
    }

    throw new VtuProviderError(
      "TV customer verification could not be verified.",
      {
        kind: "unknown",
      }
    );
  }

  const providerCode =
    extractProviderCode(
      result.data
    );

  const providerStatus =
    extractProviderStatus(
      result.data
    );

  const providerMessage =
    extractProviderMessage(
      result.data
    );

  const returnedCustomerId =
    extractCustomerNumber(
      result.data
    );

  /*
   * Verification requires an explicit success code
   * AND a returned customer identifier.
   */
  if (
    normalizeTvProviderCode(
      providerCode
    ) ===
      "success" &&
    returnedCustomerId
  ) {
    return {
      outcome: "success",

      customerId:
        returnedCustomerId,

      requestedCustomerId:
        normalizedCustomerId,

      serviceId:
        normalizedServiceId,

      customerName:
        extractCustomerName(
          result.data
        ),

      address:
        extractCustomerAddress(
          result.data
        ),

      balance:
        extractCustomerBalance(
          result.data
        ),

      providerReference:
        extractProviderReference(
          result.data
        ),

      providerStatus,

      providerCode,

      message:
        providerMessage,
    };
  }

  /*
   * Explicit verification failure.
   */
  if (
    normalizeTvProviderCode(
      providerCode
    ) ===
      "failure" ||
    isTvDefiniteFailureCode(
      providerCode
    ) ||
    isTvDefiniteFailureMessage(
      providerMessage
    )
  ) {
    throw new VtuProviderError(
      providerMessage ||
        "VTU.ng rejected the TV customer verification.",
      {
        kind:
          "provider_rejection",

        httpStatus:
          result.response.status,

        providerCode,

        providerStatus,

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
   * Anything else is unresolved.
   */
  throw new VtuProviderError(
    "TV customer verification could not be confirmed.",
    {
      kind: "unknown",

      httpStatus:
        result.response.status,

      providerCode,

      providerStatus,

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
 * -------------------------------------------------------
 * TV purchase
 * -------------------------------------------------------
 */

async function purchaseTv({
  transactionId,
  customerId,
  serviceId,
  variationId,
  amountKobo,
  subscriptionType = null,
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

  const normalizedVariationId =
    validateVariationId(
      variationId
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
    tvKoboToNaira(
      normalizedAmountKobo
    );

  if (
    amountNaira ===
    null
  ) {
    throw new VtuProviderError(
      "TV purchase amount could not be converted to naira.",
      {
        kind: "validation",
      }
    );
  }

  const body = {
    request_id:
      providerRequestId,

    customer_id:
      normalizedCustomerId,

    service_id:
      normalizedServiceId,

    variation_id:
      normalizedVariationId,
  };

  /*
   * VTU.ng supports subscription_type for TV.
   *
   * Only send it when explicitly supplied.
   */
  if (
    subscriptionType !==
      null &&
    subscriptionType !==
      undefined &&
    normalizeString(
      subscriptionType
    )
  ) {
    const normalizedSubscriptionType =
      normalizeString(
        subscriptionType
      ).toLowerCase();

    if (
      normalizedSubscriptionType !==
        "change" &&
      normalizedSubscriptionType !==
        "renew"
    ) {
      throw new VtuProviderError(
        "Invalid TV subscription type.",
        {
          kind: "validation",
        }
      );
    }

    body.subscription_type =
      normalizedSubscriptionType;

    /*
     * VTU.ng requires amount for renewals.
     *
     * We already have the NovaPay transaction amount,
     * so include it for renew requests.
     */
    if (
      normalizedSubscriptionType ===
      "renew"
    ) {
      body.amount =
        amountNaira;
    }
  }

  let result;

  try {
    result =
      await authenticatedRequest(
        "tv",
        {
          method: "POST",
          body,
        }
      );
  } catch (error) {
    /*
     * CRITICAL FINANCIAL RULE:
     *
     * A thrown timeout/network/provider ambiguity
     * MUST NOT release the customer's reservation.
     *
     * The service layer will mark the transaction
     * UNKNOWN and reconciliation will requery it.
     */
    if (
      error instanceof
      VtuProviderError
    ) {
      throw error;
    }

    throw new VtuProviderError(
      "VTU.ng TV purchase could not be verified.",
      {
        kind: "unknown",
      }
    );
  }

  const normalized =
    normalizePurchaseResponse(
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

    amount:
      normalized.amount,
  };
}

/*
 * -------------------------------------------------------
 * TV requery
 * -------------------------------------------------------
 *
 * Requery ONLY checks an existing provider request.
 *
 * It NEVER creates a new TV purchase.
 */

async function requeryTv(
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
     * Reconciliation keeps the reservation locked
     * when requery itself is unavailable.
     */
    if (
      error instanceof
      VtuProviderError
    ) {
      throw error;
    }

    throw new VtuProviderError(
      "Unable to verify the VTU.ng TV order.",
      {
        kind: "unknown",
      }
    );
  }

  const normalized =
    normalizePurchaseResponse(
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

    amount:
      normalized.amount,
  };
}

/*
 * -------------------------------------------------------
 * Status check
 * -------------------------------------------------------
 *
 * This function is intended for reconciliation.
 *
 * It validates that any supplied provider request ID
 * belongs to the same NovaPay transaction.
 */

async function checkTvStatus({
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
      "VTU.ng provider request ID does not match the NovaPay TV transaction.",
      {
        kind: "validation",
      }
    );
  }

  return requeryTv(
    normalizedTransactionId
  );
}

module.exports = {
  getTvVariations,

  verifyTvCustomer,

  purchaseTv,

  requeryTv,

  checkTvStatus,

  createProviderRequestId,

  normalizePurchaseResponse,

  VtuProviderError,

  TV_SERVICES,
};