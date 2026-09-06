"use strict";

const https = require("https");

const BABSPAY_BASE_URL = (
  process.env.BABSPAY_BASE_URL || "https://babspay.com.ng"
).replace(/\/+$/, "");

const BABSPAY_API_KEY = String(process.env.BABSPAY_API_KEY || "").trim();

const REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.BABSPAY_CATALOG_TIMEOUT_MS || "15000",
  10
);

const CACHE_TTL_MS = Number.parseInt(
  process.env.BABSPAY_CATALOG_CACHE_TTL_MS || "60000",
  10
);

const SUPPORTED_NETWORKS = new Set(["1", "2", "3", "4"]);
const SUPPORTED_TYPES = new Set(["sme", "gifting", "corporate"]);

const NETWORK_NAMES = Object.freeze({
  "1": "MTN",
  "2": "GLO",
  "3": "Airtel",
  "4": "9mobile"
});

let catalogueCache = null;
let catalogueCacheExpiresAt = 0;
let catalogueRefreshPromise = null;

function assertConfiguration() {
  if (!BABSPAY_API_KEY) {
    throw new Error("BABSPAY_API_KEY is not configured");
  }

  if (
    !Number.isInteger(REQUEST_TIMEOUT_MS) ||
    REQUEST_TIMEOUT_MS < 1000 ||
    REQUEST_TIMEOUT_MS > 60000
  ) {
    throw new Error("Invalid BABSPAY_CATALOG_TIMEOUT_MS configuration");
  }

  if (
    !Number.isInteger(CACHE_TTL_MS) ||
    CACHE_TTL_MS < 5000 ||
    CACHE_TTL_MS > 3600000
  ) {
    throw new Error("Invalid BABSPAY_CATALOG_CACHE_TTL_MS configuration");
  }
}

function normalizeNetwork(network) {
  if (network === undefined || network === null || network === "") {
    return null;
  }

  const value = String(network).trim();

  if (!SUPPORTED_NETWORKS.has(value)) {
    throw new Error("Unsupported network");
  }

  return value;
}

function normalizeType(type) {
  if (type === undefined || type === null || type === "") {
    return null;
  }

  const value = String(type).trim().toLowerCase();

  if (!SUPPORTED_TYPES.has(value)) {
    throw new Error("Unsupported data plan type");
  }

  return value;
}

function normalizePlanId(planId) {
  if (planId === undefined || planId === null) {
    throw new Error("Invalid BabsPay plan ID");
  }

  const value = String(planId).trim();

  if (!/^\d+$/.test(value)) {
    throw new Error("Invalid BabsPay plan ID");
  }

  if (value.length > 30) {
    throw new Error("BabsPay plan ID is too long");
  }

  return value;
}

function parseMoneyToKobo(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Invalid BabsPay plan price");
    }

    return Math.round(value * 100);
  }

  if (typeof value !== "string") {
    throw new Error("Invalid BabsPay plan price");
  }

  const normalized = value.trim().replace(/,/g, "");

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Invalid BabsPay plan price");
  }

  const [nairaPart, decimalPart = ""] = normalized.split(".");

  const naira = Number.parseInt(nairaPart, 10);

  if (!Number.isSafeInteger(naira) || naira < 0) {
    throw new Error("Invalid BabsPay plan price");
  }

  const decimal = Number(
    decimalPart.padEnd(2, "0").slice(0, 2)
  );

  const kobo = naira * 100 + decimal;

  if (!Number.isSafeInteger(kobo) || kobo < 0) {
    throw new Error("Invalid BabsPay plan price");
  }

  return kobo;
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function normalizePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    throw new Error("Invalid BabsPay plan record");
  }

  const planId = normalizePlanId(rawPlan.plan_id);

  const networkId = String(rawPlan.network_id ?? "").trim();

  if (!SUPPORTED_NETWORKS.has(networkId)) {
    throw new Error(`Invalid network for BabsPay plan ${planId}`);
  }

  const networkName = String(rawPlan.network_name || "").trim();

  if (!networkName) {
    throw new Error(`Missing network name for BabsPay plan ${planId}`);
  }

  const planName = String(rawPlan.plan_name || "").trim();

  if (!planName) {
    throw new Error(`Missing plan name for BabsPay plan ${planId}`);
  }

  const planType = String(rawPlan.plan_type || "").trim().toLowerCase();

  if (!SUPPORTED_TYPES.has(planType)) {
    throw new Error(`Invalid plan type for BabsPay plan ${planId}`);
  }

  const validity = String(rawPlan.validity || "").trim();

  if (!validity) {
    throw new Error(`Missing validity for BabsPay plan ${planId}`);
  }

  const status = normalizeStatus(rawPlan.status);

  if (status !== "active") {
    throw new Error(`Inactive BabsPay plan received: ${planId}`);
  }

  const priceKobo = parseMoneyToKobo(rawPlan.price);

  const planCode =
    rawPlan.plan_code === undefined ||
    rawPlan.plan_code === null
      ? null
      : String(rawPlan.plan_code).trim();

  return Object.freeze({
    planId,
    planCode,
    networkId,
    networkName,
    planName,
    planType,
    priceKobo,
    validity,
    status: "active"
  });
}

