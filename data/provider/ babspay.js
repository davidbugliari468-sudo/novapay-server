"use strict";

const DEFAULT_BASE_URL = "https://babspay.com.ng";
const DEFAULT_TIMEOUT_MS = 15000;

const PURCHASE_PATH = "/api/data/";
const BALANCE_PATH = "/api/user/";
const REQUERY_PATH = "/api/transaction/status";
const DATA_PLANS_PATH = "/api/data_plans";

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,150}$/;
const SAFE_PLAN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const NETWORK_PATTERN = /^[0-9]{1,10}$/;
const NIGERIAN_LOCAL_PHONE_PATTERN = /^0[789][0-9]{9}$/;

function getConfig() {
  const apiKey = String(process.env.BABSPAY_API_KEY || "").trim();

  if (!apiKey) {
    const error = new Error("BabsPay API key is not configured.");
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

  const timeoutValue = Number(
    process.env.BABSPAY_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
  );

  const timeoutMs =
    Number.isFinite(timeoutValue) &&
    timeoutValue >= 1000 &&
    timeoutValue <= 60000
      ? Math.floor(timeoutValue)
      : DEFAULT_TIMEOUT_MS;

  return {
    apiKey,
    baseUrl,
    timeoutMs,
  };
}

function createProviderError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = Boolean(details.retryable);
  error.httpStatus = details.httpStatus ?? null;
  error.providerResponse = details.providerResponse ?? null;
  return error;
}

function normalizePhoneNumber(value) {
  const phone = String(value || "").trim().replace(/\s+/g, "");

  if (phone.startsWith("+234")) {
    const localPhone = `0${phone.slice(4)}`;

    if (NIGERIAN_LOCAL_PHONE_PATTERN.test(localPhone)) {
      return localPhone;
    }
  }

  if (phone.startsWith("234")) {
    const localPhone = `0${phone.slice(3)}`;

    if (NIGERIAN_LOCAL_PHONE_PATTERN.test(localPhone)) {
      return localPhone;
    }
  }

  if (NIGERIAN_LOCAL_PHONE_PATTERN.test(phone)) {
    return phone;
  }

  throw createProviderError(
    "Invalid Nigerian phone number.",
    "BABSPAY_INVALID_PHONE"
  );
}

function normalizeNetwork(value) {
  const network = String(value ?? "").trim();

  if (!NETWORK_PATTERN.test(network)) {
    throw createProviderError(
      "Invalid BabsPay network ID.",
      "BABSPAY_INVALID_NETWORK"
    );
  }

  return network;
}

function normalizePlanId(value) {
  const planId = String(value ?? "").trim();

  if (!SAFE_PLAN_ID_PATTERN.test(planId)) {
    throw createProviderError(
      "Invalid BabsPay data plan ID.",
      "BABSPAY_INVALID_PLAN_ID"
    );
  }

  return planId;
}

function normalizeReference(value) {
  const reference = String(value ?? "").trim();

  if (!SAFE_REFERENCE_PATTERN.test(reference)) {
    throw createProviderError(
      "Invalid transaction reference.",
      "BABSPAY_INVALID_REFERENCE"
    );
  }

  return reference;
}

function safeString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const result = String(value).trim();

  return result || null;
}

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

async function parseResponseBody(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text.slice(0, 5000),
    };
  }
}

