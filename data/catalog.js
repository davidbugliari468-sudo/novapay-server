"use strict";

/**
 * NovaPay Data Catalog
 *
 * Responsibility:
 * - Retrieve current Data variations from VTU.ng.
 * - Normalize provider variation data.
 * - Create a stable NovaPay product representation.
 * - Preserve the exact VTU variation ID.
 * - Determine safe customer-facing product attributes.
 * - Determine product category from provider validity information.
 * - Support NovaPay "Hot" merchandising through server configuration.
 * - Cache provider catalog data to avoid unnecessary provider calls.
 *
 * IMPORTANT:
 * - The client never creates a product.
 * - The client never supplies the authoritative price.
 * - The client never supplies provider cost.
 * - The client never supplies the provider variation ID directly
 *   as an authoritative value.
 * - The provider variation ID comes from the trusted VTU catalog.
 *
 * Product identity:
 *
 *     VTU variation
 *          ↓
 *     NovaPay plan ID
 *          ↓
 *     customer-facing product
 *
 * The NovaPay plan ID is currently derived from the exact VTU
 * variation ID. This means the selected product remains tied to
 * one exact provider variation.
 */


// =====================================================
// CONFIGURATION
// =====================================================

const VTU_DATA_VARIATIONS_URL =
    process.env.VTU_DATA_VARIATIONS_URL ||
    "https://vtu.ng/wp-json/api/v2/variations/data";

const VTU_CATALOG_TIMEOUT_MS =
    normalizePositiveInteger(
        process.env.VTU_CATALOG_TIMEOUT_MS,
        10000
    );

const CATALOG_CACHE_TTL_MS =
    normalizePositiveInteger(
        process.env.VTU_CATALOG_CACHE_TTL_MS,
        5 * 60 * 1000
    );


// =====================================================
// NETWORK ORDER
// =====================================================
//
// This is the canonical NovaPay display/order preference.
//
// Frontend should eventually render products in this order:
//
//     MTN
//     Airtel
//     Glo
//     9mobile
//
// =====================================================

const NETWORK_ORDER =
    Object.freeze([
        "mtn",
        "airtel",
        "glo",
        "9mobile"
    ]);

const NETWORK_ORDER_INDEX =
    Object.freeze(
        NETWORK_ORDER.reduce(
            (
                result,
                network,
                index
            ) => {

                result[network] =
                    index;

                return result;

            },
            {}
        )
    );


// =====================================================
// SUPPORTED NETWORKS
// =====================================================
//
// Smile is intentionally excluded because NovaPay's current
// Data product is being built for:
//
//     MTN
//     Airtel
//     Glo
//     9mobile
//
// The provider API may expose Smile, but unsupported products
// must never accidentally appear in the NovaPay customer catalog.
// =====================================================

const SUPPORTED_NETWORKS =
    Object.freeze([
        "mtn",
        "airtel",
        "glo",
        "9mobile"
    ]);


// =====================================================
// CACHE
// =====================================================

let catalogCache =
    null;


// =====================================================
// ERROR HELPER
// =====================================================

function createCatalogError(
    message,
    statusCode = 503,
    code = "DATA_CATALOG_ERROR"
) {

    const error =
        new Error(
            message
        );

    error.statusCode =
        statusCode;

    error.code =
        code;

    return error;

}


// =====================================================
// INTEGER CONFIGURATION
// =====================================================

function normalizePositiveInteger(
    value,
    fallback
) {

    const number =
        Number(
            value
        );

    if (
        Number.isSafeInteger(
            number
        ) &&
        number > 0
    ) {

        return number;

    }

    return fallback;

}


// =====================================================
// STRING
// =====================================================

function normalizeString(
    value
) {

    if (
        typeof value !==
        "string"
    ) {

        return "";

    }

    return value.trim();

}


// =====================================================
// NETWORK
// =====================================================

function normalizeNetwork(
    value
) {

    return normalizeString(
        value
    )
        .toLowerCase();

}


// =====================================================
// PLAN ID
// =====================================================
//
// The provider's variation_id is the strongest product identity
// available from the public VTU Data catalog.
//
// We normalize it to a string so Firestore, URLs, JSON and
// frontend code all use one consistent representation.
// =====================================================

