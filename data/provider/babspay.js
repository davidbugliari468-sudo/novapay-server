"use strict";

const DEFAULT_BASE_URL = "https://babspay.com.ng";
const DEFAULT_TIMEOUT_MS = 15000;

const PURCHASE_PATH = "/api/data/";
const BALANCE_PATH = "/api/user/";
const REQUERY_PATH = "/api/transaction/status";
const DATA_PLANS_PATH = "/api/data_plans";

const SAFE_REFERENCE_REGEX = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_PLAN_REGEX = /^[A-Za-z0-9._:-]{1,150}$/;
const SAFE_NETWORK_REGEX = /^[A-Za-z0-9._ -]{1,50}$/;
const SAFE_PHONE_REGEX = /^(?:\+234|234|0)?[789]\d{9}$/;

function getConfig() {
  const apiKey = String(process.env.BABSPAY_API_KEY || "").trim();

  if (!apiKey) {
    const error = new Error("BABSPAY_API_KEY is not configured.");
    error.code = "BABSPAY_NOT_CONFIGURED";
    error.retryable = false;
    throw error;
  }

  const baseUrl = String(
    process.env.BABSPAY_API_BASE_URL ||
      process.env.BABSPAY_BASE_URL ||
      DEFAULT_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");

  const timeoutValue = Number(process.env.BABSPAY_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutValue) && timeoutValue > 0
      ? timeoutValue
      : DEFAULT_TIMEOUT_MS;

  return {
    apiKey,
    baseUrl,
    timeoutMs,
  };
}

function createProviderError(message, options = {}) {
  const error = new Error(message);

  error.name = "BabsPayProviderError";
  error.code = options.code || "BABSPAY_PROVIDER_ERROR";
  error.retryable = Boolean(options.retryable);
  error.httpStatus = options.httpStatus;
  error.providerResponse = options.providerResponse;

  return error;
}

function getProviderMessage(response) {
  if (!response || typeof response !== "object") {
    return "";
  }

  const candidates = [
    response.message,
    response.msg,
    response.error,
    response.description,
    response.detail,
    response.response?.message,
    response.response?.msg,
    response.response?.error,
    response.response?.description,
    response.response?.detail,
  ];

  return candidates
    .find(
      (value) =>
        typeof value === "string" && value.trim().length > 0
    )
    ?.trim() || "";
}

function getProviderCode(response) {
  if (!response || typeof response !== "object") {
    return "";
  }

  const candidates = [
    response.code,
    response.error_code,
    response.errorCode,
    response.response?.code,
    response.response?.error_code,
    response.response?.errorCode,
  ];

  const value = candidates.find(
    (candidate) =>
      typeof candidate === "string" || typeof candidate === "number"
  );

  return value === undefined || value === null ? "" : String(value).trim();
}

function isDefinitePurchaseFailureMessage(message) {
  const normalized = String(message || "").trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return [
    "insufficient funds",
    "insufficient balance",
    "insufficient wallet balance",
    "wallet balance is insufficient",
    "not enough funds",
    "not enough balance",
    "order failed",
    "order failure",
    "transaction failed",
    "transaction failure",
    "purchase failed",
    "purchase failure",
    "product unavailable",
    "data unavailable",
    "plan unavailable",
    "invalid request",
    "invalid phone",
    "invalid phone number",
    "invalid data plan",
    "invalid plan",
    "invalid network",
    "validation failed",
    "validation error",
  ].some((phrase) => normalized.includes(phrase));
}

function isDefinitePurchaseFailureCode(code) {
  const normalized = String(code || "").trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return [
    "insufficient_funds",
    "insufficient-funds",
    "insufficient_balance",
    "insufficient-balance",
    "order_failed",
    "order-failed",
    "product_unavailable",
    "product-unavailable",
    "transaction_failed",
    "transaction-failed",
    "validation_error",
    "validation-error",
    "invalid_request",
    "invalid-request",
  ].includes(normalized);
}

function normalizePurchaseHttpFailure(error) {
  if (!error || error.code !== "BABSPAY_HTTP_ERROR") {
    return null;
  }

  const httpStatus = Number(error.httpStatus);
  const providerResponse = error.providerResponse;

  /*
   * These responses do not safely prove that the purchase was rejected.
   * Leave them as thrown errors so the service keeps the reservation and
   * sends the transaction through reconciliation.
   */
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    httpStatus === 429 ||
    httpStatus >= 500
  ) {
    return null;
  }

  const providerCode = getProviderCode(providerResponse);
  const providerMessage = getProviderMessage(providerResponse);

  /*
   * BabsPay's explicit insufficient-funds response is a definite purchase
   * failure. There is no successful customer purchase to reconcile.
   */
  if (
    httpStatus === 402 ||
    isDefinitePurchaseFailureCode(providerCode) ||
    isDefinitePurchaseFailureMessage(providerMessage)
  ) {
    return {
      ok: false,
      outcome: "failed",
      code: providerCode || "BABSPAY_TRANSACTION_FAILED",
      message: providerMessage || "BabsPay rejected the data purchase.",
      providerResponse,
      httpStatus,
    };
  }

  /*
   * A normal 4xx response to the purchase request is a definite request/
   * business rejection rather than a transport ambiguity.
   */
  if (httpStatus >= 400 && httpStatus < 500) {
    return {
      ok: false,
      outcome: "failed",
      code: providerCode || "BABSPAY_TRANSACTION_FAILED",
      message: providerMessage || "BabsPay rejected the data purchase.",
      providerResponse,
      httpStatus,
    };
  }

  return null;
}

