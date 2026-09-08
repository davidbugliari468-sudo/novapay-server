"use strict";

const crypto = require("crypto");

const {
  getAccessToken,
  clearAccessToken,
  VtuProviderError,
} = require("../airtime/vtu");

const {
  BETTING_SERVICES,
  BETTING_PROVIDER_LIMITS,
  isSupportedBettingServiceId,
  normalizeBettingServiceId,
  isValidBettingCustomerId,
  normalizeBettingCustomerId,
  isValidBettingAmountKobo,
  bettingKoboToNaira,
  normalizeBettingProviderStatus,
  isBettingProviderSuccessStatus,
  isBettingProviderFailureStatus,
  normalizeBettingProviderCode,
  isBettingDefiniteFailureCode,
  isBettingDefiniteFailureMessage,
  isValidBettingProviderRequestId,
} = require("./constants");

const VTU_BASE_URL = (
  process.env.VTU_BASE_URL || "https://vtu.ng/wp-json"
).replace(/\/+$/, "");

const VTU_API_BASE_URL = `${VTU_BASE_URL}/api/v2`;

const REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.VTU_TIMEOUT_MS || 15000)
);

const VTU_BETTING_SERVICE_IDS = Object.freeze({
  "1xbet": "1xBet",
  "bangbet": "BangBet",
  "bet9ja": "Bet9ja",
  "betking": "BetKing",
  "betland": "BetLand",
  "betlion": "BetLion",
  "betway": "BetWay",
  "cloudbet": "CloudBet",
  "livescorebet": "LiveScoreBet",
  "merrybet": "MerryBet",
  "naijabet": "NaijaBet",
  "nairabet": "NairaBet",
  "sportybet": "SportyBet",
  "supabet": "SupaBet",
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireTransactionId(transactionId) {
  const normalized = normalizeString(transactionId);

  if (
    normalized.length <
      BETTING_PROVIDER_LIMITS.transactionIdMinLength ||
    normalized.length >
      BETTING_PROVIDER_LIMITS.transactionIdMaxLength
  ) {
    throw new VtuProviderError(
      "Invalid betting transaction ID",
      {
        kind: "validation",
      }
    );
  }

  return normalized;
}

function validateServiceId(serviceId) {
  const normalized = normalizeBettingServiceId(serviceId);

  if (
    !normalized ||
    !isSupportedBettingServiceId(normalized)
  ) {
    throw new VtuProviderError(
      "Unsupported betting service",
      {
        kind: "validation",
      }
    );
  }

  return normalized;
}

function getVtuBettingServiceId(serviceId) {
  const normalized = validateServiceId(serviceId);

  const providerServiceId =
    VTU_BETTING_SERVICE_IDS[normalized];

  if (!providerServiceId) {
    throw new VtuProviderError(
      "Unsupported betting service",
      {
        kind: "validation",
      }
    );
  }

  return providerServiceId;
}

function validateCustomerId(customerId) {
  const normalized =
    normalizeBettingCustomerId(customerId);

  if (!isValidBettingCustomerId(normalized)) {
    throw new VtuProviderError(
      "Invalid betting customer ID",
      {
        kind: "validation",
      }
    );
  }

  return normalized;
}

function validateAmountKobo(amountKobo) {
  const numericAmount = Number(amountKobo);

  if (
    !isValidBettingAmountKobo(numericAmount)
  ) {
    throw new VtuProviderError(
      "Invalid betting amount",
      {
        kind: "validation",
      }
    );
  }

  return numericAmount;
}

function createProviderRequestId(transactionId) {
  const normalizedTransactionId =
    requireTransactionId(transactionId);

  const digest =
    crypto
      .createHash("sha256")
      .update(normalizedTransactionId, "utf8")
      .digest("hex");

  const requestId =
    `NPBET${digest.slice(0, 45)}`;

  if (
    !isValidBettingProviderRequestId(
      requestId
    )
  ) {
    throw new VtuProviderError(
      "Unable to create a valid betting provider request ID",
      {
        kind: "validation",
      }
    );
  }

  return requestId;
}

function createAbortController(timeoutMs) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, timeoutMs);

  return {
    controller,

    clear: () =>
      clearTimeout(timeout),
  };
}

