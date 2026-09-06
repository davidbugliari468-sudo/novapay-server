"use strict";

const DEFAULT_BASE_URL = "https://babspay.com.ng";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_MS = 60000;

const CATALOGUE_PATH = "/api/data_plans";

const SUPPORTED_NETWORKS = new Set(["1", "2", "3", "4"]);
const SUPPORTED_TYPES = new Set(["sme", "gifting", "corporate"]);

const NETWORK_NAMES = Object.freeze({
  "1": "MTN",
  "2": "GLO",
  "3": "Airtel",
  "4": "9mobile"
});

let catalogueCache = new Map();
let refreshPromises = new Map();

function createCatalogueError(message, code, details = {}) {
  const error = new Error(message);

  error.code = code;
  error.retryable = Boolean(details.retryable);
  error.statusCode = details.statusCode ?? null;
  error.providerResponse = details.providerResponse ?? null;

  return error;
}

function getConfig() {
  const apiKey = String(
    process.env.BABSPAY_API_KEY || ""
  ).trim();

  if (!apiKey) {
    throw createCatalogueError(
      "BabsPay API key is not configured.",
      "BABSPAY_NOT_CONFIGURED",
      {
        retryable: false
      }
    );
  }

  const baseUrl = String(
    process.env.BABSPAY_API_BASE_URL ||
      process.env.BABSPAY_BASE_URL ||
      DEFAULT_BASE_URL
  )
    .trim()
    .replace(/\/+$/, "");

  let parsedBaseUrl;

  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw createCatalogueError(
      "Invalid BabsPay API base URL.",
      "BABSPAY_INVALID_BASE_URL",
      {
        retryable: false
      }
    );
  }

  if (parsedBaseUrl.protocol !== "https:") {
    throw createCatalogueError(
      "BabsPay API base URL must use HTTPS.",
      "BABSPAY_INSECURE_BASE_URL",
      {
        retryable: false
      }
    );
  }

  const timeoutValue = Number(
    process.env.BABSPAY_CATALOG_TIMEOUT_MS ||
      DEFAULT_TIMEOUT_MS
  );

  const timeoutMs =
    Number.isFinite(timeoutValue) &&
    timeoutValue >= 1000 &&
    timeoutValue <= 60000
      ? Math.floor(timeoutValue)
      : DEFAULT_TIMEOUT_MS;

  const cacheTtlValue = Number(
    process.env.BABSPAY_CATALOG_CACHE_TTL_MS ||
      DEFAULT_CACHE_TTL_MS
  );

  const cacheTtlMs =
    Number.isFinite(cacheTtlValue) &&
    cacheTtlValue >= 5000 &&
    cacheTtlValue <= 3600000
      ? Math.floor(cacheTtlValue)
      : DEFAULT_CACHE_TTL_MS;

  return {
    apiKey,
    baseUrl: parsedBaseUrl
      .toString()
      .replace(/\/+$/, ""),
    timeoutMs,
    cacheTtlMs
  };
}

function normalizeNetwork(network) {
  if (
    network === undefined ||
    network === null ||
    network === ""
  ) {
    return null;
  }

  const value = String(network).trim();

  if (!SUPPORTED_NETWORKS.has(value)) {
    throw createCatalogueError(
      "Unsupported network.",
      "DATA_UNSUPPORTED_NETWORK"
    );
  }

  return value;
}

function normalizeType(type) {
  if (
    type === undefined ||
    type === null ||
    type === ""
  ) {
    return null;
  }

  const value = String(type)
    .trim()
    .toLowerCase();

  if (!SUPPORTED_TYPES.has(value)) {
    throw createCatalogueError(
      "Unsupported data plan type.",
      "DATA_UNSUPPORTED_PLAN_TYPE"
    );
  }

  return value;
}

function normalizePlanId(planId) {
  if (
    planId === undefined ||
    planId === null ||
    planId === ""
  ) {
    throw createCatalogueError(
      "Invalid BabsPay plan ID.",
      "DATA_INVALID_PLAN_ID"
    );
  }

  const value = String(planId).trim();

  if (
    !/^\d+$/.test(value) ||
    value.length > 30
  ) {
    throw createCatalogueError(
      "Invalid BabsPay plan ID.",
      "DATA_INVALID_PLAN_ID"
    );
  }

  return value;
}