function createRequestUrl(network, type) {
  const url = new URL(
    `${BABSPAY_BASE_URL}/api/data_plans`
  );

  if (network) {
    url.searchParams.set("network", network);
  }

  if (type) {
    url.searchParams.set("type", type);
  }

  return url;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Token ${BABSPAY_API_KEY}`,
          "User-Agent": "NovaPay-DataCatalog/1.0"
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");

        response.on("data", (chunk) => {
          body += chunk;

          if (body.length > 2 * 1024 * 1024) {
            request.destroy(
              new Error("BabsPay catalogue response is too large")
            );
          }
        });

        response.on("end", () => {
          const statusCode = response.statusCode || 0;

          let parsed;

          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            const error = new Error(
              "BabsPay returned invalid JSON"
            );

            error.code = "BABSPAY_INVALID_JSON";
            error.statusCode = statusCode;

            reject(error);
            return;
          }

          if (statusCode < 200 || statusCode >= 300) {
            const error = new Error(
              `BabsPay catalogue request failed with HTTP ${statusCode}`
            );

            error.code =
              statusCode === 401 || statusCode === 403
                ? "BABSPAY_AUTH_ERROR"
                : statusCode === 429
                  ? "BABSPAY_RATE_LIMITED"
                  : statusCode >= 500
                    ? "BABSPAY_PROVIDER_ERROR"
                    : "BABSPAY_HTTP_ERROR";

            error.statusCode = statusCode;

            reject(error);
            return;
          }

          resolve(parsed);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("BabsPay catalogue request timed out"));
    });

    request.on("error", (error) => {
      const wrappedError = new Error(
        "Unable to retrieve Data plans from BabsPay"
      );

      wrappedError.code = "BABSPAY_CATALOG_REQUEST_ERROR";
      wrappedError.cause = error;

      reject(wrappedError);
    });

    request.end();
  });
}

function validateCatalogueResponse(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("Invalid BabsPay catalogue response");
  }

  if (String(payload.status || "").trim().toLowerCase() !== "success") {
    const error = new Error(
      "BabsPay did not return a successful catalogue response"
    );

    error.code = "BABSPAY_CATALOGUE_NOT_SUCCESSFUL";
    throw error;
  }

  if (!Array.isArray(payload.data)) {
    throw new Error("BabsPay catalogue response contains no plan list");
  }

  return payload.data;
}

function normalizeCatalogue(rawPlans) {
  const plans = [];
  const seenPlanIds = new Set();

  for (const rawPlan of rawPlans) {
    try {
      const plan = normalizePlan(rawPlan);

      if (seenPlanIds.has(plan.planId)) {
        throw new Error(
          `Duplicate BabsPay plan ID: ${plan.planId}`
        );
      }

      seenPlanIds.add(plan.planId);
      plans.push(plan);
    } catch (error) {
      /*
       * Invalid/inactive records are ignored rather than allowing
       * one bad provider record to destroy the entire catalogue.
       *
       * The purchase service will only be able to use plans that
       * successfully pass normalization here.
       */
    }
  }

  plans.sort((a, b) => {
    if (a.networkId !== b.networkId) {
      return Number(a.networkId) - Number(b.networkId);
    }

    if (a.priceKobo !== b.priceKobo) {
      return a.priceKobo - b.priceKobo;
    }

    return a.planId.localeCompare(b.planId, undefined, {
      numeric: true
    });
  });

  return Object.freeze(plans);
}

async function fetchPlans(options = {}) {
  assertConfiguration();

  const network = normalizeNetwork(options.network);
  const type = normalizeType(options.type);

  const url = createRequestUrl(network, type);

  const payload = await requestJson(url);
  const rawPlans = validateCatalogueResponse(payload);
  const plans = normalizeCatalogue(rawPlans);

  return plans;
}

function buildCacheKey(network, type) {
  return `${network || "all"}:${type || "all"}`;
}

function getCachedEntry(key) {
  if (!catalogueCache) {
    return null;
  }

  const entry = catalogueCache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    catalogueCache.delete(key);
    return null;
  }

  return entry;
}

function ensureCache() {
  if (!catalogueCache) {
    catalogueCache = new Map();
  }

  return catalogueCache;
}

async function getPlans(options = {}) {
  assertConfiguration();

  const network = normalizeNetwork(options.network);
  const type = normalizeType(options.type);

  const forceRefresh = options.forceRefresh === true;
  const cacheKey = buildCacheKey(network, type);

  if (!forceRefresh) {
    const cached = getCachedEntry(cacheKey);

    if (cached) {
      return cached.plans;
    }
  }

  const cache = ensureCache();

  if (catalogueRefreshPromise && cacheKey === "all:all") {
    return catalogueRefreshPromise;
  }

  const refreshPromise = fetchPlans({
    network,
    type
  })
    .then((plans) => {
      cache.set(cacheKey, {
        plans,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + CACHE_TTL_MS
      });

      return plans;
    })
    .finally(() => {
      if (cacheKey === "all:all") {
        catalogueRefreshPromise = null;
      }
    });

  if (cacheKey === "all:all") {
    catalogueRefreshPromise = refreshPromise;
  }

  return refreshPromise;
}

async function getPlanById(planId, options = {}) {
  const normalizedPlanId = normalizePlanId(planId);

  const plans = await getPlans({
    network: options.network,
    type: options.type,
    forceRefresh: options.forceRefresh === true
  });

  return (
    plans.find((plan) => plan.planId === normalizedPlanId) || null
  );
}

async function requirePlan(planId, options = {}) {
  const plan = await getPlanById(planId, options);

  if (!plan) {
    const error = new Error("Data plan is not available");
    error.code = "DATA_PLAN_NOT_FOUND";
    throw error;
  }

  if (plan.status !== "active") {
    const error = new Error("Data plan is not active");
    error.code = "DATA_PLAN_NOT_ACTIVE";
    throw error;
  }

  if (
    options.network !== undefined &&
    options.network !== null &&
    String(plan.networkId) !== String(options.network)
  ) {
    const error = new Error("Data plan does not belong to the selected network");
    error.code = "DATA_PLAN_NETWORK_MISMATCH";
    throw error;
  }

  if (
    options.type !== undefined &&
    options.type !== null &&
    String(plan.planType).toLowerCase() !==
      String(options.type).toLowerCase()
  ) {
    const error = new Error("Data plan type mismatch");
    error.code = "DATA_PLAN_TYPE_MISMATCH";
    throw error;
  }

  return plan;
}

function clearCache() {
  if (catalogueCache) {
    catalogueCache.clear();
  }

  catalogueRefreshPromise = null;
}

function getNetworkName(network) {
  const normalizedNetwork = normalizeNetwork(network);

  return NETWORK_NAMES[normalizedNetwork];
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