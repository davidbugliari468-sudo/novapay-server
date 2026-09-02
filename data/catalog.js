"use strict";

const VTU_DATA_VARIATIONS_URL =
    "https://vtu.ng/wp-json/api/v2/variations/data";

const SUPPORTED_NETWORK_ORDER = Object.freeze([
    "mtn",
    "airtel",
    "glo",
    "9mobile"
]);

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

let catalogCache = null;
let catalogCacheExpiresAt = 0;

function createCatalogError(message, code = "DATA_CATALOG_ERROR") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeString(value) {
    return String(value ?? "").trim();
}

function normalizeNetwork(value) {
    const network = normalizeString(value).toLowerCase();

    if (!SUPPORTED_NETWORK_ORDER.includes(network)) {
        throw createCatalogError(
            "Unsupported data network.",
            "UNSUPPORTED_NETWORK"
        );
    }

    return network;
}

function normalizePlanId(value) {
    const planId = normalizeString(value);

    if (!planId) {
        throw createCatalogError(
            "Data plan ID is required.",
            "INVALID_PLAN_ID"
        );
    }

    if (planId.length > 100) {
        throw createCatalogError(
            "Data plan ID is too long.",
            "INVALID_PLAN_ID"
        );
    }

    return planId;
}

function normalizePrice(value) {
    const price = Number(value);

    if (!Number.isFinite(price) || price < 0) {
        throw createCatalogError(
            "Provider returned an invalid data plan price.",
            "INVALID_PROVIDER_PRICE"
        );
    }

    return price;
}

function nairaToKobo(value) {
    const normalized = normalizeString(value);

    if (!normalized) {
        throw createCatalogError(
            "Provider returned an empty data plan price.",
            "INVALID_PROVIDER_PRICE"
        );
    }

    const cleaned = normalized.replace(/,/g, "");

    if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
        throw createCatalogError(
            "Provider returned an invalid data plan price.",
            "INVALID_PROVIDER_PRICE"
        );
    }

    const [nairaPart, decimalPart = ""] = cleaned.split(".");

    const kobo =
        Number(nairaPart) * 100 +
        Number((decimalPart + "00").slice(0, 2));

    if (!Number.isSafeInteger(kobo) || kobo < 0) {
        throw createCatalogError(
            "Provider returned an unsafe data plan price.",
            "INVALID_PROVIDER_PRICE"
        );
    }

    return kobo;
}

function normalizeAvailability(value) {
    if (typeof value === "boolean") {
        return value;
    }

    const normalized = normalizeString(value).toLowerCase();

    if (
        normalized === "true" ||
        normalized === "available" ||
        normalized === "active" ||
        normalized === "yes" ||
        normalized === "1"
    ) {
        return true;
    }

    if (
        normalized === "false" ||
        normalized === "unavailable" ||
        normalized === "inactive" ||
        normalized === "no" ||
        normalized === "0"
    ) {
        return false;
    }

    return Boolean(value);
}

function normalizeVariation(rawVariation) {
    if (!rawVariation || typeof rawVariation !== "object") {
        throw createCatalogError(
            "Provider returned an invalid data plan.",
            "INVALID_PROVIDER_PLAN"
        );
    }

    const variationId = normalizeString(rawVariation.variation_id);

    const serviceId = normalizeString(
        rawVariation.service_id
    ).toLowerCase();

    const serviceName = normalizeString(
        rawVariation.service_name
    );

    const dataPlan = normalizeString(
        rawVariation.data_plan
    );

    if (!variationId) {
        throw createCatalogError(
            "Provider returned a data plan without a variation ID.",
            "INVALID_PROVIDER_PLAN"
        );
    }

    if (!SUPPORTED_NETWORK_ORDER.includes(serviceId)) {
        throw createCatalogError(
            `Provider returned an unsupported network: ${serviceId}.`,
            "INVALID_PROVIDER_PLAN"
        );
    }

    if (!serviceName) {
        throw createCatalogError(
            "Provider returned a data plan without a service name.",
            "INVALID_PROVIDER_PLAN"
        );
    }

    if (!dataPlan) {
        throw createCatalogError(
            "Provider returned a data plan without a plan name.",
            "INVALID_PROVIDER_PLAN"
        );
    }

    const priceNaira = normalizePrice(rawVariation.price);
    const priceKobo = nairaToKobo(priceNaira);

    return Object.freeze({
        planId: variationId,
        variationId,
        network: serviceId,
        serviceName,
        dataPlan,
        priceNaira,
        priceKobo,
        availability: normalizeAvailability(
            rawVariation.availability
        )
    });
}