function normalizePlanId(
    value
) {

    if (
        value ===
        null ||
        value ===
        undefined
    ) {

        return "";

    }

    const planId =
        String(
            value
        ).trim();

    if (
        !planId
    ) {

        return "";

    }

    if (
        planId.length >
        150
    ) {

        return "";

    }

    if (
        !/^[A-Za-z0-9._:-]+$/.test(
            planId
        )
    ) {

        return "";

    }

    return planId;

}


// =====================================================
// PRICE → KOBO
// =====================================================
//
// VTU returns Data variation prices in Naira.
//
// NovaPay stores all wallet money in integer kobo.
//
// Examples:
//
//     "260"     → 26000
//     "260.50"  → 26050
//
// No floating-point arithmetic is used for the final kobo
// representation.
// =====================================================

function nairaToKobo(
    value
) {

    if (
        value ===
        null ||
        value ===
        undefined
    ) {

        return null;

    }

    const text =
        String(
            value
        )
        .trim();

    if (
        !text ||
        !/^\d+(?:\.\d{1,2})?$/.test(
            text
        )
    ) {

        return null;

    }

    const [
        wholePart,
        decimalPart = ""
    ] =
        text.split(
            "."
        );

    const whole =
        Number(
            wholePart
        );

    if (
        !Number.isSafeInteger(
            whole
        ) ||
        whole < 0
    ) {

        return null;

    }

    const decimal =
        Number(
            (
                decimalPart +
                "00"
            ).slice(
                0,
                2
            )
        );

    if (
        !Number.isSafeInteger(
            decimal
        )
    ) {

        return null;

    }

    const kobo =
        (
            whole * 100
        ) +
        decimal;

    if (
        !Number.isSafeInteger(
            kobo
        ) ||
        kobo <= 0
    ) {

        return null;

    }

    return kobo;

}


// =====================================================
// AVAILABILITY
// =====================================================

function normalizeAvailability(
    value
) {

    const availability =
        normalizeString(
            value
        )
        .toLowerCase();

    if (
        availability ===
        "available"
    ) {

        return "available";

    }

    if (
        availability ===
        "unavailable"
    ) {

        return "unavailable";

    }

    /*
     * Unknown provider availability is deliberately treated
     * as unavailable.
     *
     * We must never sell a plan merely because the provider
     * returned an unexpected availability value.
     */

    return "unavailable";

}


// =====================================================
// DATA PLAN LABEL
// =====================================================
//
// Preserve the provider's original data_plan text because it
// may contain useful information such as:
//
//     470MB - 7 Days
//     1GB + 5 mins - 7 Days
//     2GB (Gift) - 30 Days
//
// We also parse structured attributes separately.
// =====================================================

function normalizeDataPlan(
    value
) {

    const dataPlan =
        normalizeString(
            value
        );

    if (
        !dataPlan ||
        dataPlan.length >
        250
    ) {

        return "";

    }

    return dataPlan;

}


// =====================================================
// DATA AMOUNT PARSER
// =====================================================
//
// Extracts the primary data amount from the provider label.
//
// Examples:
//
//     "470MB - 7 Days"
//         → 470 MB
//
//     "1GB + 5 mins - 7 Days"
//         → 1 GB
//
//     "2.6GB - 30 Days"
//         → 2.6 GB
//
// We preserve the original provider label as well.
// =====================================================

