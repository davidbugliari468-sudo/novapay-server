// betting/vtu.js

const crypto = require("crypto");

const {
  getAccessToken,
  clearAccessToken,
  VtuProviderError,
} = require("../airtime/vtu");

const {
  BETTING_SERVICES,
  BETTING_LIMITS,
  BETTING_SUCCESS_STATUSES,
  BETTING_FAILURE_STATUSES,
  isBettingDefiniteFailureCode,
  isBettingDefiniteFailureMessage,
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

const VTU_BETTING_SERVICE_IDS = Object.freeze({
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
});

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

function getVtuBettingServiceId(provider) {
  const normalized = normalizeProvider(provider);
  return VTU_BETTING_SERVICE_IDS[normalized] || null;
}

function validateBettingProvider(provider) {
  const normalized = validateProvider(provider);

  if (!BETTING_SERVICES.includes(normalized)) {
    throw new VtuProviderError("Unsupported betting provider.", {
      kind: "validation",
    });
  }

  if (!getVtuBettingServiceId(normalized)) {
    throw new VtuProviderError("Unsupported betting provider.", {
      kind: "validation",
    });
  }

  return normalized;
}

function validateBettingCustomer(customerId) {
  const normalized = validateCustomerId(customerId);

  if (!normalized) {
    throw new VtuProviderError("A valid betting customer ID is required.", {
      kind: "validation",
    });
  }

  return normalized;
}

function validateBettingAmount(amountKobo) {
  const amount = validateAmountKobo(amountKobo);

  if (!Number.isInteger(amount)) {
    throw new VtuProviderError("A valid betting amount is required.", {
      kind: "validation",
    });
  }

  if (amount < BETTING_LIMITS.MIN_AMOUNT_KOBO) {
    throw new VtuProviderError("The betting amount is below the minimum.", {
      kind: "validation",
    });
  }

  if (amount > BETTING_LIMITS.MAX_AMOUNT_KOBO) {
    throw new VtuProviderError("The betting amount is above the maximum.", {
      kind: "validation",
    });
  }

  return amount;
}

function buildBettingRequestId(transactionId) {
  const normalizedTransactionId = validateTransactionId(transactionId);

  if (!normalizedTransactionId) {
    throw new VtuProviderError(
      "A valid transaction ID is required for betting.",
      {
        kind: "validation",
      }
    );
  }

  const digest = crypto
    .createHash("sha256")
    .update(normalizedTransactionId)
    .digest("hex");

  const requestId = `NPBET${digest.slice(0, 45)}`;

  if (requestId.length > BETTING_LIMITS.PROVIDER_REQUEST_ID_MAX_LENGTH) {
    throw new VtuProviderError("The betting request ID is invalid.", {
      kind: "validation",
    });
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
      throw new VtuProviderError("VTU.ng request timed out.", {
        kind: "timeout",
      });
    }

    throw new VtuProviderError("Unable to reach VTU.ng.", {
      kind: "network",
      rawMessage: error && error.message ? error.message : null,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    throw new VtuProviderError("VTU.ng returned an empty response.", {
      kind: "unknown",
      httpStatus: response.status,
    });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new VtuProviderError("VTU.ng returned an invalid response.", {
      kind: "unknown",
      httpStatus: response.status,
    });
  }
}

function extractPayload(data) {
  if (!data || typeof data !== "object") {
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
    payload.request_id ||
    payload.requestId ||
    payload.order_id ||
    payload.orderId ||
    payload.ref ||
    data?.reference ||
    data?.transaction_id ||
    data?.transactionId ||
    data?.request_id ||
    data?.requestId ||
    data?.order_id ||
    data?.orderId ||
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

  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
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

  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}

function getObjectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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
    hasReference: Boolean(extractProviderReference(data)),
    hasCustomerId: Boolean(extractCustomerId(data)),
    hasCustomerName: Boolean(extractCustomerName(data)),
    hasBalance: extractCustomerBalance(data) !== null,
    hasAmount: extractAmount(data) !== null,
  };
}

function logProviderErrorResponse(path, response, data) {
  const diagnostic = buildSafeResponseDiagnostic(data);

  console.error("[VTU BETTING PROVIDER ERROR]", {
    path,
    httpStatus: response.status,
    ...diagnostic,
  });
}

function normalizePurchaseResponse(data) {
  const code = extractProviderCode(data);
  const status = extractProviderStatus(data);
  const message = extractProviderMessage(data);
  const reference = extractProviderReference(data);

  if (
    BETTING_SUCCESS_STATUSES.includes(status) ||
    code === "success" ||
    code === "successful"
  ) {
    return {
      outcome: "success",
      providerReference: reference,
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
      providerStatus: status,
      providerCode: code,
      providerMessage: message,
      raw: data,
    };
  }

  return {
    outcome: "unknown",
    providerReference: reference,
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
    retryAuthentication = true,
  } = {}
) {
  let token;

  console.log("[VTU BETTING AUTH START]", {
    path,
    method,
  });

  try {
    token = await getAccessToken();
  } catch (error) {
    console.error("[VTU BETTING AUTH ERROR]", {
      kind: error?.kind || "unknown",
      type: error?.name || "",
      httpStatus: error?.httpStatus || null,
      providerCode: error?.providerCode || null,
      providerStatus: error?.providerStatus || null,
      message: error?.message || "Unknown authentication error",
    });

    throw error;
  }

  console.log("[VTU BETTING AUTH SUCCESS]", {
    path,
    method,
    tokenReceived: Boolean(token),
  });

  const response = await fetchWithTimeout(`${VTU_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === null ? undefined : JSON.stringify(body),
  });

  if (
    (response.status === 401 || response.status === 403) &&
    retryAuthentication
  ) {
    console.warn("[VTU BETTING AUTH REFRESH]", {
      path,
      method,
      httpStatus: response.status,
    });

    clearAccessToken();

    return authenticatedRequest(path, {
      method,
      body,
      retryAuthentication: false,
    });
  }

  const parsed = await parseJsonResponse(response);

  if (!response.ok) {
    logProviderErrorResponse(path, response, parsed);

    const code = extractProviderCode(parsed);
    const status = extractProviderStatus(parsed);
    const message =
      extractProviderMessage(parsed) ||
      `VTU.ng returned HTTP ${response.status}`;

    if (
      response.status === 400 ||
      response.status === 402 ||
      response.status === 409
    ) {
      if (
        isBettingDefiniteFailureCode(code) ||
        isBettingDefiniteFailureMessage(message)
      ) {
        throw new VtuProviderError(message, {
          kind: "provider_rejection",
          httpStatus: response.status,
          providerCode: code,
          providerStatus: status,
          rawMessage: message,
        });
      }
    }

    throw new VtuProviderError(message, {
      kind: "unknown",
      httpStatus: response.status,
      providerCode: code,
      providerStatus: status,
      rawMessage: message,
    });
  }

  return {
    response,
    data: parsed,
  };
}

async function verifyBettingCustomer({
  provider,
  customerId,
}) {
  const normalizedProvider = validateBettingProvider(provider);
  const normalizedCustomerId = validateBettingCustomer(customerId);
  const serviceId = getVtuBettingServiceId(normalizedProvider);

  const { data } = await authenticatedRequest("/verify-customer", {
    method: "POST",
    body: {
      customer_id: normalizedCustomerId,
      service_id: serviceId,
    },
  });

  const code = extractProviderCode(data);
  const returnedCustomerId = extractCustomerId(data);

  if (code !== "success" || !returnedCustomerId) {
    const diagnostic = buildSafeResponseDiagnostic(data);

    console.error("[VTU BETTING VERIFY RESPONSE]", diagnostic);

    const message =
      extractProviderMessage(data) ||
      "VTU.ng did not confirm the betting customer.";

    if (
      isBettingDefiniteFailureCode(code) ||
      isBettingDefiniteFailureMessage(message)
    ) {
      throw new VtuProviderError(message, {
        kind: "provider_rejection",
        providerCode: code,
        providerStatus: extractProviderStatus(data),
        rawMessage: message,
      });
    }

    throw new VtuProviderError(
      "VTU.ng returned an unexpected betting verification response.",
      {
        kind: "unknown",
        providerCode: code,
        providerStatus: extractProviderStatus(data),
        rawMessage: message,
      }
    );
  }

  return {
    provider: normalizedProvider,
    serviceId,
    customerId: returnedCustomerId,
    customerName: extractCustomerName(data),
    balance: extractCustomerBalance(data),
    providerCode: code,
    providerStatus: extractProviderStatus(data),
    providerReference: extractProviderReference(data),
    message:
      extractProviderMessage(data) ||
      "Betting customer verified successfully.",
  };
}

async function fundBettingAccount({
  provider,
  customerId,
  amountKobo,
  transactionId,
}) {
  const normalizedProvider = validateBettingProvider(provider);
  const normalizedCustomerId = validateBettingCustomer(customerId);
  const normalizedAmountKobo = validateBettingAmount(amountKobo);

  const serviceId = getVtuBettingServiceId(normalizedProvider);
  const requestId = buildBettingRequestId(transactionId);

  const amountNaira = Math.floor(normalizedAmountKobo / 100);

  const { data } = await authenticatedRequest("/betting", {
    method: "POST",
    body: {
      request_id: requestId,
      customer_id: normalizedCustomerId,
      service_id: serviceId,
      amount: amountNaira,
    },
  });

  return {
    ...normalizePurchaseResponse(data),
    provider: normalizedProvider,
    serviceId,
    customerId: normalizedCustomerId,
    amountKobo: normalizedAmountKobo,
    requestId,
  };
}

async function requeryBetting({
  provider,
  customerId,
  transactionId,
}) {
  const normalizedProvider = validateBettingProvider(provider);
  const normalizedCustomerId = validateBettingCustomer(customerId);
  const requestId = buildBettingRequestId(transactionId);

  const { data } = await authenticatedRequest("/requery", {
    method: "POST",
    body: {
      request_id: requestId,
      customer_id: normalizedCustomerId,
      service_id: getVtuBettingServiceId(normalizedProvider),
    },
  });

  return {
    ...normalizePurchaseResponse(data),
    provider: normalizedProvider,
    serviceId: getVtuBettingServiceId(normalizedProvider),
    customerId: normalizedCustomerId,
    requestId,
  };
}

async function checkBettingStatus({
  provider,
  customerId,
  transactionId,
}) {
  const result = await requeryBetting({
    provider,
    customerId,
    transactionId,
  });

  return result;
}

module.exports = {
  VTU_BETTING_SERVICE_IDS,
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