async function fetchWithTimeout(
  url,
  options = {}
) {
  const {
    controller,
    clear,
  } =
    createAbortController(
      REQUEST_TIMEOUT_MS
    );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error &&
      error.name === "AbortError"
    ) {
      throw new VtuProviderError(
        "VTU.ng request timed out",
        {
          kind: "timeout",
        }
      );
    }

    throw new VtuProviderError(
      "Unable to reach VTU.ng",
      {
        kind: "network",
        rawMessage: String(
          error?.message || ""
        ).slice(0, 300),
      }
    );
  } finally {
    clear();
  }
}

async function parseJsonResponse(response) {
  const text =
    await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new VtuProviderError(
      "VTU.ng returned an invalid response",
      {
        kind: "unknown",
        httpStatus: response.status,
        rawMessage: String(
          error?.message || ""
        ).slice(0, 300),
      }
    );
  }
}

function extractPayload(response) {
  if (
    !response ||
    typeof response !== "object"
  ) {
    return {};
  }

  if (
    response.data &&
    typeof response.data === "object" &&
    !Array.isArray(response.data)
  ) {
    return response.data;
  }

  if (
    response.result &&
    typeof response.result === "object" &&
    !Array.isArray(response.result)
  ) {
    return response.result;
  }

  return response;
}

function extractProviderReference(response) {
  const payload =
    extractPayload(response);

  return normalizeString(
    payload.reference ||
      payload.provider_reference ||
      payload.providerReference ||
      payload.transaction_id ||
      payload.transactionId ||
      payload.order_id ||
      payload.orderId ||
      payload.request_id ||
      payload.requestId ||
      response.reference ||
      response.provider_reference ||
      response.transaction_id ||
      response.order_id ||
      ""
  );
}

function extractProviderStatus(response) {
  const payload =
    extractPayload(response);

  return normalizeBettingProviderStatus(
    payload.status ||
      payload.transaction_status ||
      payload.transactionStatus ||
      response.status ||
      ""
  );
}

function extractProviderCode(response) {
  const payload =
    extractPayload(response);

  return normalizeBettingProviderCode(
    payload.code ||
      payload.error_code ||
      payload.errorCode ||
      response.code ||
      response.error_code ||
      response.errorCode ||
      ""
  );
}

function extractProviderMessage(response) {
  const payload =
    extractPayload(response);

  return normalizeString(
    payload.message ||
      payload.msg ||
      payload.description ||
      payload.error ||
      response.message ||
      response.msg ||
      response.description ||
      response.error ||
      ""
  );
}

function extractCustomerId(response) {
  const payload =
    extractPayload(response);

  return normalizeBettingCustomerId(
    payload.customer_id ||
      payload.customerId ||
      payload.account_id ||
      payload.accountId ||
      payload.customer ||
      response.customer_id ||
      response.customerId ||
      ""
  );
}

function extractCustomerName(response) {
  const payload =
    extractPayload(response);

  return normalizeString(
    payload.customer_name ||
      payload.customerName ||
      payload.name ||
      response.customer_name ||
      response.customerName ||
      response.name ||
      ""
  );
}

function extractCustomerBalance(response) {
  const payload =
    extractPayload(response);

  const rawBalance =
    payload.balance ??
    payload.customer_balance ??
    payload.customerBalance ??
    response.balance ??
    response.customer_balance ??
    response.customerBalance;

  if (
    rawBalance === undefined ||
    rawBalance === null ||
    rawBalance === ""
  ) {
    return null;
  }

  const numericBalance =
    Number(rawBalance);

  return Number.isFinite(
    numericBalance
  )
    ? numericBalance
    : null;
}

function extractAmount(response) {
  const payload =
    extractPayload(response);

  const rawAmount =
    payload.amount ??
    payload.amount_paid ??
    payload.amountPaid ??
    response.amount ??
    response.amount_paid ??
    response.amountPaid;

  if (
    rawAmount === undefined ||
    rawAmount === null ||
    rawAmount === ""
  ) {
    return null;
  }

  const numericAmount =
    Number(rawAmount);

  return Number.isFinite(
    numericAmount
  )
    ? numericAmount
    : null;
}