function parseDataAmount(
    dataPlan
) {

    const normalized =
        normalizeString(
            dataPlan
        );

    if (
        !normalized
    ) {

        return {

            value:
                null,

            unit:
                null,

            label:
                null

        };

    }

    const match =
        normalized.match(
            /(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b/i
        );

    if (
        !match
    ) {

        return {

            value:
                null,

            unit:
                null,

            label:
                null

        };

    }

    const value =
        Number(
            match[1]
        );

    const unit =
        match[2]
            .toUpperCase();

    if (
        !Number.isFinite(
            value
        ) ||
        value <= 0
    ) {

        return {

            value:
                null,

            unit:
                null,

            label:
                null

        };

    }

    return {

        value,

        unit,

        label:
            `${match[1]} ${unit}`

    };

}


// =====================================================
// VALIDITY PARSER
// =====================================================
//
// We intentionally classify categories from explicit provider
// validity information where possible.
//
// Examples:
//
//     "1 Day"       → 1
//     "7 Days"      → 7
//     "30 Days"     → 30
//     "90 Days"     → 90
//
// Some VTU products have labels such as:
//
//     "Sunday"
//     "Night"
//     other promotional labels
//
// Those do not contain a reliable duration, so validityDays
// remains null instead of inventing a value.
// =====================================================

function parseValidity(
    dataPlan
) {

    const normalized =
        normalizeString(
            dataPlan
        );

    if (
        !normalized
    ) {

        return {

            days:
                null,

            label:
                null

        };

    }

    const dayMatch =
        normalized.match(
            /(?:^|\s|[-–—])(\d+(?:\.\d+)?)\s*(?:day|days)\b/i
        );

    if (
        dayMatch
    ) {

        const days =
            Number(
                dayMatch[1]
            );

        if (
            Number.isFinite(
                days
            ) &&
            days > 0
        ) {

            return {

                days,

                label:
                    `${dayMatch[1]} ${Number(dayMatch[1]) === 1 ? "Day" : "Days"}`

            };

        }

    }

    const hourMatch =
        normalized.match(
            /(?:^|\s|[-–—])(\d+(?:\.\d+)?)\s*(?:hour|hours)\b/i
        );

    if (
        hourMatch
    ) {

        const hours =
            Number(
                hourMatch[1]
            );

        if (
            Number.isFinite(
                hours
            ) &&
            hours > 0
        ) {

            return {

                days:
                    hours / 24,

                label:
                    `${hourMatch[1]} ${Number(hourMatch[1]) === 1 ? "Hour" : "Hours"}`

            };

        }

    }

    return {

        days:
            null,

        label:
            null

    };

}


// =====================================================
// CATEGORY
// =====================================================
//
// Category is a NovaPay merchandising concept.
//
// Rules:
//
//     ≤ 1 day          → Daily
//     > 1 and < 28     → Daily
//     28 to < 60       → Monthly
//     60 to < 120      → 3 Months
//
// Products without an explicit duration are not guessed.
//
// "Hot" is deliberately NOT derived from price or popularity.
// It is controlled separately through server configuration.
// =====================================================

function determineBaseCategory(
    validityDays
) {

    if (
        typeof validityDays !==
        "number" ||
        !Number.isFinite(
            validityDays
        ) ||
        validityDays <= 0
    ) {

        return "Other";

    }

    if (
        validityDays <
        28
    ) {

        return "Daily";

    }

    if (
        validityDays <
        60
    ) {

        return "Monthly";

    }

    if (
        validityDays <
        120
    ) {

        return "3 Months";

    }

    return "Other";

}


// =====================================================
// HOT PLAN CONFIGURATION
// =====================================================
//
// "Hot" is merchandising, not a provider-defined product type.
//
// Therefore we do NOT guess which plans are Hot.
//
// A trusted server administrator can explicitly configure:
//
//     HOT_DATA_PLAN_IDS=123,456,789
//
// The IDs must be the exact VTU variation IDs.
//
// If no configuration exists, no product is marked Hot.
//
// This prevents popularity or price heuristics from silently
// changing the customer product classification.
// =====================================================

function getConfiguredHotPlanIds() {

    const raw =
        normalizeString(
            process.env.HOT_DATA_PLAN_IDS
        );

    if (
        !raw
    ) {

        return new Set();

    }

    const ids =
        raw
            .split(",")
            .map(
                value =>
                    normalizePlanId(
                        value
                    )
            )
            .filter(
                Boolean
            );

    return new Set(
        ids
    );

}


// =====================================================
// CATEGORY WITH HOT FLAG
// =====================================================

function determineCategory(
    planId,
    validityDays,
    hotPlanIds
) {

    if (
        hotPlanIds.has(
            planId
        )
    ) {

        return "Hot";

    }

    return determineBaseCategory(
        validityDays
    );

}


// =====================================================
// SERVICE NAME
// =====================================================

function normalizeServiceName(
    value
) {

    const serviceName =
        normalizeString(
            value
        );

    if (
        !serviceName
    ) {

        return "";

    }

    if (
        serviceName.length >
        100
    ) {

        return "";

    }

    return serviceName;

}


// =====================================================
// RAW PROVIDER VARIATION VALIDATION
// =====================================================
//
// We reject malformed variations rather than allowing incomplete
// products into the customer catalog.
// =====================================================

function isValidRawVariation(
    variation
) {

    if (
        !variation ||
        typeof variation !==
        "object"
    ) {

        return false;

    }

    const variationId =
        normalizePlanId(
            variation.variation_id
        );

    const network =
        normalizeNetwork(
            variation.service_id
        );

    const serviceName =
        normalizeServiceName(
            variation.service_name
        );

    const dataPlan =
        normalizeDataPlan(
            variation.data_plan
        );

    const priceKobo =
        nairaToKobo(
            variation.price
        );

    if (
        !variationId ||
        !SUPPORTED_NETWORKS.includes(
            network
        ) ||
        !serviceName ||
        !dataPlan ||
        priceKobo ===
        null
    ) {

        return false;

    }

    return true;

}


// =====================================================
// NORMALIZE ONE VARIATION
// =====================================================

function normalizeVariation(
    variation,
    hotPlanIds
) {

    if (
        !isValidRawVariation(
            variation
        )
    ) {

        return null;

    }

    const planId =
        normalizePlanId(
            variation.variation_id
        );

    const network =
        normalizeNetwork(
            variation.service_id
        );

    const serviceName =
        normalizeServiceName(
            variation.service_name
        );

    const dataPlan =
        normalizeDataPlan(
            variation.data_plan
        );

    const priceKobo =
        nairaToKobo(
            variation.price
        );

    const availability =
        normalizeAvailability(
            variation.availability
        );

    const dataAmount =
        parseDataAmount(
            dataPlan
        );

    const validity =
        parseValidity(
            dataPlan
        );

    const category =
        determineCategory(
            planId,
            validity.days,
            hotPlanIds
        );

    /*
     * `priceKobo` is the authoritative customer price for the
     * current NovaPay catalog.
     *
     * We deliberately do not call it "provider cost" here.
     *
     * Provider cost returned later by a purchase response is
     * a separate accounting value.
     */

    const customerPriceKobo =
        priceKobo;

    return Object.freeze({

        /*
         * Stable NovaPay product identity.
         */

        planId,

        /*
         * Exact provider identity.
         */

        provider:
            "vtu.ng",

        variationId:
            planId,

        /*
         * Network.
         */

        network,

        serviceName,

        /*
         * Original provider product description.
         */

        dataPlan,

        /*
         * Structured display information.
         */

        dataAmount:
            dataAmount.label,

        dataAmountValue:
            dataAmount.value,

        dataAmountUnit:
            dataAmount.unit,

        validityDays:
            validity.days,

        validityLabel:
            validity.label,

        /*
         * NovaPay merchandising.
         */

        category,

        isHot:
            category ===
            "Hot",

        /*
         * Pricing.
         */

        priceNaira:
            priceKobo / 100,

        priceKobo,

        customerPriceNaira:
            customerPriceKobo / 100,

        customerPriceKobo,

        /*
         * Provider availability.
         */

        availability,

        /*
         * Useful for auditing which provider catalog generated
         * the product.
         */

        source:
            "vtu_data_variations"

    });

}


// =====================================================
// DUPLICATE PLAN PROTECTION
// =====================================================
//
// A provider variation ID must identify exactly one NovaPay
// product in the catalog.
//
// Duplicate IDs with conflicting data are rejected.
// =====================================================

function buildUniqueCatalog(
    variations
) {

    const byPlanId =
        new Map();

    for (
        const variation
        of variations
    ) {

        if (
            !variation
        ) {

            continue;

        }

        const existing =
            byPlanId.get(
                variation.planId
            );

        if (
            !existing
        ) {

            byPlanId.set(
                variation.planId,
                variation
            );

            continue;

        }

        /*
         * The same provider variation ID appearing twice with
         * materially different identity data is unsafe.
         */

        if (
            existing.network !==
                variation.network ||

            existing.variationId !==
                variation.variationId ||

            existing.priceKobo !==
                variation.priceKobo ||

            existing.dataPlan !==
                variation.dataPlan
        ) {

            throw createCatalogError(
                "VTU returned conflicting Data variation information.",
                503,
                "CONFLICTING_DATA_VARIATION"
            );

        }

        /*
         * If the exact same variation appears twice, keep one.
         */

    }

    return Array.from(
        byPlanId.values()
    );

}


// =====================================================
// CATALOG SORT
// =====================================================
//
// Canonical order:
//
//     MTN
//     Airtel
//     Glo
//     9mobile
//
// Within each network:
//
//     category
//     price
//     data amount
//     plan ID
//
// This makes the backend response deterministic.
// =====================================================

function categoryOrder(
    category
) {

    const order = {

        "Hot":
            0,

        "Daily":
            1,

        "Monthly":
            2,

        "3 Months":
            3,

        "Other":
            4

    };

    return (
        order[category] ??
        99
    );

}


function compareCatalogPlans(
    first,
    second
) {

    const firstNetworkIndex =
        NETWORK_ORDER_INDEX[
            first.network
        ] ??
        999;

    const secondNetworkIndex =
        NETWORK_ORDER_INDEX[
            second.network
        ] ??
        999;

    if (
        firstNetworkIndex !==
        secondNetworkIndex
    ) {

        return (
            firstNetworkIndex -
            secondNetworkIndex
        );

    }

    const categoryDifference =
        categoryOrder(
            first.category
        ) -
        categoryOrder(
            second.category
        );

    if (
        categoryDifference !==
        0
    ) {

        return categoryDifference;

    }

    if (
        first.priceKobo !==
        second.priceKobo
    ) {

        return (
            first.priceKobo -
            second.priceKobo
        );

    }

    const firstAmount =
        first.dataAmountValue ??
        Number.POSITIVE_INFINITY;

    const secondAmount =
        second.dataAmountValue ??
        Number.POSITIVE_INFINITY;

    if (
        firstAmount !==
        secondAmount
    ) {

        return (
            firstAmount -
            secondAmount
        );

    }

    return first.planId.localeCompare(
        second.planId
    );

}


// =====================================================
// FETCH WITH TIMEOUT
// =====================================================

async function fetchWithTimeout(
    url
) {

    if (
        typeof fetch !==
        "function"
    ) {

        throw createCatalogError(
            "Server fetch support is unavailable.",
            500,
            "FETCH_NOT_AVAILABLE"
        );

    }

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => {
                controller.abort();
            },
            VTU_CATALOG_TIMEOUT_MS
        );

    try {

        return await fetch(
            url,
            {
                method:
                    "GET",

                headers: {

                    Accept:
                        "application/json"

                },

                signal:
                    controller.signal
            }
        );

    } catch (error) {

        if (
            error?.name ===
            "AbortError"
        ) {

            throw createCatalogError(
                "VTU Data catalog request timed out.",
                503,
                "CATALOG_TIMEOUT"
            );

        }

        throw createCatalogError(
            "Unable to retrieve the VTU Data catalog.",
            503,
            "CATALOG_NETWORK_ERROR"
        );

    } finally {

        clearTimeout(
            timeout
        );

    }

}