async function request({
  method,
  path,
  body = undefined,
  timeoutMs,
}) {
  const config = getConfig();

  const controller = new AbortController();

  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) &&
    timeoutMs >= 1000 &&
    timeoutMs <= 60000
      ? Math.floor(timeoutMs)
      : config.timeoutMs;

  const timeout = setTimeout(() => {
    controller.abort();
  }, effectiveTimeoutMs);

  const headers = {
    Accept: "application/json",
    Authorization: `Token ${config.apiKey}`,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;

  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw createProviderError(
        "BabsPay request timed out.",
        "BABSPAY_TIMEOUT",
        {
          retryable: true,
        }
      );
    }

    throw createProviderError(
      "Unable to reach BabsPay.",
      "BABSPAY_NETWORK_ERROR",
      {
        retryable: true,
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  const providerResponse = await parseResponseBody(response);

  if (response.status === 401 || response.status === 403) {
    throw createProviderError(
      "BabsPay authentication was rejected.",
      "BABSPAY_AUTH_FAILED",
      {
        retryable: false,
        httpStatus: response.status,
        providerResponse,
      }
    );
  }

  if (response.status === 429) {
    throw createProviderError(
      "BabsPay rate limit reached.",
      "BABSPAY_RATE_LIMITED",
      {
        retryable: true,
        httpStatus: response.status,
        providerResponse,
      }
    );
  }

  if (response.status >= 500) {
    throw createProviderError(
      "BabsPay service is temporarily unavailable.",
      "BABSPAY_SERVER_ERROR",
      {
        retryable: true,
        httpStatus: response.status,
        providerResponse,
      }
    );
  }

  if (!response.ok) {
    throw createProviderError(
      "BabsPay rejected the request.",
      "BABSPAY_HTTP_ERROR",
      {
        retryable: false,
        httpStatus: response.status,
        providerResponse,
      }
    );
  }

  return {
    httpStatus: response.status,
    response: providerResponse,
  };
}

function getPurchaseStatus(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return "unknown";
  }

  const status = normalizeStatus(
    providerResponse.status ?? providerResponse.Status
  );

  if (status === "success" || status === "successful") {
    return "successful";
  }

  if (
    status === "pending" ||
    status === "processing" ||
    status === "queued"
  ) {
    return "pending";
  }

  if (
    status === "fail" ||
    status === "failed" ||
    status === "failure"
  ) {
    return "failed";
  }

  if (status === "reversed" || status === "reverse") {
    return "reversed";
  }

  return "unknown";
}

function getProviderReference(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return null;
  }

  const candidates = [
    providerResponse.ref,
    providerResponse.data?.ref,
    providerResponse.ident,
  ];

  for (const candidate of candidates) {
    const value = safeString(candidate);

    if (value && SAFE_REFERENCE_PATTERN.test(value)) {
      return value;
    }
  }

  return null;
}

function getCustomerReference(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return null;
  }

  return (
    safeString(providerResponse.customer_ref) ||
    safeString(providerResponse.customerReference)
  );
}

function getProviderPlanId(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return null;
  }

  return (
    safeString(providerResponse.plan) ||
    safeString(providerResponse.plan_id) ||
    safeString(providerResponse.data_plan)
  );
}

function getProviderNetwork(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return null;
  }

  return (
    safeString(providerResponse.network) ||
    safeString(providerResponse.network_id)
  );
}

function getProviderPhone(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return null;
  }

  return (
    safeString(providerResponse.mobile_number) ||
    safeString(providerResponse.phone) ||
    safeString(providerResponse.phone_number)
  );
}

