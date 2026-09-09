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
  BETTING_SUCCESS_STATUSES,
  BETTING_FAILURE_STATUSES,
  isBettingDefiniteFailureCode,
  isBettingDefiniteFailureMessage,
  getBettingProviderServiceId,
} = require("./constants");

const {
  validateProvider,
  validateCustomerId,
  validateAmountKobo,
  validateTransactionId,
} = require("./validation");

const VTU_BASE_URL = (
  process.env.VTU_BASE_URL || "https://vtu.ng/wp-json"
).replace(/\/+$/, "");

const VTU_API_URL = `${VTU_BASE_URL}/api/v2`;

const VTU_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.VTU_TIMEOUT_MS || 15000)
);

function normalizeProvider(provider) {
  return String(provider || "")
    .trim()
    .toLowerCase();
}

function resolveBettingProvider({ provider, serviceId }) {
  const normalizedProvider = normalizeProvider(provider);

  let providerResult = null;

  if (normalizedProvider) {
    providerResult = validateProvider(normalizedProvider);
  } else if (serviceId) {
    const normalizedServiceId = String(serviceId)
      .trim()
      .toLowerCase();

    providerResult = validateProvider(normalizedServiceId);
  }

  if (!providerResult || !providerResult.valid) {
    throw new VtuProviderError(
      providerResult?.message ||
        "Unsupported betting provider.",
      {
        kind: "validation",
      }
    );
  }

  const providerData = providerResult.data;

  if (
    !providerData ||
    typeof providerData !== "object" ||
    !providerData.provider ||
    !providerData.serviceId
  ) {
    throw new VtuProviderError(
      "The betting provider configuration is invalid.",
      {
        kind: "validation",
      }
    );
  }

  const resolvedProvider =
    normalizeProvider(providerData.provider);

  const resolvedServiceId =
    String(providerData.serviceId).trim();

  if (!BETTING_SERVICES.includes(resolvedProvider)) {
    throw new VtuProviderError(
      "Unsupported betting provider.",
      {
        kind: "validation",
      }
    );
  }

  const expectedServiceId =
    getBettingProviderServiceId(resolvedProvider);

  if (
    !expectedServiceId ||
    expectedServiceId !== resolvedServiceId
  ) {
    throw new VtuProviderError(
      "The betting provider service configuration is invalid.",
      {
        kind: "validation",
      }
    );
  }

  if (serviceId) {
    const suppliedServiceId =
      String(serviceId).trim();

    if (
      suppliedServiceId.toLowerCase() !==
      resolvedServiceId.toLowerCase()
    ) {
      throw new VtuProviderError(
        "Betting provider and service do not match.",
        {
          kind: "validation",
        }
      );
    }
  }

  return {
    provider: resolvedProvider,
    serviceId: resolvedServiceId,
  };
}

function validateBettingProvider(provider) {
  return resolveBettingProvider({
    provider,
  }).provider;
}

function validateBettingCustomer(customerId) {
  const result = validateCustomerId(customerId);

  if (!result || !result.valid) {
    throw new VtuProviderError(
      result?.message ||
        "A valid betting customer ID is required.",
      {
        kind: "validation",
      }
    );
  }

  return result.data;
}

function validateBettingAmount(amountKobo) {
  const result = validateAmountKobo(amountKobo);

  if (!result || !result.valid) {
    throw new VtuProviderError(
      result?.message ||
        "A valid betting amount is required.",
      {
        kind: "validation",
      }
    );
  }

  const amount = result.data;

  if (
    amount <
    BETTING_PROVIDER_LIMITS.MIN_AMOUNT_KOBO
  ) {
    throw new VtuProviderError(
      "The betting amount is below the minimum.",
      {
        kind: "validation",
      }
    );
  }

  if (
    amount >
    BETTING_PROVIDER_LIMITS.MAX_AMOUNT_KOBO
  ) {
    throw new VtuProviderError(
      "The betting amount is above the maximum.",
      {
        kind: "validation",
      }
    );
  }

  /*
   * VTU.ng betting amounts are whole NGN values.
   * The wallet uses kobo internally, so the conversion must
   * always be exact.
   */
  if (amount % 100 !== 0) {
    throw new VtuProviderError(
      "The betting amount must be a whole naira amount.",
      {
        kind: "validation",
      }
    );
  }

  return amount;
}