function parseMoneyToKobo(value) {
  let normalized;

  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      value < 0
    ) {
      throw createCatalogueError(
        "Invalid BabsPay plan price.",
        "DATA_INVALID_PLAN_PRICE"
      );
    }

    normalized = value.toFixed(2);
  } else if (typeof value === "string") {
    normalized = value
      .trim()
      .replace(/,/g, "");
  } else {
    throw createCatalogueError(
      "Invalid BabsPay plan price.",
      "DATA_INVALID_PLAN_PRICE"
    );
  }

  if (
    !/^\d+(?:\.\d{1,2})?$/.test(
      normalized
    )
  ) {
    throw createCatalogueError(
      "Invalid BabsPay plan price.",
      "DATA_INVALID_PLAN_PRICE"
    );
  }

  const [
    nairaPart,
    decimalPart = ""
  ] = normalized.split(".");

  const naira = Number(nairaPart);

  if (
    !Number.isSafeInteger(naira) ||
    naira < 0
  ) {
    throw createCatalogueError(
      "Invalid BabsPay plan price.",
      "DATA_INVALID_PLAN_PRICE"
    );
  }

  const paddedDecimal =
    decimalPart.padEnd(2, "0");

  const koboDecimal = Number(
    paddedDecimal.slice(0, 2)
  );

  const kobo =
    naira * 100 + koboDecimal;

  if (
    !Number.isSafeInteger(kobo) ||
    kobo < 0
  ) {
    throw createCatalogueError(
      "Invalid BabsPay plan price.",
      "DATA_INVALID_PLAN_PRICE"
    );
  }

  return kobo;
}

function normalizeStatus(status) {
  return String(status ?? "")
    .trim()
    .toLowerCase();
}

function resolveNetworkName(
  networkId,
  providerNetworkName
) {
  const suppliedName = String(
    providerNetworkName ?? ""
  ).trim();

  if (suppliedName) {
    return suppliedName;
  }

  return NETWORK_NAMES[networkId] || null;
}

function resolvePlanName(rawPlan) {
  const planName = String(
    rawPlan.plan_name ??
      rawPlan.name ??
      ""
  ).trim();

  return planName || null;
}

function resolvePlanType(rawPlan) {
  const planType = String(
    rawPlan.plan_type ??
      rawPlan.type ??
      ""
  )
    .trim()
    .toLowerCase();

  return planType || null;
}

function resolveNetworkProviderName(rawPlan) {
  return (
    rawPlan.network_name ??
    rawPlan.network ??
    ""
  );
}

function normalizePlan(rawPlan) {
  if (
    !rawPlan ||
    typeof rawPlan !== "object" ||
    Array.isArray(rawPlan)
  ) {
    throw createCatalogueError(
      "Invalid BabsPay plan record.",
      "DATA_INVALID_PLAN_RECORD"
    );
  }

  const planId = normalizePlanId(
    rawPlan.plan_id
  );

  const networkId = String(
    rawPlan.network_id ?? ""
  ).trim();

  if (
    !SUPPORTED_NETWORKS.has(networkId)
  ) {
    throw createCatalogueError(
      `Invalid network for BabsPay plan ${planId}.`,
      "DATA_INVALID_PLAN_NETWORK"
    );
  }

  const networkName =
    resolveNetworkName(
      networkId,
      resolveNetworkProviderName(
        rawPlan
      )
    );

  if (!networkName) {
    throw createCatalogueError(
      `Unable to resolve network name for BabsPay plan ${planId}.`,
      "DATA_INVALID_PLAN_NETWORK_NAME"
    );
  }

  const planName =
    resolvePlanName(rawPlan);

  if (!planName) {
    throw createCatalogueError(
      `Missing plan name for BabsPay plan ${planId}.`,
      "DATA_INVALID_PLAN_NAME"
    );
  }

  const planType =
    resolvePlanType(rawPlan);

  if (
    !planType ||
    !SUPPORTED_TYPES.has(planType)
  ) {
    throw createCatalogueError(
      `Invalid plan type for BabsPay plan ${planId}.`,
      "DATA_INVALID_PLAN_TYPE"
    );
  }

  const validity = String(
    rawPlan.validity ?? ""
  ).trim();

  if (!validity) {
    throw createCatalogueError(
      `Missing validity for BabsPay plan ${planId}.`,
      "DATA_INVALID_PLAN_VALIDITY"
    );
  }

  const status = normalizeStatus(
    rawPlan.status
  );

  if (status !== "active") {
    throw createCatalogueError(
      `Inactive BabsPay plan received: ${planId}.`,
      "DATA_INACTIVE_PLAN"
    );
  }

  const providerPriceKobo =
    parseMoneyToKobo(
      rawPlan.price
    );

  const planCode =
    rawPlan.plan_code === undefined ||
    rawPlan.plan_code === null
      ? null
      : String(
          rawPlan.plan_code
        ).trim();

  return Object.freeze({
    planId,
    planCode,
    networkId,
    networkName,
    planName,
    planType,
    providerPriceKobo,
    priceKobo: providerPriceKobo,
    validity,
    status: "active"
  });
}