async function request(path, options = {}) {
  const config = getConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  let response;

  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...(options.body
          ? {
              "Content-Type": "application/json",
            }
          : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw createProviderError(
        "BabsPay request timed out.",
        {
          code: "BABSPAY_TIMEOUT",
          retryable: true,
        }
      );
    }

    throw createProviderError(
      "Unable to reach BabsPay.",
      {
        code: "BABSPAY_NETWORK_ERROR",
        retryable: true,
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  let data = null;
  const contentType = String(
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch (error) {
      throw createProviderError(
        "BabsPay returned invalid JSON.",
        {
          code: "BABSPAY_INVALID_JSON",
          retryable: true,
          httpStatus: response.status,
        }
      );
    }
  } else {
    const text = await response.text();

    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = {
          raw: text,
        };
      }
    }
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw createProviderError(
        "BabsPay authentication failed.",
        {
          code: "BABSPAY_AUTH_ERROR",
          retryable: false,
          httpStatus: response.status,
          providerResponse: data,
        }
      );
    }

    if (response.status === 429) {
      throw createProviderError(
        "BabsPay rate limit reached.",
        {
          code: "BABSPAY_RATE_LIMIT",
          retryable: true,
          httpStatus: response.status,
          providerResponse: data,
        }
      );
    }

    if (response.status >= 500) {
      throw createProviderError(
        "BabsPay server error.",
        {
          code: "BABSPAY_SERVER_ERROR",
          retryable: true,
          httpStatus: response.status,
          providerResponse: data,
        }
      );
    }

    throw createProviderError(
      "BabsPay request failed.",
      {
        code: "BABSPAY_HTTP_ERROR",
        retryable: false,
        httpStatus: response.status,
        providerResponse: data,
      }
    );
  }

  if (data === null || data === undefined) {
    throw createProviderError(
      "BabsPay returned an empty response.",
      {
        code: "BABSPAY_EMPTY_RESPONSE",
        retryable: true,
        httpStatus: response.status,
      }
    );
  }

  return data;
}

function normalizePurchaseStatus(response) {
  const source =
    response?.response &&
    typeof response.response === "object"
      ? response.response
      : response;

  const rawStatus = String(
    source?.status ||
      source?.transaction_status ||
      source?.transactionStatus ||
      ""
  )
    .trim()
    .toLowerCase();

  if (
    rawStatus === "success" ||
    rawStatus === "successful"
  ) {
    return "successful";
  }

  if (
    rawStatus === "pending" ||
    rawStatus === "processing" ||
    rawStatus === "queued"
  ) {
    return "pending";
  }

  if (
    rawStatus === "fail" ||
    rawStatus === "failed" ||
    rawStatus === "failure"
  ) {
    return "failed";
  }

  if (
    rawStatus === "reversed" ||
    rawStatus === "reverse"
  ) {
    return "failed";
  }

  return "unknown";
}

function getProviderReference(response) {
  const source =
    response?.response &&
    typeof response.response === "object"
      ? response.response
      : response;

  const candidates = [
    source?.transref,
    source?.transaction_reference,
    source?.transactionReference,
    source?.reference,
    source?.ref,
    source?.transaction_id,
    source?.transactionId,
  ];

  const value = candidates.find(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.trim().length > 0
  );

  return value ? value.trim() : "";
}

function getPurchaseIdentity(response) {
  const source =
    response?.response &&
    typeof response.response === "object"
      ? response.response
      : response;

  return {
    reference: String(
      source?.ref ||
        source?.reference ||
        source?.customer_ref ||
        source?.customerRef ||
        ""
    ).trim(),

    plan: String(
      source?.data_plan ||
        source?.plan ||
        source?.plan_id ||
        source?.planId ||
        ""
    ).trim(),

    network: String(
      source?.network ||
        source?.network_name ||
        source?.networkName ||
        ""
    ).trim(),

    phone: String(
      source?.phone ||
        source?.phone_number ||
        source?.phoneNumber ||
        ""
    ).trim(),
  };
}