function buildBettingRequestId(transactionId) {
  const result = validateTransactionId(transactionId);

  if (!result || !result.valid || !result.data) {
    throw new VtuProviderError(
      result?.message ||
        "A valid transaction ID is required for betting.",
      {
        kind: "validation",
      }
    );
  }

  const normalizedTransactionId = result.data;

  /*
   * VTU.ng allows request_id values up to 50 characters.
   *
   * We deliberately do not send the internal transaction ID
   * directly because an internal ID may exceed that limit.
   *
   * The hash is deterministic, so the exact same provider
   * request ID can be reconstructed during reconciliation.
   */
  const digest = crypto
    .createHash("sha256")
    .update(normalizedTransactionId, "utf8")
    .digest("hex");

  const requestId = `NPBET${digest.slice(0, 45)}`;

  if (
    requestId.length >
    BETTING_PROVIDER_LIMITS.PROVIDER_REQUEST_ID_MAX_LENGTH
  ) {
    throw new VtuProviderError(
      "The betting request ID is invalid.",
      {
        kind: "validation",
      }
    );
  }

  return requestId;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, VTU_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new VtuProviderError(
        "VTU.ng request timed out.",
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
          error && error.message
            ? error.message
            : null,
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    throw new VtuProviderError(
      "VTU.ng returned an empty response.",
      {
        kind: "unknown",
        httpStatus: response.status,
      }
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new VtuProviderError(
      "VTU.ng returned an invalid response.",
      {
        kind: "unknown",
        httpStatus: response.status,
      }
    );
  }
}

function extractPayload(data) {
  if (
    !data ||
    typeof data !== "object"
  ) {
    return {};
  }

  if (
    data.data &&
    typeof data.data === "object" &&
    !Array.isArray(data.data)
  ) {
    return data.data;
  }

  return data;
}

function extractProviderReference(data) {
  const payload = extractPayload(data);

  return (
    payload.reference ||
    payload.transaction_id ||
    payload.transactionId ||
    payload.order_id ||
    payload.orderId ||
    payload.ref ||
    data?.reference ||
    data?.transaction_id ||
    data?.transactionId ||
    data?.order_id ||
    data?.orderId ||
    data?.ref ||
    null
  );
}

function extractProviderRequestId(data) {
  const payload = extractPayload(data);

  return (
    payload.request_id ||
    payload.requestId ||
    data?.request_id ||
    data?.requestId ||
    null
  );
}

function extractProviderStatus(data) {
  const payload = extractPayload(data);

  return String(
    payload.status ||
      payload.transaction_status ||
      payload.transactionStatus ||
      data?.status ||
      data?.transaction_status ||
      data?.transactionStatus ||
      ""
  )
    .trim()
    .toLowerCase();
}

function extractProviderCode(data) {
  const payload = extractPayload(data);

  return String(
    data?.code ||
      data?.status_code ||
      data?.statusCode ||
      payload.code ||
      payload.status_code ||
      payload.statusCode ||
      ""
  )
    .trim()
    .toLowerCase();
}

function extractProviderMessage(data) {
  const payload = extractPayload(data);

  return String(
    data?.message ||
      data?.error ||
      data?.msg ||
      payload.message ||
      payload.error ||
      payload.msg ||
      ""
  ).trim();
}

function extractCustomerId(data) {
  const payload = extractPayload(data);

  return String(
    payload.customer_id ||
      payload.customerId ||
      payload.account_number ||
      payload.accountNumber ||
      data?.customer_id ||
      data?.customerId ||
      ""
  ).trim();
}

function extractCustomerName(data) {
  const payload = extractPayload(data);

  return String(
    payload.customer_name ||
      payload.customerName ||
      payload.name ||
      data?.customer_name ||
      data?.customerName ||
      data?.name ||
      ""
  ).trim();
}

function extractCustomerBalance(data) {
  const payload = extractPayload(data);

  const value =
    payload.balance ??
    payload.customer_balance ??
    payload.customerBalance ??
    data?.balance ??
    data?.customer_balance ??
    data?.customerBalance ??
    null;

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric)
    ? numeric
    : null;
}