function getProviderAmountNaira(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return null;
  }

  const value =
    providerResponse.plan_amount ??
    providerResponse.amount ??
    providerResponse.price ??
    providerResponse.data?.amount;

  if (value === null || value === undefined || value === "") {
    return null;
  }

  const amount = Number(String(value).replace(/,/g, ""));

  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function verifyPurchaseIdentity({
  providerResponse,
  requestReference,
  requestPlanId,
  requestNetwork,
  requestPhone,
}) {
  const providerReference = getProviderReference(providerResponse);
  const customerReference = getCustomerReference(providerResponse);
  const providerPlanId = getProviderPlanId(providerResponse);
  const providerNetwork = getProviderNetwork(providerResponse);
  const providerPhone = getProviderPhone(providerResponse);

  const mismatches = [];

  if (customerReference && customerReference !== requestReference) {
    mismatches.push("customer_reference");
  }

  if (providerPlanId && providerPlanId !== requestPlanId) {
    mismatches.push("plan_id");
  }

  if (providerNetwork && providerNetwork !== requestNetwork) {
    mismatches.push("network");
  }

  if (providerPhone) {
    try {
      const normalizedProviderPhone = normalizePhoneNumber(providerPhone);

      if (normalizedProviderPhone !== requestPhone) {
        mismatches.push("phone");
      }
    } catch {
      mismatches.push("phone");
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
    providerReference,
    customerReference,
    providerPlanId,
    providerNetwork,
    providerPhone,
  };
}

async function purchaseData({
  network,
  phoneNumber,
  planId,
  reference,
}) {
  const normalizedNetwork = normalizeNetwork(network);
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  const normalizedPlanId = normalizePlanId(planId);
  const normalizedReference = normalizeReference(reference);

  const result = await request({
    method: "POST",
    path: PURCHASE_PATH,
    body: {
      network: normalizedNetwork,
      phone: normalizedPhone,
      ref: normalizedReference,
      data_plan: normalizedPlanId,
    },
  });

  const providerResponse = result.response;
  const status = getPurchaseStatus(providerResponse);

  const identity = verifyPurchaseIdentity({
    providerResponse,
    requestReference: normalizedReference,
    requestPlanId: normalizedPlanId,
    requestNetwork: normalizedNetwork,
    requestPhone: normalizedPhone,
  });

  if (status === "successful" && !identity.providerReference) {
    return {
      ok: false,
      outcome: "unknown",
      httpStatus: result.httpStatus,
      providerReference: null,
      customerReference: identity.customerReference,
      providerPlanId: identity.providerPlanId,
      providerNetwork: identity.providerNetwork,
      providerPhone: identity.providerPhone,
      providerAmountNaira: getProviderAmountNaira(providerResponse),
      identityVerified: false,
      identityMismatches: ["missing_provider_reference"],
      response: providerResponse,
      errorCode: "BABSPAY_SUCCESS_MISSING_REFERENCE",
    };
  }

  if (!identity.valid) {
    return {
      ok: false,
      outcome: "unknown",
      httpStatus: result.httpStatus,
      providerReference: identity.providerReference,
      customerReference: identity.customerReference,
      providerPlanId: identity.providerPlanId,
      providerNetwork: identity.providerNetwork,
      providerPhone: identity.providerPhone,
      providerAmountNaira: getProviderAmountNaira(providerResponse),
      identityVerified: false,
      identityMismatches: identity.mismatches,
      response: providerResponse,
      errorCode: "BABSPAY_RESPONSE_MISMATCH",
    };
  }

  return {
    ok: true,
    outcome: status,
    httpStatus: result.httpStatus,
    providerReference: identity.providerReference,
    customerReference: identity.customerReference,
    providerPlanId: identity.providerPlanId,
    providerNetwork: identity.providerNetwork,
    providerPhone: identity.providerPhone,
    providerAmountNaira: getProviderAmountNaira(providerResponse),
    identityVerified: true,
    identityMismatches: [],
    response: providerResponse,
  };
}

async function getWalletBalance() {
  const result = await request({
    method: "GET",
    path: BALANCE_PATH,
  });

  const providerResponse = result.response;

  if (
    !providerResponse ||
    typeof providerResponse !== "object" ||
    normalizeStatus(providerResponse.status) !== "success"
  ) {
    throw createProviderError(
      "BabsPay returned an invalid wallet balance response.",
      "BABSPAY_INVALID_BALANCE_RESPONSE",
      {
        httpStatus: result.httpStatus,
        providerResponse,
      }
    );
  }

  const balance = Number(
    String(providerResponse.balance ?? "").replace(/,/g, "")
  );

  if (!Number.isFinite(balance) || balance < 0) {
    throw createProviderError(
      "BabsPay returned an invalid wallet balance.",
      "BABSPAY_INVALID_BALANCE",
      {
        httpStatus: result.httpStatus,
        providerResponse,
      }
    );
  }

  return {
    ok: true,
    httpStatus: result.httpStatus,
    balanceNaira: balance,
    response: providerResponse,
  };
}

async function getDataPlans({
  network = null,
  type = null,
} = {}) {
  const params = new URLSearchParams();

  if (network !== null && network !== undefined && network !== "") {
    params.set("network", normalizeNetwork(network));
  }

  if (type !== null && type !== undefined && type !== "") {
    const normalizedType = String(type).trim().toLowerCase();

    if (!/^[a-z0-9_-]{1,50}$/.test(normalizedType)) {
      throw createProviderError(
        "Invalid BabsPay data plan type.",
        "BABSPAY_INVALID_PLAN_TYPE"
      );
    }

    params.set("type", normalizedType);
  }

  const query = params.toString();

  const path = query
    ? `${DATA_PLANS_PATH}?${query}`
    : DATA_PLANS_PATH;

  const result = await request({
    method: "GET",
    path,
  });

  const providerResponse = result.response;

  if (
    !providerResponse ||
    typeof providerResponse !== "object" ||
    normalizeStatus(providerResponse.status) !== "success" ||
    !Array.isArray(providerResponse.data)
  ) {
    throw createProviderError(
      "BabsPay returned an invalid data-plan catalogue.",
      "BABSPAY_INVALID_DATA_PLANS_RESPONSE",
      {
        httpStatus: result.httpStatus,
        providerResponse,
      }
    );
  }

  return providerResponse.data;
}

function getRequeryStatus(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return "unknown";
  }

  const transaction =
    providerResponse.response &&
    typeof providerResponse.response === "object"
      ? providerResponse.response
      : null;

  if (!transaction) {
    return "unknown";
  }

  const status = normalizeStatus(transaction.status);

  if (status === "success" || status === "successful") {
    return "successful";
  }

  if (
    status === "pending" ||
    status === "processing" ||
    status === "queued"
  ) {
    return "pending";
  }

  if (
    status === "failed" ||
    status === "fail" ||
    status === "failure"
  ) {
    return "failed";
  }

  if (status === "reversed" || status === "reverse") {
    return "reversed";
  }

  return "unknown";
}