// =====================================================
// PARSE PROVIDER JSON
// =====================================================

async function parseProviderResponse(
    response
) {

    if (
        !response
    ) {

        throw createCatalogError(
            "VTU Data catalog returned no response.",
            503,
            "CATALOG_NO_RESPONSE"
        );

    }

    let payload;

    try {

        payload =
            await response.json();

    } catch (
        error
    ) {

        throw createCatalogError(
            "VTU Data catalog returned invalid data.",
            503,
            "CATALOG_INVALID_JSON"
        );

    }

    if (
        !response.ok
    ) {

        throw createCatalogError(
            "VTU Data catalog is temporarily unavailable.",
            503,
            "CATALOG_HTTP_ERROR"
        );

    }

    if (
        !payload ||
        typeof payload !==
        "object"
    ) {

        throw createCatalogError(
            "VTU Data catalog returned an invalid response.",
            503,
            "CATALOG_INVALID_RESPONSE"
        );

    }

    /*
     * Current VTU response shape:
     *
     * {
     *     code: "success",
     *     message: "...",
     *     product: "Data",
     *     data: [...]
     * }
     *
     * We accept only an actual array of variations.
     */

    if (
        !Array.isArray(
            payload.data
        )
    ) {

        throw createCatalogError(
            "VTU Data catalog returned no valid Data variations.",
            503,
            "CATALOG_INVALID_DATA"
        );

    }

    return payload.data;

}


