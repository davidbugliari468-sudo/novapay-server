"use strict";

const DEFAULT_BASE_URL = "https://babspay.com.ng";
const DEFAULT_TIMEOUT_MS = 15000;

const PURCHASE_PATH = "/api/data/";
const BALANCE_PATH = "/api/user/";
const REQUERY_PATH = "/api/transaction/status";

const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,150}$/;
const SAFE_PLAN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const NETWORK_PATTERN = /^[0-9]{1,10}$/;
const PHONE_PATTERN = /^0[789][01][0-9]{8}$/;

function getConfig() {
  const apiKey = String(process.env.BABSPAY_API_KEY || "").trim();

  if (!apiKey) {
    const error = new Error("BabsPay API key is not configured.");
    error.code = "BABSPAY_NOT_CONFIGURED";
    error.retryable = false;
    throw error;
  }

  const baseUrl = String(
    process.env.BABSPAY_API_BASE_URL || DEFAULT_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");

  const timeoutValue = Number(
    process.env.BABSPAY_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
  );

  const timeoutMs =
    Number.isFinite(timeoutValue) && timeoutValue >= 1000 && timeoutValue <= 60000
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

  if (!PHONE_PATTERN.test(phone)) {
    throw createProviderError(
      "Invalid Nigerian phone number.",
      "BABSPAY_INVALID_PHONE"
    );
  }

  return phone;
}

function normalizeNetwork(value) {
  const network = String(value || "").trim();

  if (!NETWORK_PATTERN.test(network)) {
    throw createProviderError(
      "Invalid BabsPay network ID.",
      "BABSPAY_INVALID_NETWORK"
    );
  }

  return network;
}

function normalizePlanId(value) {
  const planId = String(value || "").trim();

  if (!SAFE_PLAN_ID_PATTERN.test(planId)) {
    throw createProviderError(
      "Invalid BabsPay data plan ID.",
      "BABSPAY_INVALID_PLAN_ID"
    );
  }

  return planId;
}

function normalizeReference(value) {
  const reference = String(value || "").trim();

  if (!SAFE_REFERENCE_PATTERN.test(reference)) {
    throw createProviderError(
      "Invalid transaction reference.",
      "BABSPAY_INVALID_REFERENCE"
    );
  }

  return reference;
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
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs || config.timeoutMs);

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

  const status = String(
    providerResponse.status ?? providerResponse.Status ?? ""
  )
    .trim()
    .toLowerCase();

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

  if (
    status === "reversed" ||
    status === "reverse"
  ) {
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
    providerResponse.data && providerResponse.data.ref,
    providerResponse.ident,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();

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

  const value = String(
    providerResponse.customer_ref ||
      providerResponse.customerReference ||
      ""
  ).trim();

  return value || null;
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
  const providerReference = getProviderReference(providerResponse);
  const customerReference = getCustomerReference(providerResponse);

  if (status === "successful" && !providerReference) {
    return {
      ok: false,
      outcome: "unknown",
      httpStatus: result.httpStatus,
      providerReference: null,
      customerReference,
      response: providerResponse,
      errorCode: "BABSPAY_SUCCESS_MISSING_REFERENCE",
    };
  }

  return {
    ok: true,
    outcome: status,
    httpStatus: result.httpStatus,
    providerReference,
    customerReference,
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
    String(providerResponse.status || "").toLowerCase() !== "success"
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
    String(providerResponse.balance || "").replace(/,/g, "")
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

function getRequeryStatus(providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    return "unknown";
  }

  const transaction =
    providerResponse.response &&
    typeof providerResponse.response === "object"
      ? providerResponse.response
      : null;

  const status = String(transaction?.status || "")
    .trim()
    .toLowerCase();

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

  if (
    status === "reversed" ||
    status === "reverse"
  ) {
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
    String(providerResponse.status || "").toLowerCase() === "error"
  ) {
    const code = Number(providerResponse.code);

    if (code === 404) {
      return {
        ok: true,
        outcome: "not_found",
        httpStatus: result.httpStatus,
        providerReference: normalizedReference,
        response: providerResponse,
      };
    }
  }

  const outcome = getRequeryStatus(providerResponse);

  const transaction =
    providerResponse &&
    typeof providerResponse.response === "object"
      ? providerResponse.response
      : null;

  const providerReference = String(
    transaction?.transref || normalizedReference
  ).trim();

  return {
    ok: true,
    outcome,
    httpStatus: result.httpStatus,
    providerReference,
    amountNaira: transaction?.amount ?? null,
    response: providerResponse,
  };
}

module.exports = {
  purchaseData,
  getWalletBalance,
  requeryTransaction,
};