async function requeryTransaction(reference) {
  const normalizedReference = normalizeReference(reference);

  const path =
    `${REQUERY_PATH}?reference=${encodeURIComponent(normalizedReference)}`;

  const result = await request({
    method: "GET",
    path,
  });

  const providerResponse = result.response;

  if (
    providerResponse &&
    typeof providerResponse === "object" &&
    normalizeStatus(providerResponse.status) === "error"
  ) {
    const code = Number(providerResponse.code);

    if (code === 404) {
      return {
        ok: true,
        outcome: "not_found",
        httpStatus: result.httpStatus,
        providerReference: normalizedReference,
        identityVerified: false,
        response: providerResponse,
      };
    }

    return {
      ok: false,
      outcome: "unknown",
      httpStatus: result.httpStatus,
      providerReference: normalizedReference,
      identityVerified: false,
      response: providerResponse,
      errorCode: "BABSPAY_REQUERY_ERROR",
    };
  }

  const transaction =
    providerResponse &&
    typeof providerResponse.response === "object"
      ? providerResponse.response
      : null;

  if (!transaction) {
    return {
      ok: false,
      outcome: "unknown",
      httpStatus: result.httpStatus,
      providerReference: null,
      identityVerified: false,
      response: providerResponse,
      errorCode: "BABSPAY_INVALID_REQUERY_RESPONSE",
    };
  }

  const providerReference = safeString(transaction.transref);

  if (!providerReference) {
    return {
      ok: false,
      outcome: "unknown",
      httpStatus: result.httpStatus,
      providerReference: null,
      identityVerified: false,
      response: providerResponse,
      errorCode: "BABSPAY_REQUERY_MISSING_REFERENCE",
    };
  }

  if (providerReference !== normalizedReference) {
    return {
      ok: false,
      outcome: "unknown",
      httpStatus: result.httpStatus,
      providerReference,
      identityVerified: false,
      response: providerResponse,
      errorCode: "BABSPAY_REQUERY_REFERENCE_MISMATCH",
    };
  }

  const outcome = getRequeryStatus(providerResponse);

  return {
    ok: true,
    outcome,
    httpStatus: result.httpStatus,
    providerReference,
    identityVerified: true,
    amountNaira: transaction.amount ?? null,
    service: safeString(transaction.service),
    response: providerResponse,
  };
}

module.exports = {
  purchaseData,
  getWalletBalance,
  getDataPlans,
  requeryTransaction,
};