// =====================================================
// FETCH CURRENT CATALOG
// =====================================================

async function fetchCurrentCatalog() {

    const response =
        await fetchWithTimeout(
            VTU_DATA_VARIATIONS_URL
        );

    const rawVariations =
        await parseProviderResponse(
            response
        );

    const hotPlanIds =
        getConfiguredHotPlanIds();

    const normalizedVariations =
        rawVariations
            .map(
                variation =>
                    normalizeVariation(
                        variation,
                        hotPlanIds
                    )
            )
            .filter(
                Boolean
            );

    if (
        normalizedVariations.length ===
        0
    ) {

        throw createCatalogError(
            "VTU returned no usable Data plans.",
            503,
            "EMPTY_DATA_CATALOG"
        );

    }

    const uniquePlans =
        buildUniqueCatalog(
            normalizedVariations
        );

    uniquePlans.sort(
        compareCatalogPlans
    );

    return Object.freeze(
        uniquePlans
    );

}


// =====================================================
// CACHE CHECK
// =====================================================

function isCacheFresh() {

    if (
        !catalogCache
    ) {

        return false;

    }

    const age =
        Date.now() -
        catalogCache.cachedAt;

    return (
        age >= 0 &&
        age <
        CATALOG_CACHE_TTL_MS
    );

}


