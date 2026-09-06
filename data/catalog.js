"use strict";

const {
  getDataPlans,
} = require("./provider/babspay");

const CACHE_TTL_MS = Number(
  process.env.DATA_CATALOG_CACHE_TTL_MS || 60_000
);

const cache = new Map();

function toPositiveInteger(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(
      `Invalid ${fieldName} received from BabsPay.`
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  return number;
}

function toPositiveKobo(value, fieldName) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error(
      `Invalid ${fieldName} received from BabsPay.`
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  return Math.round(amount * 100);
}

function normalizeNetworkId(rawPlan) {
  if (
    rawPlan.network_id !== undefined &&
    rawPlan.network_id !== null
  ) {
    return toPositiveInteger(
      rawPlan.network_id,
      "network_id"
    );
  }

  const network = String(
    rawPlan.network_name ??
      rawPlan.network ??
      ""
  )
    .trim()
    .toLowerCase();

  const networkMap = {
    mtn: 1,
    glo: 2,
    airtel: 3,
    "9mobile": 4,
    "9 mobile": 4,
    etisalat: 4,
  };

  const networkId = networkMap[network];

  if (!networkId) {
    const error = new Error(
      `Unable to determine network for BabsPay plan ${rawPlan.plan_id}.`
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  return networkId;
}

function normalizeNetworkName(rawPlan, networkId) {
  const suppliedName = String(
    rawPlan.network_name ??
      rawPlan.network ??
      ""
  ).trim();

  if (suppliedName) {
    return suppliedName;
  }

  const networkNames = {
    1: "MTN",
    2: "Glo",
    3: "Airtel",
    4: "9mobile",
  };

  const networkName = networkNames[networkId];

  if (!networkName) {
    const error = new Error(
      `Unable to determine network name for BabsPay plan ${rawPlan.plan_id}.`
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  return networkName;
}

function normalizePlanType(rawPlan) {
  const value = String(
    rawPlan.plan_type ??
      rawPlan.type ??
      ""
  )
    .trim()
    .toLowerCase();

  if (!value) {
    const error = new Error(
      `Missing plan type for BabsPay plan ${rawPlan.plan_id}.`
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  return value;
}

function normalizePlanName(rawPlan) {
  const name = String(
    rawPlan.plan_name ??
      rawPlan.name ??
      ""
  ).trim();

  if (!name) {
    const error = new Error(
      `Missing plan name for BabsPay plan ${rawPlan.plan_id}.`
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  return name;
}

function normalizeValidity(rawPlan) {
  const validity = String(
    rawPlan.validity ?? ""
  ).trim();

  if (!validity) {
    const error = new Error(
      `Missing validity for BabsPay plan ${rawPlan.plan_id}.`
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  return validity;
}

function normalizeProviderStatus(rawPlan) {
  /*
   * The current BabsPay /api/data_plans response observed
   * in production does not include a status field.
   *
   * When BabsPay explicitly provides a status:
   * - active = sellable
   * - inactive/disabled/etc. = not sellable
   *
   * When the field is absent, the plan is accepted because
   * it came directly from the current provider catalogue.
   */
  if (
    rawPlan.status === undefined ||
    rawPlan.status === null ||
    String(rawPlan.status).trim() === ""
  ) {
    return "active";
  }

  const status = String(
    rawPlan.status
  )
    .trim()
    .toLowerCase();

  if (
    status === "active" ||
    status === "enabled" ||
    status === "available"
  ) {
    return "active";
  }

  return null;
}

function normalizePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") {
    const error = new Error(
      "Invalid plan record received from BabsPay."
    );

    error.code = "DATA_INVALID_PROVIDER_PLAN";

    throw error;
  }

  const planId = toPositiveInteger(
    rawPlan.plan_id,
    "plan_id"
  );

  const status =
    normalizeProviderStatus(rawPlan);

  /*
   * Explicitly unavailable provider plans are ignored.
   * Missing status is handled as active by
   * normalizeProviderStatus().
   */
  if (!status) {
    return null;
  }

  const networkId =
    normalizeNetworkId(rawPlan);

  const networkName =
    normalizeNetworkName(
      rawPlan,
      networkId
    );

  const planType =
    normalizePlanType(rawPlan);

  const planName =
    normalizePlanName(rawPlan);

  const validity =
    normalizeValidity(rawPlan);

  const providerPriceKobo =
    toPositiveKobo(
      rawPlan.price,
      "price"
    );

  const planCode =
    rawPlan.plan_code === undefined ||
    rawPlan.plan_code === null
      ? null
      : String(
          rawPlan.plan_code
        ).trim();

  return {
    planId,
    planCode,
    networkId,
    networkName,
    planName,
    planType,
    validity,
    providerPriceKobo,
    status: "active",
  };
}

function normalizeCatalogue(rawPlans) {
  if (!Array.isArray(rawPlans)) {
    const error = new Error(
      "BabsPay returned an invalid data-plan catalogue."
    );

    error.code =
      "DATA_INVALID_PROVIDER_CATALOG";

    throw error;
  }

  const plans = [];
  const seenPlanIds = new Set();

  for (const rawPlan of rawPlans) {
    const plan =
      normalizePlan(rawPlan);

    /*
     * Explicitly inactive/unavailable provider
     * plans are ignored.
     */
    if (!plan) {
      continue;
    }

    if (
      seenPlanIds.has(plan.planId)
    ) {
      const error = new Error(
        `Duplicate active BabsPay plan received: ${plan.planId}.`
      );

      error.code =
        "DATA_DUPLICATE_PROVIDER_PLAN";

      throw error;
    }

    seenPlanIds.add(plan.planId);
    plans.push(plan);
  }

  return plans;
}

function normalizeRequestedNetwork(
  network
) {
  if (
    network === undefined ||
    network === null ||
    network === ""
  ) {
    return null;
  }

  const normalized =
    Number(network);

  if (
    !Number.isInteger(normalized) ||
    ![1, 2, 3, 4].includes(
      normalized
    )
  ) {
    const error = new Error(
      "Invalid Data network."
    );

    error.code =
      "INVALID_DATA_NETWORK";

    throw error;
  }

  return normalized;
}

function getCacheKey(network) {
  return network === null
    ? "all"
    : String(network);
}

function isCacheFresh(entry) {
  return (
    entry &&
    entry.loadedAt > 0 &&
    Date.now() - entry.loadedAt <
      CACHE_TTL_MS
  );
}

async function loadCatalogue({
  network = null,
  forceRefresh = false,
} = {}) {
  const normalizedNetwork =
    normalizeRequestedNetwork(
      network
    );

  const cacheKey =
    getCacheKey(normalizedNetwork);

  const cached =
    cache.get(cacheKey);

  if (
    !forceRefresh &&
    isCacheFresh(cached)
  ) {
    console.log(
      "[DATA DEBUG] Using cached catalogue",
      {
        network:
          normalizedNetwork,
        planCount:
          cached.plans.length,
      }
    );

    return cached.plans;
  }

  console.log(
    "[DATA DEBUG] Fetching BabsPay catalogue",
    {
      network:
        normalizedNetwork,
      babsPayNetwork:
        normalizedNetwork,
    }
  );

  const rawPlans =
    await getDataPlans({
      network:
        normalizedNetwork,
    });

  console.log(
    "[DATA DEBUG] BabsPay catalogue response received",
    {
      network:
        normalizedNetwork,
      rawPlanCount:
        Array.isArray(rawPlans)
          ? rawPlans.length
          : null,
      isArray:
        Array.isArray(rawPlans),
    }
  );

  if (
    Array.isArray(rawPlans) &&
    rawPlans.length > 0
  ) {
    console.log(
      "[DATA DEBUG] First BabsPay plan",
      rawPlans[0]
    );
  }

  const plans =
    normalizeCatalogue(
      rawPlans
    );

  console.log(
    "[DATA DEBUG] BabsPay catalogue normalized",
    {
      network:
        normalizedNetwork,
      activePlanCount:
        plans.length,
    }
  );

  cache.set(
    cacheKey,
    {
      loadedAt: Date.now(),
      plans,
    }
  );

  return plans;
}

function filterPlans(
  plans,
  filters = {}
) {
  const network =
    filters.network ===
      undefined ||
    filters.network === null ||
    filters.network === ""
      ? null
      : Number(filters.network);

  const type =
    filters.type ===
      undefined ||
    filters.type === null ||
    filters.type === ""
      ? null
      : String(
          filters.type
        )
          .trim()
          .toLowerCase();

  return plans.filter(
    (plan) => {
      if (
        network !== null &&
        plan.networkId !== network
      ) {
        return false;
      }

      if (
        type !== null &&
        plan.planType !== type
      ) {
        return false;
      }

      return true;
    }
  );
}

async function getPlans(
  filters = {},
  options = {}
) {
  const network =
    normalizeRequestedNetwork(
      filters.network
    );

  const plans =
    await loadCatalogue({
      network,
      forceRefresh:
        options.forceRefresh === true,
    });

  return filterPlans(
    plans,
    filters
  );
}

async function getPlanById(
  planId,
  options = {}
) {
  const normalizedPlanId =
    toPositiveInteger(
      planId,
      "plan_id"
    );

  const plans =
    await loadCatalogue({
      network:
        options.network ??
        null,
      forceRefresh:
        options.forceRefresh === true,
    });

  return (
    plans.find(
      (plan) =>
        plan.planId ===
        normalizedPlanId
    ) || null
  );
}

async function getPlanForPurchase({
  network,
  planId,
} = {}) {
  const normalizedNetwork =
    toPositiveInteger(
      network,
      "network"
    );

  const normalizedPlanId =
    toPositiveInteger(
      planId,
      "plan_id"
    );

  const plans =
    await loadCatalogue({
      network:
        normalizedNetwork,
    });

  const plan =
    plans.find(
      (candidate) =>
        candidate.planId ===
          normalizedPlanId &&
        candidate.networkId ===
          normalizedNetwork
    );

  if (!plan) {
    const error = new Error(
      "The selected data plan is not currently available."
    );

    error.code =
      "DATA_PLAN_NOT_FOUND";

    throw error;
  }

  if (
    plan.status !== "active"
  ) {
    const error = new Error(
      "The selected data plan is not currently available."
    );

    error.code =
      "DATA_PLAN_INACTIVE";

    throw error;
  }

  return plan;
}

function clearCatalogueCache() {
  cache.clear();

  console.log(
    "[DATA DEBUG] Data catalogue cache cleared"
  );
}

module.exports = {
  getPlans,
  getPlanById,
  getPlanForPurchase,
  clearCatalogueCache,
  normalizeCatalogue,
};