function buildSafeResponseDiagnostic(response) {
  const topLevel =
    response &&
    typeof response === "object" &&
    !Array.isArray(response)
      ? response
      : {};

  const payload =
    extractPayload(topLevel);

  const payloadObject =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? payload
      : {};

  return {
    responseType:
      Array.isArray(response)
        ? "array"
        : typeof response,

    topLevelKeys:
      Object.keys(topLevel).sort(),

    payloadKeys:
      Object.keys(payloadObject).sort(),

    providerCode:
      extractProviderCode(response),

    providerStatus:
      extractProviderStatus(response),

    providerMessage:
      extractProviderMessage(response),

    hasCustomerId:
      Boolean(
        extractCustomerId(response)
      ),

    hasCustomerName:
      Boolean(
        extractCustomerName(response)
      ),

    hasProviderReference:
      Boolean(
        extractProviderReference(response)
      ),
  };
}

function normalizePurchaseResponse(response) {
  const providerStatus =
    extractProviderStatus(response);

  const providerCode =
    extractProviderCode(response);

  const message =
    extractProviderMessage(response);

  const providerReference =
    extractProviderReference(response);

  if (
    isBettingProviderSuccessStatus(
      providerStatus
    )
  ) {
    return {
      outcome: "success",
      providerReference,
      providerStatus,
      providerCode,
      message,
      amount:
        extractAmount(response),
      raw: response,
    };
  }

  if (
    isBettingProviderFailureStatus(
      providerStatus
    )
  ) {
    return {
      outcome: "failure",
      providerReference,
      providerStatus,
      providerCode,
      message,
      amount:
        extractAmount(response),
      raw: response,
    };
  }

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
      providerStatus,
      providerCode,
      message,
      amount:
        extractAmount(response),
      raw: response,
    };
  }

  return {
    outcome: "unknown",
    providerReference,
    providerStatus,
    providerCode,
    message,
    amount:
      extractAmount(response),
    raw: response,
  };
}

async function authenticatedRequest(
  path,
  {
    method = "GET",
    body,
    retryOnUnauthorized = true,
  } = {}
) {
  /*
   * TEMPORARY DIAGNOSTIC:
   *
   * We deliberately do not log the access token.
   *
   * This tells us whether the shared VTU.ng authentication
   * layer succeeds or fails before the betting request.
   */
  console.log(
    "[VTU BETTING AUTH START]",
    {
      path,
      method,
    }
  );

  let token;

  try {
    token =
      await getAccessToken();
  } catch (error) {
    console.error(
      "[VTU BETTING AUTH ERROR]",
      {
        path,
        method,
        kind:
          error?.kind ||
          error?.name ||
          "unknown",
        type:
          error?.constructor?.name ||
          "",
        httpStatus:
          error?.httpStatus ??
          null,
        providerCode:
          error?.providerCode ||
          "",
        providerStatus:
          error?.providerStatus ||
          "",
        message:
          error?.message ||
          "Unable to obtain VTU.ng access token",
      }
    );

    throw error;
  }

  console.log(
    "[VTU BETTING AUTH SUCCESS]",
    {
      path,
      method,
      tokenReceived:
        Boolean(
          typeof token === "string" &&
          token.trim()
        ),
    }
  );

  const makeRequest =
    async (accessToken) => {
      const headers = {
        Authorization:
          `Bearer ${accessToken}`,

        Accept:
          "application/json",
      };

      if (body !== undefined) {
        headers["Content-Type"] =
          "application/json";
      }

      return fetchWithTimeout(
        `${VTU_API_BASE_URL}${path}`,
        {
          method,
          headers,
          body:
            body === undefined
              ? undefined
              : JSON.stringify(body),
        }
      );
    };

  let response =
    await makeRequest(token);

  if (
    retryOnUnauthorized &&
    (
      response.status === 401 ||
      response.status === 403
    )
  ) {
    console.log(
      "[VTU BETTING AUTH REFRESH]",
      {
        path,
        method,
        httpStatus:
          response.status,
      }
    );

    clearAccessToken();

    token =
      await getAccessToken();

    response =
      await makeRequest(token);
  }

  const parsed =
    await parseJsonResponse(
      response
    );

  if (!response.ok) {
    const code =
      extractProviderCode(parsed);

    const message =
      extractProviderMessage(
        parsed
      ) ||
      `VTU.ng returned HTTP ${response.status}`;

    if (
      response.status === 400 ||
      response.status === 402 ||
      response.status === 409
    ) {
      if (
        isBettingDefiniteFailureCode(
          code
        ) ||
        isBettingDefiniteFailureMessage(
          message
        )
      ) {
        throw new VtuProviderError(
          message,
          {
            kind:
              "provider_rejection",

            httpStatus:
              response.status,

            providerCode:
              code,

            rawMessage:
              message,
          }
        );
      }
    }

    throw new VtuProviderError(
      message,
      {
        kind: "unknown",

        httpStatus:
          response.status,

        providerCode:
          code,

        rawMessage:
          message,
      }
    );
  }

  return parsed;
}