// =====================================================
// GET DATA CATALOG
// =====================================================
//
// Returns a defensive array copy so callers cannot mutate
// the cached catalog.
// =====================================================

async function getDataCatalog({
    forceRefresh = false
} = {}) {

    if (
        !forceRefresh &&
        isCacheFresh()
    ) {

        return [
            ...catalogCache.plans
        ];

    }

    const plans =
        await fetchCurrentCatalog();

    catalogCache = {

        cachedAt:
            Date.now(),

        plans

    };

    return [
        ...plans
    ];

}


// =====================================================
// GET DATA PLANS FOR NETWORK
// =====================================================

async function getDataPlansForNetwork(
    network,
    {
        forceRefresh = false
    } = {}
) {

    const normalizedNetwork =
        normalizeNetwork(
            network
        );

    if (
        !SUPPORTED_NETWORKS.includes(
            normalizedNetwork
        )
    ) {

        throw createCatalogError(
            "Unsupported Data network.",
            400,
            "UNSUPPORTED_DATA_NETWORK"
        );

    }

    const catalog =
        await getDataCatalog({
            forceRefresh
        });

    return catalog.filter(
        plan =>
            plan.network ===
            normalizedNetwork
    );

}


// =====================================================
// FIND DATA PLAN
// =====================================================
//
// Finds one exact NovaPay product by plan ID.
//
// The plan ID is the normalized VTU variation ID.
//
// For purchase operations, the service can request a forced
// catalog refresh when it needs the freshest provider state.
// =====================================================

async function findDataPlan(
    planId,
    {
        forceRefresh = false
    } = {}
) {

    const normalizedPlanId =
        normalizePlanId(
            planId
        );

    if (
        !normalizedPlanId
    ) {

        return null;

    }

    const catalog =
        await getDataCatalog({
            forceRefresh
        });

    const plan =
        catalog.find(
            item =>
                item.planId ===
                normalizedPlanId
        );

    if (
        !plan
    ) {

        return null;

    }

    /*
     * Return a copy rather than the cached object itself.
     */

    return {

        ...plan

    };

}


// =====================================================
// CACHE METADATA
// =====================================================
//
// Backend-only helper useful for diagnostics/reconciliation.
// It does not expose provider credentials.
// =====================================================

function getCatalogCacheInfo() {

    if (
        !catalogCache
    ) {

        return {

            cached:
                false,

            cachedAt:
                null,

            ageMs:
                null,

            planCount:
                0

        };

    }

    return {

        cached:
            true,

        cachedAt:
            new Date(
                catalogCache.cachedAt
            ),

        ageMs:
            Math.max(
                0,
                Date.now() -
                catalogCache.cachedAt
            ),

        planCount:
            catalogCache.plans.length,

        fresh:
            isCacheFresh()

    };

}


// =====================================================
// CLEAR CACHE
// =====================================================

function clearCatalogCache() {

    catalogCache =
        null;

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = Object.freeze({

    VTU_DATA_VARIATIONS_URL,

    CATALOG_CACHE_TTL_MS,

    NETWORK_ORDER,

    SUPPORTED_NETWORKS,

    getDataCatalog,

    getDataPlansForNetwork,

    findDataPlan,

    clearCatalogCache,

    getCatalogCacheInfo,

    normalizeVariation,

    normalizeAvailability,

    nairaToKobo,

    parseDataAmount,

    parseValidity,

    determineBaseCategory

});