function extractAmount(data) {
  const payload = extractPayload(data);

  const value =
    payload.amount ??
    payload.amount_paid ??
    payload.amountPaid ??
    data?.amount ??
    data?.amount_paid ??
    data?.amountPaid ??
    null;

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric)
    ? numeric
    : null;
}

function getObjectKeys(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [];
  }

  return Object.keys(value).slice(0, 30);
}

function buildSafeResponseDiagnostic(data) {
  const payload =
    data &&
    typeof data === "object" &&
    data.data &&
    typeof data.data === "object" &&
    !Array.isArray(data.data)
      ? data.data
      : null;

  return {
    topLevelKeys: getObjectKeys(data),
    payloadKeys: getObjectKeys(payload),
    providerCode: extractProviderCode(data),
    providerStatus: extractProviderStatus(data),
    providerMessage: extractProviderMessage(data),
    hasReference: Boolean(
      extractProviderReference(data)
    ),
    hasRequestId: Boolean(
      extractProviderRequestId(data)
    ),
    hasCustomerId: Boolean(
      extractCustomerId(data)
    ),
    hasCustomerName: Boolean(
      extractCustomerName(data)
    ),
    hasBalance:
      extractCustomerBalance(data) !== null,
    hasAmount:
      extractAmount(data) !== null,
  };
}

function logProviderErrorResponse(
  path,
  response,
  data
) {
  console.error(
    "[VTU BETTING PROVIDER ERROR]",
    {
      path,
      httpStatus: response.status,
      ...buildSafeResponseDiagnostic(data),
    }
  );
}

function normalizePurchaseResponse(data) {
  const code = extractProviderCode(data);
  const status = extractProviderStatus(data);
  const message = extractProviderMessage(data);
  const reference = extractProviderReference(data);
  const requestId = extractProviderRequestId(data);

  /*
   * Financial settlement is status-first.
   *
   * Only an explicit completed-api status is considered
   * successful. A generic "success" code is not enough to
   * permanently debit the customer's reservation.
   */
  if (
    BETTING_SUCCESS_STATUSES.includes(status)
  ) {
    return {
      outcome: "success",
      providerReference: reference,
      providerRequestId: requestId,
      providerStatus: status,
      providerCode: code,
      providerMessage: message,
      raw: data,
    };
  }

  if (
    BETTING_FAILURE_STATUSES.includes(status) ||
    isBettingDefiniteFailureCode(code) ||
    isBettingDefiniteFailureMessage(message)
  ) {
    return {
      outcome: "failure",
      providerReference: reference,
      providerRequestId: requestId,
      providerStatus: status,
      providerCode: code,
      providerMessage: message,
      raw: data,
    };
  }

  return {
    outcome: "unknown",
    providerReference: reference,
    providerRequestId: requestId,
    providerStatus: status,
    providerCode: code,
    providerMessage: message,
    raw: data,
  };
}