function sortCatalog(plans) {
    const networkRank = new Map(
        SUPPORTED_NETWORK_ORDER.map(
            (network, index) => [network, index]
        )
    );

    return plans.slice().sort((a, b) => {
        const networkDifference =
            networkRank.get(a.network) -
            networkRank.get(b.network);

        if (networkDifference !== 0) {
            return networkDifference;
        }

        return a.priceKobo - b.priceKobo;
    });
}

function validateProviderResponse(data) {
    if (!Array.isArray(data)) {
        throw createCatalogError(
            "Provider returned an invalid data catalog.",
            "INVALID_PROVIDER_RESPONSE"
        );
    }

    return data;
}

async function fetchFromProvider() {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(
            VTU_DATA_VARIATIONS_URL,
            {
                method: "GET",
                headers: {
                    Accept: "application/json"
                },
                signal: controller.signal
            }
        );

        let data;

        try {
            data = await response.json();
        } catch {
            throw createCatalogError(
                "Provider returned an invalid JSON response.",
                "INVALID_PROVIDER_RESPONSE"
            );
        }

        if (!response.ok) {
            const message =
                normalizeString(data?.message) ||
                normalizeString(data?.error) ||
                `Provider catalog request failed with HTTP ${response.status}.`;

            throw createCatalogError(
                message,
                "PROVIDER_CATALOG_REQUEST_FAILED"
            );
        }

        const variations =
            Array.isArray(data)
                ? data
                : Array.isArray(data?.data)
                    ? data.data
                    : Array.isArray(data?.variations)
                        ? data.variations
                        : null;

        validateProviderResponse(variations);

        const plans = variations.map(
            normalizeVariation
        );

        return Object.freeze(
            sortCatalog(plans)
        );
    } catch (error) {
        if (error?.name === "AbortError") {
            throw createCatalogError(
                "Data catalog request timed out.",
                "PROVIDER_CATALOG_TIMEOUT"
            );
        }

        if (error?.code) {
            throw error;
        }

        throw createCatalogError(
            "Unable to retrieve the data catalog.",
            "PROVIDER_CATALOG_UNAVAILABLE"
        );
    } finally {
        clearTimeout(timeout);
    }
}

async function getDataCatalog(options = {}) {
    const forceRefresh =
        options &&
        options.forceRefresh === true;

    const now = Date.now();

    if (
        !forceRefresh &&
        catalogCache &&
        now < catalogCacheExpiresAt
    ) {
        return catalogCache;
    }

    const catalog = await fetchFromProvider();

    catalogCache = catalog;
    catalogCacheExpiresAt =
        Date.now() + CACHE_TTL_MS;

    return catalog;
}

async function getDataPlansForNetwork(
    network,
    options = {}
) {
    const normalizedNetwork =
        normalizeNetwork(network);

    const catalog =
        await getDataCatalog(options);

    return catalog.filter(
        (plan) =>
            plan.network === normalizedNetwork
    );
}

async function findDataPlan(
    variationId,
    options = {}
) {
    const normalizedVariationId =
        normalizePlanId(variationId);

    const catalog =
        await getDataCatalog(options);

    const plan =
        catalog.find(
            (item) =>
                item.variationId ===
                normalizedVariationId
        );

    if (!plan) {
        throw createCatalogError(
            "The selected data plan was not found.",
            "DATA_PLAN_NOT_FOUND"
        );
    }

    return plan;
}

function clearCatalogCache() {
    catalogCache = null;
    catalogCacheExpiresAt = 0;
}

module.exports = {
    SUPPORTED_NETWORK_ORDER,
    CACHE_TTL_MS,
    getDataCatalog,
    getDataPlansForNetwork,
    findDataPlan,
    clearCatalogCache
};