function normalizePhone(phone) {
  const value = String(phone || "").replace(/\D/g, "");

  if (value.startsWith("234")) {
    return `0${value.slice(3)}`;
  }

  return value;
}

function identitiesMatch(expected, actual) {
  if (!expected || !actual) {
    return false;
  }

  const expectedReference = String(
    expected.reference || ""
  ).trim();

  const actualReference = String(
    actual.reference || ""
  ).trim();

  if (
    expectedReference &&
    actualReference &&
    expectedReference !== actualReference
  ) {
    return false;
  }

  const expectedPlan = String(
    expected.plan || ""
  ).trim();

  const actualPlan = String(
    actual.plan || ""
  ).trim();

  if (
    expectedPlan &&
    actualPlan &&
    expectedPlan !== actualPlan
  ) {
    return false;
  }

  const expectedNetwork = String(
    expected.network || ""
  ).trim().toLowerCase();

  const actualNetwork = String(
    actual.network || ""
  ).trim().toLowerCase();

  if (
    expectedNetwork &&
    actualNetwork &&
    expectedNetwork !== actualNetwork
  ) {
    return false;
  }

  const expectedPhone = normalizePhone(expected.phone);
  const actualPhone = normalizePhone(actual.phone);

  if (
    expectedPhone &&
    actualPhone &&
    expectedPhone !== actualPhone
  ) {
    return false;
  }

  return true;
}

function validatePurchaseInput(input) {
  if (!input || typeof input !== "object") {
    throw createProviderError(
      "Invalid BabsPay purchase input.",
      {
        code: "BABSPAY_INVALID_INPUT",
        retryable: false,
      }
    );
  }

  const network = String(input.network || "").trim();
  const phone = String(input.phone || "").trim();
  const reference = String(input.reference || input.ref || "").trim();
  const dataPlan = String(
    input.dataPlan ||
      input.data_plan ||
      input.plan ||
      ""
  ).trim();

  if (!SAFE_NETWORK_REGEX.test(network)) {
    throw createProviderError(
      "Invalid BabsPay network.",
      {
        code: "BABSPAY_INVALID_NETWORK",
        retryable: false,
      }
    );
  }

  if (!SAFE_PHONE_REGEX.test(phone)) {
    throw createProviderError(
      "Invalid BabsPay phone number.",
      {
        code: "BABSPAY_INVALID_PHONE",
        retryable: false,
      }
    );
  }

  if (!SAFE_REFERENCE_REGEX.test(reference)) {
    throw createProviderError(
      "Invalid BabsPay reference.",
      {
        code: "BABSPAY_INVALID_REFERENCE",
        retryable: false,
      }
    );
  }

  if (!SAFE_PLAN_REGEX.test(dataPlan)) {
    throw createProviderError(
      "Invalid BabsPay data plan.",
      {
        code: "BABSPAY_INVALID_PLAN",
        retryable: false,
      }
    );
  }

  return {
    network,
    phone,
    reference,
    dataPlan,
  };
}

async function purchaseData(input) {
  const purchase = validatePurchaseInput(input);

  const body = {
    network: purchase.network,
    phone: purchase.phone,
    ref: purchase.reference,
    data_plan: purchase.dataPlan,
  };

  let response;

  try {
    response = await request(PURCHASE_PATH, {
      method: "POST",
      body,
    });
  } catch (error) {
    const normalizedHttpFailure =
      normalizePurchaseHttpFailure(error);

    if (normalizedHttpFailure) {
      return normalizedHttpFailure;
    }

    throw error;
  }

  const status = normalizePurchaseStatus(response);

  const providerReference =
    getProviderReference(response);

  const identity = getPurchaseIdentity(response);

  if (status === "successful") {
    if (!providerReference) {
      return {
        ok: false,
        outcome: "unknown",
        code: "BABSPAY_MISSING_PROVIDER_REFERENCE",
        message:
          "BabsPay reported success without a provider transaction reference.",
        providerResponse: response,
      };
    }

    if (
      identity.reference ||
      identity.plan ||
      identity.network ||
      identity.phone
    ) {
      if (
        !identitiesMatch(
          {
            reference: purchase.reference,
            plan: purchase.dataPlan,
            network: purchase.network,
            phone: purchase.phone,
          },
          identity
        )
      ) {
        return {
          ok: false,
          outcome: "unknown",
          code: "BABSPAY_IDENTITY_MISMATCH",
          message:
            "BabsPay returned transaction data that does not match the purchase request.",
          providerReference,
          providerResponse: response,
        };
      }
    }

    return {
      ok: true,
      outcome: "successful",
      providerReference,
      providerResponse: response,
    };
  }

  if (status === "failed") {
    return {
      ok: false,
      outcome: "failed",
      code: "BABSPAY_TRANSACTION_FAILED",
      message: getProviderMessage(response) ||
        "BabsPay reported that the data purchase failed.",
      providerReference: providerReference || null,
      providerResponse: response,
    };
  }

  if (status === "pending") {
    return {
      ok: false,
      outcome: "pending",
      code: "BABSPAY_TRANSACTION_PENDING",
      message:
        "BabsPay is still processing the data purchase.",
      providerReference: providerReference || null,
      providerResponse: response,
    };
  }

  return {
    ok: false,
    outcome: "unknown",
    code: "BABSPAY_TRANSACTION_UNKNOWN",
    message:
      "BabsPay returned a response whose transaction outcome could not be determined.",
    providerReference: providerReference || null,
    providerResponse: response,
  };
}