function createRequestUrl(
  baseUrl,
  network,
  type
) {
  const url = new URL(
    `${baseUrl}${CATALOGUE_PATH}`
  );

  if (network) {
    url.searchParams.set(
      "network",
      network
    );
  }

  if (type) {
    url.searchParams.set(
      "type",
      type
    );
  }

  return url;
}

async function requestJson(
  url,
  timeoutMs,
  apiKey
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Token ${apiKey}`,
        "User-Agent":
          "NovaPay-DataCatalog/1.0"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (
      error &&
      error.name === "AbortError"
    ) {
      throw createCatalogueError(
        "BabsPay catalogue request timed out.",
        "BABSPAY_CATALOG_TIMEOUT",
        {
          retryable: true
        }
      );
    }

    throw createCatalogueError(
      "Unable to reach BabsPay data catalogue.",
      "BABSPAY_CATALOG_REQUEST_ERROR",
      {
        retryable: true
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  const text =
    await response.text();

  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw createCatalogueError(
        "BabsPay returned invalid catalogue JSON.",
        "BABSPAY_INVALID_JSON",
        {
          retryable: true,
          statusCode:
            response.status
        }
      );
    }
  }

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    throw createCatalogueError(
      "BabsPay catalogue authentication was rejected.",
      "BABSPAY_AUTH_ERROR",
      {
        retryable: false,
        statusCode:
          response.status,
        providerResponse: payload
      }
    );
  }

  if (response.status === 429) {
    throw createCatalogueError(
      "BabsPay catalogue rate limit reached.",
      "BABSPAY_RATE_LIMITED",
      {
        retryable: true,
        statusCode:
          response.status,
        providerResponse: payload
      }
    );
  }

  if (response.status >= 500) {
    throw createCatalogueError(
      "BabsPay catalogue service is temporarily unavailable.",
      "BABSPAY_PROVIDER_ERROR",
      {
        retryable: true,
        statusCode:
          response.status,
        providerResponse: payload
      }
    );
  }

  if (!response.ok) {
    throw createCatalogueError(
      "BabsPay rejected the catalogue request.",
      "BABSPAY_HTTP_ERROR",
      {
        retryable: false,
        statusCode:
          response.status,
        providerResponse: payload
      }
    );
  }

  return {
    statusCode: response.status,
    payload
  };
}

function validateCatalogueResponse(
  payload
) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw createCatalogueError(
      "Invalid BabsPay catalogue response.",
      "BABSPAY_INVALID_CATALOGUE_RESPONSE"
    );
  }

  if (
    normalizeStatus(payload.status) !==
    "success"
  ) {
    throw createCatalogueError(
      "BabsPay did not return a successful catalogue response.",
      "BABSPAY_CATALOGUE_NOT_SUCCESSFUL",
      {
        providerResponse: payload
      }
    );
  }

  if (!Array.isArray(payload.data)) {
    throw createCatalogueError(
      "BabsPay catalogue response contains no plan list.",
      "BABSPAY_CATALOGUE_NO_PLANS",
      {
        providerResponse: payload
      }
    );
  }

  return payload.data;
}

function normalizeCatalogue(
  rawPlans
) {
  if (!Array.isArray(rawPlans)) {
    throw createCatalogueError(
      "BabsPay catalogue is not a plan array.",
      "DATA_INVALID_CATALOGUE"
    );
  }

  const plans = [];
  const seenPlanIds = new Set();

  for (const rawPlan of rawPlans) {
    const plan = normalizePlan(
      rawPlan
    );

    if (
      seenPlanIds.has(plan.planId)
    ) {
      throw createCatalogueError(
        `Duplicate BabsPay plan ID: ${plan.planId}.`,
        "DATA_DUPLICATE_PLAN_ID"
      );
    }

    seenPlanIds.add(plan.planId);
    plans.push(plan);
  }

  plans.sort((a, b) => {
    if (
      a.networkId !== b.networkId
    ) {
      return (
        Number(a.networkId) -
        Number(b.networkId)
      );
    }

    if (
      a.providerPriceKobo !==
      b.providerPriceKobo
    ) {
      return (
        a.providerPriceKobo -
        b.providerPriceKobo
      );
    }

    return a.planId.localeCompare(
      b.planId,
      undefined,
      {
        numeric: true
      }
    );
  });

  return Object.freeze(plans);
}

async function fetchPlans(
  options = {}
) {
  const config = getConfig();

  const network =
    normalizeNetwork(
      options.network
    );

  const type =
    normalizeType(
      options.type
    );

  const url =
    createRequestUrl(
      config.baseUrl,
      network,
      type
    );

  const result =
    await requestJson(
      url,
      config.timeoutMs,
      config.apiKey
    );

  const rawPlans =
    validateCatalogueResponse(
      result.payload
    );

  return normalizeCatalogue(
    rawPlans
  );
}

function buildCacheKey(
  network,
  type
) {
  return `${network || "all"}:${type || "all"}`;
}

function getCachedEntry(key) {
  const entry =
    catalogueCache.get(key);

  if (!entry) {
    return null;
  }

  if (
    entry.expiresAt <= Date.now()
  ) {
    catalogueCache.delete(key);
    return null;
  }

  return entry;
}

async function getPlans(
  options = {}
) {
  const network =
    normalizeNetwork(
      options.network
    );

  const type =
    normalizeType(
      options.type
    );

  const forceRefresh =
    options.forceRefresh === true;

  const cacheKey =
    buildCacheKey(
      network,
      type
    );

  if (!forceRefresh) {
    const cached =
      getCachedEntry(cacheKey);

    if (cached) {
      return cached.plans;
    }
  }

  if (!forceRefresh) {
    const existingRefresh =
      refreshPromises.get(
        cacheKey
      );

    if (existingRefresh) {
      return existingRefresh;
    }
  }

  const refreshPromise =
    fetchPlans({
      network,
      type
    })
      .then((plans) => {
        const fetchedAt =
          Date.now();

        const config =
          getConfig();

        catalogueCache.set(
          cacheKey,
          {
            plans,
            fetchedAt,
            expiresAt:
              fetchedAt +
              config.cacheTtlMs
          }
        );

        return plans;
      })
      .finally(() => {
        refreshPromises.delete(
          cacheKey
        );
      });

  refreshPromises.set(
    cacheKey,
    refreshPromise
  );

  return refreshPromise;
}

async function getPlanById(
  planId,
  options = {}
) {
  const normalizedPlanId =
    normalizePlanId(planId);

  const plans =
    await getPlans({
      network: options.network,
      type: options.type,
      forceRefresh:
        options.forceRefresh === true
    });

  return (
    plans.find(
      (plan) =>
        plan.planId ===
        normalizedPlanId
    ) || null
  );
}

async function requirePlan(
  planId,
  options = {}
) {
  const plan =
    await getPlanById(
      planId,
      options
    );

  if (!plan) {
    throw createCatalogueError(
      "Data plan is not available.",
      "DATA_PLAN_NOT_FOUND"
    );
  }

  if (
    plan.status !== "active"
  ) {
    throw createCatalogueError(
      "Data plan is not active.",
      "DATA_PLAN_NOT_ACTIVE"
    );
  }

  if (
    options.network !==
      undefined &&
    options.network !== null &&
    String(plan.networkId) !==
      String(options.network)
  ) {
    throw createCatalogueError(
      "Data plan does not belong to the selected network.",
      "DATA_PLAN_NETWORK_MISMATCH"
    );
  }

  if (
    options.type !==
      undefined &&
    options.type !== null &&
    String(
      plan.planType
    ).toLowerCase() !==
      String(
        options.type
      ).toLowerCase()
  ) {
    throw createCatalogueError(
      "Data plan type mismatch.",
      "DATA_PLAN_TYPE_MISMATCH"
    );
  }

  return plan;
}

function clearCache() {
  catalogueCache.clear();
  refreshPromises.clear();
}

function getNetworkName(network) {
  const normalizedNetwork =
    normalizeNetwork(network);

  if (!normalizedNetwork) {
    return null;
  }

  return (
    NETWORK_NAMES[
      normalizedNetwork
    ] || null
  );
}

module.exports = {
  fetchPlans,
  getPlans,
  getPlanById,
  requirePlan,
  clearCache,
  getNetworkName,
  normalizeNetwork,
  normalizeType,
  normalizePlanId,
  parseMoneyToKobo
};