async function verifyBettingCustomer({
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

  const providerServiceId =
    getVtuBettingServiceId(
      normalizedServiceId
    );

  const response =
    await authenticatedRequest(
      "/verify-customer",
      {
        method: "POST",

        body: {
          customer_id:
            normalizedCustomerId,

          service_id:
            providerServiceId,
        },
      }
    );

  const providerCode =
    extractProviderCode(
      response
    );

  const providerStatus =
    extractProviderStatus(
      response
    );

  const message =
    extractProviderMessage(
      response
    );

  const returnedCustomerId =
    extractCustomerId(
      response
    );

  const explicitSuccess =
    providerCode === "success" &&
    Boolean(returnedCustomerId);

  if (explicitSuccess) {
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
          response
        ),

      balance:
        extractCustomerBalance(
          response
        ),

      providerReference:
        extractProviderReference(
          response
        ),

      providerStatus,

      providerCode,

      message,

      raw:
        response,
    };
  }

  const diagnostic =
    buildSafeResponseDiagnostic(
      response
    );

  console.error(
    "[VTU BETTING VERIFY RESPONSE]",
    {
      serviceId:
        normalizedServiceId,

      providerServiceId,

      diagnostic,
    }
  );

  if (
    providerCode === "failure" ||
    isBettingDefiniteFailureCode(
      providerCode
    ) ||
    isBettingDefiniteFailureMessage(
      message
    )
  ) {
    throw new VtuProviderError(
      message ||
        "VTU.ng rejected the betting customer verification",
      {
        kind:
          "provider_rejection",

        providerCode,

        providerStatus,
      }
    );
  }

  throw new VtuProviderError(
    message ||
      "Unable to determine the betting customer verification result",
    {
      kind: "unknown",

      providerCode,

      providerStatus,
    }
  );
}

async function fundBettingAccount({
  transactionId,
  customerId,
  serviceId,
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

  const normalizedAmountKobo =
    validateAmountKobo(
      amountKobo
    );

  const providerServiceId =
    getVtuBettingServiceId(
      normalizedServiceId
    );

  const providerRequestId =
    createProviderRequestId(
      normalizedTransactionId
    );

  const amountNaira =
    bettingKoboToNaira(
      normalizedAmountKobo
    );

  const response =
    await authenticatedRequest(
      "/betting",
      {
        method: "POST",

        body: {
          request_id:
            providerRequestId,

          customer_id:
            normalizedCustomerId,

          service_id:
            providerServiceId,

          amount:
            amountNaira,
        },
      }
    );

  const normalized =
    normalizePurchaseResponse(
      response
    );

  return {
    ...normalized,

    providerRequestId,

    customerId:
      normalizedCustomerId,

    serviceId:
      normalizedServiceId,

    amountKobo:
      normalizedAmountKobo,

    amountNaira,
  };
}

async function requeryBetting(
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

  const response =
    await authenticatedRequest(
      "/requery",
      {
        method: "POST",

        body: {
          request_id:
            providerRequestId,
        },
      }
    );

  const normalized =
    normalizePurchaseResponse(
      response
    );

  return {
    ...normalized,

    providerRequestId,
  };
}

async function checkBettingStatus({
  transactionId,
  providerRequestId,
}) {
  const normalizedTransactionId =
    requireTransactionId(
      transactionId
    );

  const expectedRequestId =
    createProviderRequestId(
      normalizedTransactionId
    );

  const suppliedRequestId =
    normalizeString(
      providerRequestId
    );

  if (
    !suppliedRequestId ||
    suppliedRequestId !==
      expectedRequestId
  ) {
    throw new VtuProviderError(
      "Invalid betting provider request ID",
      {
        kind: "validation",
      }
    );
  }

  return requeryBetting(
    normalizedTransactionId
  );
}

module.exports = {
  BETTING_SERVICES,

  getBettingRequestId:
    createProviderRequestId,

  verifyBettingCustomer,

  fundBettingAccount,

  requeryBetting,

  checkBettingStatus,

  normalizePurchaseResponse,

  VtuProviderError,
};