async function getProviderBalance() {
  return request(BALANCE_PATH, {
    method: "GET",
  });
}

async function getDataPlans(network) {
  const networkName = String(network || "").trim();

  if (!SAFE_NETWORK_REGEX.test(networkName)) {
    throw createProviderError(
      "Invalid BabsPay network.",
      {
        code: "BABSPAY_INVALID_NETWORK",
        retryable: false,
      }
    );
  }

  const response = await request(
    `${DATA_PLANS_PATH}?network=${encodeURIComponent(networkName)}`,
    {
      method: "GET",
    }
  );

  if (!response || typeof response !== "object") {
    throw createProviderError(
      "BabsPay returned an invalid data catalogue.",
      {
        code: "BABSPAY_INVALID_CATALOGUE",
        retryable: true,
        providerResponse: response,
      }
    );
  }

  return response;
}

function getRequeryReference(response) {
  const source =
    response?.response &&
    typeof response.response === "object"
      ? response.response
      : response;

  const candidates = [
    source?.transref,
    source?.transaction_reference,
    source?.transactionReference,
    source?.reference,
    source?.ref,
  ];

  const value = candidates.find(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.trim().length > 0
  );

  return value ? value.trim() : "";
}

async function requeryAirtimeOrData(reference) {
  const safeReference = String(reference || "").trim();

  if (!SAFE_REFERENCE_REGEX.test(safeReference)) {
    throw createProviderError(
      "Invalid BabsPay transaction reference.",
      {
        code: "BABSPAY_INVALID_REFERENCE",
        retryable: false,
      }
    );
  }

  const response = await request(
    `${REQUERY_PATH}?reference=${encodeURIComponent(
      safeReference
    )}`,
    {
      method: "GET",
    }
  );

  const providerReference =
    getRequeryReference(response);

  if (!providerReference) {
    return {
      outcome: "unknown",
      code: "BABSPAY_MISSING_PROVIDER_REFERENCE",
      message:
        "BabsPay status response did not contain a transaction reference.",
      providerResponse: response,
    };
  }

  if (providerReference !== safeReference) {
    return {
      outcome: "unknown",
      code: "BABSPAY_REFERENCE_MISMATCH",
      message:
        "BabsPay returned a different transaction reference.",
      providerReference,
      providerResponse: response,
    };
  }

  const status = normalizePurchaseStatus(response);

  if (status === "successful") {
    return {
      outcome: "successful",
      providerReference,
      providerResponse: response,
    };
  }

  if (status === "pending") {
    return {
      outcome: "pending",
      providerReference,
      providerResponse: response,
    };
  }

  if (status === "failed") {
    return {
      outcome: "failed",
      providerReference,
      providerResponse: response,
    };
  }

  const rawStatus = String(
    response?.status ||
      response?.response?.status ||
      ""
  )
    .trim()
    .toLowerCase();

  if (rawStatus === "not_found") {
    return {
      outcome: "not_found",
      providerReference,
      providerResponse: response,
    };
  }

  return {
    outcome: "unknown",
    code: "BABSPAY_TRANSACTION_UNKNOWN",
    providerReference,
    providerResponse: response,
  };
}

async function getPurchaseStatus(reference) {
  return requeryAirtimeOrData(reference);
}

async function checkDataStatus(reference) {
  return requeryAirtimeOrData(reference);
}

module.exports = {
  purchaseData,
  getProviderBalance,
  getDataPlans,
  getPurchaseStatus,
  checkDataStatus,
};