async function authenticatedRequest(
  path,
  {
    method = "POST",
    body = null,
    operation = "unknown",
  } = {}
) {
  let token;

  console.log(
    "[VTU BETTING AUTH START]",
    {
      path,
      method,
    }
  );

  try {
    token = await getAccessToken();
  } catch (error) {
    console.error(
      "[VTU BETTING AUTH ERROR]",
      {
        kind: error?.kind || "unknown",
        type: error?.name || "",
        httpStatus: error?.httpStatus || null,
        providerCode:
          error?.providerCode || null,
        providerStatus:
          error?.providerStatus || null,
        message:
          error?.message ||
          "Unknown authentication error",
      }
    );

    throw error;
  }

  console.log(
    "[VTU BETTING AUTH SUCCESS]",
    {
      path,
      method,
      tokenReceived: Boolean(token),
    }
  );

  const response = await fetchWithTimeout(
    `${VTU_API_URL}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body:
        body === null
          ? undefined
          : JSON.stringify(body),
    }
  );

  /*
   * IMPORTANT:
   *
   * Do not automatically replay a betting funding request.
   *
   * If the provider returned 401/403, we clear the cached
   * token, but the current operation is NOT submitted again.
   *
   * Verification can safely be retried by its caller because
   * it does not move money. Funding must be reconciled instead.
   */
  if (
    response.status === 401 ||
    response.status === 403
  ) {
    clearAccessToken();

    const message =
      `VTU.ng authentication was rejected (HTTP ${response.status}).`;

    console.warn(
      "[VTU BETTING AUTH REJECTED]",
      {
        path,
        method,
        operation,
        httpStatus: response.status,
      }
    );

    throw new VtuProviderError(
      message,
      {
        kind:
          operation === "verify"
            ? "provider_rejection"
            : "unknown",

        httpStatus: response.status,
      }
    );
  }

  const parsed = await parseJsonResponse(response);

  if (!response.ok) {
    logProviderErrorResponse(
      path,
      response,
      parsed
    );

    const code = extractProviderCode(parsed);
    const status = extractProviderStatus(parsed);
    const message =
      extractProviderMessage(parsed) ||
      `VTU.ng returned HTTP ${response.status}`;

    /*
     * Verification's documented "failure" response is a
     * definite customer-verification rejection.
     *
     * For funding/requery we intentionally do NOT treat a
     * generic "failure" code as sufficient evidence to release
     * customer funds. The provider's transaction outcome must
     * be definite.
     */
    const verificationFailure =
      operation === "verify" &&
      (
        code === "failure" ||
        isBettingDefiniteFailureCode(code) ||
        isBettingDefiniteFailureMessage(message)
      );

    const definiteFailure =
      operation !== "verify" &&
      (
        isBettingDefiniteFailureCode(code) ||
        isBettingDefiniteFailureMessage(message)
      );

    if (
      verificationFailure ||
      definiteFailure
    ) {
      throw new VtuProviderError(
        message,
        {
          kind: "provider_rejection",
          httpStatus: response.status,
          providerCode: code,
          providerStatus: status,
          rawMessage: message,
        }
      );
    }

    /*
     * A non-success HTTP response that is not a definite
     * rejection is deliberately ambiguous.
     */
    throw new VtuProviderError(
      message,
      {
        kind: "unknown",
        httpStatus: response.status,
        providerCode: code,
        providerStatus: status,
        rawMessage: message,
      }
    );
  }

  return {
    response,
    data: parsed,
  };
}

async function verifyBettingCustomer({
  provider,
  serviceId,
  customerId,
}) {
  const resolved = resolveBettingProvider({
    provider,
    serviceId,
  });

  const normalizedCustomerId =
    validateBettingCustomer(customerId);

  const { data } =
    await authenticatedRequest(
      "/verify-customer",
      {
        method: "POST",
        operation: "verify",
        body: {
          customer_id:
            normalizedCustomerId,
          service_id:
            resolved.serviceId,
        },
      }
    );

  const code =
    extractProviderCode(data);

  const returnedCustomerId =
    extractCustomerId(data);

  /*
   * Verification requires an explicit successful provider
   * response and a returned customer ID.
   */
  if (
    code !== "success" ||
    !returnedCustomerId
  ) {
    const diagnostic =
      buildSafeResponseDiagnostic(data);

    console.error(
      "[VTU BETTING VERIFY RESPONSE]",
      diagnostic
    );

    const message =
      extractProviderMessage(data) ||
      "VTU.ng did not confirm the betting customer.";

    if (
      code === "failure" ||
      isBettingDefiniteFailureCode(code) ||
      isBettingDefiniteFailureMessage(message)
    ) {
      throw new VtuProviderError(
        message,
        {
          kind: "provider_rejection",
          providerCode: code,
          providerStatus:
            extractProviderStatus(data),
          rawMessage: message,
        }
      );
    }

    throw new VtuProviderError(
      "VTU.ng returned an unexpected betting verification response.",
      {
        kind: "unknown",
        providerCode: code,
        providerStatus:
          extractProviderStatus(data),
        rawMessage: message,
      }
    );
  }

  return {
    outcome: "success",

    provider:
      resolved.provider,

    serviceId:
      resolved.serviceId,

    customerId:
      returnedCustomerId,

    customerName:
      extractCustomerName(data),

    balance:
      extractCustomerBalance(data),

    providerCode:
      code,

    providerStatus:
      extractProviderStatus(data),

    providerReference:
      extractProviderReference(data),

    providerRequestId:
      extractProviderRequestId(data),

    message:
      extractProviderMessage(data) ||
      "Betting customer verified successfully.",
  };
}

async function fundBettingAccount({
  provider,
  serviceId,
  customerId,
  amountKobo,
  transactionId,
}) {
  const resolved = resolveBettingProvider({
    provider,
    serviceId,
  });

  const normalizedCustomerId =
    validateBettingCustomer(customerId);

  const normalizedAmountKobo =
    validateBettingAmount(amountKobo);

  const requestId =
    buildBettingRequestId(transactionId);

  const amountNaira =
    normalizedAmountKobo / 100;

  /*
   * VTU.ng expects amount in whole NGN, not kobo.
   */
  const { data } =
    await authenticatedRequest(
      "/betting",
      {
        method: "POST",
        operation: "fund",
        body: {
          request_id:
            requestId,

          customer_id:
            normalizedCustomerId,

          service_id:
            resolved.serviceId,

          amount:
            amountNaira,
        },
      }
    );

  const normalized =
    normalizePurchaseResponse(data);

  return {
    ...normalized,

    provider:
      resolved.provider,

    serviceId:
      resolved.serviceId,

    customerId:
      normalizedCustomerId,

    amountKobo:
      normalizedAmountKobo,

    /*
     * Always expose our deterministic provider request ID.
     * This is the ID actually submitted to VTU.
     */
    requestId,

    providerRequestId:
      normalized.providerRequestId ||
      requestId,
  };
}

async function requeryBetting({
  provider,
  serviceId,
  customerId,
  transactionId,
  providerRequestId,
}) {
  const resolved = resolveBettingProvider({
    provider,
    serviceId,
  });

  const normalizedCustomerId =
    validateBettingCustomer(customerId);

  let requestId;

  if (providerRequestId) {
    requestId = String(providerRequestId).trim();

    if (
      !requestId ||
      requestId.length >
        BETTING_PROVIDER_LIMITS
          .PROVIDER_REQUEST_ID_MAX_LENGTH
    ) {
      throw new VtuProviderError(
        "The provider request ID is invalid.",
        {
          kind: "validation",
        }
      );
    }
  } else {
    requestId =
      buildBettingRequestId(transactionId);
  }

  /*
   * Requery is deliberately a separate operation.
   * It never calls /betting and therefore never creates a
   * second funding request.
   */
  const { data } =
    await authenticatedRequest(
      "/requery",
      {
        method: "POST",
        operation: "requery",
        body: {
          request_id:
            requestId,
        },
      }
    );

  const normalized =
    normalizePurchaseResponse(data);

  return {
    ...normalized,

    provider:
      resolved.provider,

    serviceId:
      resolved.serviceId,

    customerId:
      normalizedCustomerId,

    requestId,

    providerRequestId:
      normalized.providerRequestId ||
      requestId,
  };
}

async function checkBettingStatus({
  provider,
  serviceId,
  customerId,
  transactionId,
  providerRequestId,
}) {
  return requeryBetting({
    provider,
    serviceId,
    customerId,
    transactionId,
    providerRequestId,
  });
}

module.exports = {
  VTU_BETTING_SERVICE_IDS: Object.freeze({
    "1xbet": "1xBet",
    bangbet: "BangBet",
    bet9ja: "Bet9ja",
    betking: "BetKing",
    betland: "BetLand",
    betlion: "BetLion",
    betway: "BetWay",
    cloudbet: "CloudBet",
    livescorebet: "LiveScoreBet",
    merrybet: "MerryBet",
    naijabet: "NaijaBet",
    nairabet: "NairaBet",
    sportybet: "SportyBet",
    supabet: "SupaBet",
  }),

  validateBettingProvider,
  validateBettingCustomer,
  validateBettingAmount,
  buildBettingRequestId,

  verifyBettingCustomer,
  fundBettingAccount,
  requeryBetting,
  checkBettingStatus,

  normalizePurchaseResponse,

  VtuProviderError,
};