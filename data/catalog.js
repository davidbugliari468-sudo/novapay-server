"use strict";

/**
 * NovaPay Data Catalog
 *
 * RESPONSIBILITY
 * ---------------------------------------------------------
 * - Retrieve the current Data variations from VTU.ng.
 * - Reject malformed provider products.
 * - Ignore unavailable products.
 * - Preserve the exact VTU variation ID.
 * - Use the provider/API acquisition price.
 * - Apply an optional NovaPay customer margin.
 * - Build honest NovaPay categories:
 *
 *      Hot
 *      Daily
 *      Monthly
 *      3 Months
 *      Extra Value
 *
 * - Never invent a product.
 * - Never invent a provider price.
 * - Never invent a provider variation ID.
 * - Keep customer-facing price separate from provider cost.
 * - Automatically identify good-value Hot plans.
 * - Cache the provider catalogue.
 *
 * PRODUCT IDENTITY
 * ---------------------------------------------------------
 *
 *     VTU variation_id
 *             ↓
 *     NovaPay planId
 *             ↓
 *     Customer product
 *             ↓
 *     Exact same variationId purchased at VTU
 *
 * PRICING
 * ---------------------------------------------------------
 *
 * The provider/API acquisition price is taken from:
 *
 *     reseller_price
 *     api_price
 *     price
 *
 * in that order when available.
 *
 * The current official VTU documentation states that the
 * Data Variations endpoint provides the current reseller/API
 * prices and that the Data purchase endpoint requires the
 * exact variation_id.
 *
 * NovaPay customer margin defaults to ₦0.
 *
 * Therefore:
 *
 *     customer price = provider/API price
 *
 * unless DATA_CUSTOMER_MARGIN_KOBO is configured.
 *
 * CATEGORIES
 * ---------------------------------------------------------
 *
 * Hot:
 *     Automatically selected from real, available,
 *     affordable, good-value products.
 *
 * Daily:
 *     Real short-duration products up to 7 days.
 *
 * Monthly:
 *     Real monthly products around 28-45 days.
 *
 * 3 Months:
 *     Real long-duration products around 60-120 days.
 *
 * Extra Value:
 *     Real products whose provider description explicitly
 *     contains additional value such as minutes, YouTube,
 *     night/social data, bonus data, etc.
 *
 * IMPORTANT
 * ---------------------------------------------------------
 *
 * A product can belong to more than one category.
 *
 * Example:
 *
 *     1GB + 5 mins - 7 Days
 *
 * may belong to:
 *
 *     Daily
 *     Extra Value
 *     Hot
 *
 * This is intentional.
 *
 * The frontend should eventually use `categories` instead
 * of assuming that one product can belong to only one tab.
 */


// =========================================================
// CONFIGURATION
// =========================================================

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


// =========================================================
// CUSTOMER PRICING
// =========================================================
//
// Default:
//
//     ₦0 margin
//
// This intentionally keeps NovaPay as cheap as possible.
//
// If NovaPay later needs a margin:
//
//     DATA_CUSTOMER_MARGIN_KOBO=1000
//
// means ₦10 margin.
//
// The browser can never change this value.
// =========================================================

const DATA_CUSTOMER_MARGIN_KOBO =
    normalizeNonNegativeInteger(
        process.env.DATA_CUSTOMER_MARGIN_KOBO,
        0
    );


// =========================================================
// HOT CONFIGURATION
// =========================================================
//
// Hot plans are automatically selected unless explicit
// HOT_DATA_PLAN_IDS are configured.
//
// Automatic Hot rules:
//
//     available
//     valid data amount
//     at least 500 MB
//     customer price <= ₦1,500
//
// The best-value plans are then selected per network.
//
// These values are server-controlled.
//
// They do NOT create fake products.
// They only decide which real VTU products receive
// NovaPay's Hot merchandising label.
// =========================================================

const HOT_MAX_PRICE_KOBO =
    normalizeNonNegativeInteger(
        process.env.HOT_MAX_PRICE_KOBO,
        150000
    );

const HOT_MIN_DATA_MB =
    normalizePositiveInteger(
        process.env.HOT_MIN_DATA_MB,
        500
    );

const HOT_MAX_PLANS_PER_NETWORK =
    normalizePositiveInteger(
        process.env.HOT_MAX_PLANS_PER_NETWORK,
        4
    );


// =========================================================
// NETWORK ORDER
// =========================================================
//
// NovaPay display order:
//
//     MTN
//     Airtel
//     Glo
//     9mobile
// =========================================================

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


// =========================================================
// SUPPORTED NETWORKS
// =========================================================

const SUPPORTED_NETWORKS =
    Object.freeze([
        "mtn",
        "airtel",
        "glo",
        "9mobile"
    ]);


// =========================================================
// CACHE
// =========================================================

let catalogCache =
    null;


// =========================================================
// ERROR HELPER
// =========================================================

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


// =========================================================
// POSITIVE INTEGER
// =========================================================

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


// =========================================================
// NON-NEGATIVE INTEGER
// =========================================================

function normalizeNonNegativeInteger(
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
        number >= 0
    ) {

        return number;

    }

    return fallback;

}


// =========================================================
// STRING
// =========================================================

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


// =========================================================
// NETWORK
// =========================================================

function normalizeNetwork(
    value
) {

    return normalizeString(
        value
    )
        .toLowerCase();

}


// =========================================================
// PLAN ID
// =========================================================

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


// =========================================================
// NAIRA → KOBO
// =========================================================
//
// Supports:
//
//     260
//     "260"
//     "260.50"
//
// Stores the final amount as integer kobo.
// =========================================================

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

    const parts =
        text.split(
            "."
        );

    const wholePart =
        parts[0];

    const decimalPart =
        parts[1] ||
        "";

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


// =========================================================
// PROVIDER PRICE SELECTION
// =========================================================
//
// Different provider responses/accounts may expose pricing
// under different fields.
//
// Prefer the most explicit reseller/API acquisition price.
//
//     reseller_price
//     api_price
//     price
//
// The current official VTU documentation uses `price` in its
// variations examples and states that the endpoint provides
// reseller/API prices.
// =========================================================

function getProviderPriceKobo(
    variation
) {

    const possiblePrices =
        [
            variation.reseller_price,
            variation.api_price,
            variation.price
        ];

    for (
        const value
        of possiblePrices
    ) {

        const kobo =
            nairaToKobo(
                value
            );

        if (
            kobo !==
            null
        ) {

            return kobo;

        }

    }

    return null;

}


// =========================================================
// CUSTOMER PRICE
// =========================================================

function calculateCustomerPriceKobo(
    providerPriceKobo
) {

    if (
        !Number.isSafeInteger(
            providerPriceKobo
        ) ||
        providerPriceKobo <= 0
    ) {

        return null;

    }

    const customerPriceKobo =
        providerPriceKobo +
        DATA_CUSTOMER_MARGIN_KOBO;

    if (
        !Number.isSafeInteger(
            customerPriceKobo
        ) ||
        customerPriceKobo <= 0
    ) {

        return null;

    }

    return customerPriceKobo;

}


// =========================================================
// AVAILABILITY
// =========================================================

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

    return "unavailable";

}


// =========================================================
// DATA PLAN
// =========================================================

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


// =========================================================
// SERVICE NAME
// =========================================================

function normalizeServiceName(
    value
) {

    const serviceName =
        normalizeString(
            value
        );

    if (
        !serviceName ||
        serviceName.length >
        100
    ) {

        return "";

    }

    return serviceName;

}


// =========================================================
// DATA AMOUNT PARSER
// =========================================================
//
// Examples:
//
//     470MB
//     1GB
//     2.5GB
//     75GB
// =========================================================

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
                null,

            megabytes:
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
                null,

            megabytes:
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
                null,

            megabytes:
                null

        };

    }

    let megabytes;

    if (
        unit ===
        "TB"
    ) {

        megabytes =
            value *
            1024 *
            1024;

    } else if (
        unit ===
        "GB"
    ) {

        megabytes =
            value *
            1024;

    } else if (
        unit ===
        "MB"
    ) {

        megabytes =
            value;

    } else {

        megabytes =
            value /
            1024;

    }

    if (
        !Number.isFinite(
            megabytes
        ) ||
        megabytes <= 0
    ) {

        return {

            value:
                null,

            unit:
                null,

            label:
                null,

            megabytes:
                null

        };

    }

    return {

        value,

        unit,

        label:
            `${match[1]} ${unit}`,

        megabytes

    };

}


// =========================================================
// VALIDITY PARSER
// =========================================================
//
// We deliberately do not guess durations.
//
// Supported explicit examples:
//
//     1 Day
//     2 Days
//     7 Days
//     30 Days
//     90 Days
//     24 Hours
// =========================================================

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
            /(?:^|\s|[-–—(])(\d+(?:\.\d+)?)\s*(?:day|days)\b/i
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
            /(?:^|\s|[-–—(])(\d+(?:\.\d+)?)\s*(?:hour|hours)\b/i
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
                    `${hourMatch[1]} ${Number(hours) === 1 ? "Hour" : "Hours"}`

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


// =========================================================
// EXTRA VALUE DETECTION
// =========================================================
//
// We only mark Extra Value when the provider's own product
// description explicitly indicates additional benefits.
//
// Examples:
//
//     1GB + 5 mins
//     2GB + 2 mins
//     YouTube
//     YouTube Music
//     Night
//     Social
//     Bonus
//     Streaming
//
// We do NOT invent any bonus amount.
// =========================================================

function isExtraValuePlan(
    dataPlan
) {

    const normalized =
        normalizeString(
            dataPlan
        )
            .toLowerCase();

    if (
        !normalized
    ) {

        return false;

    }

    const patterns =
        [
            /\+\s*\d+(?:\.\d+)?\s*(?:mins?|minutes?)\b/i,

            /\+\s*\d+(?:\.\d+)?\s*(?:sms|texts?)\b/i,

            /\bbonus\b/i,

            /\byoutube\b/i,

            /\byoutube\s+music\b/i,

            /\bstreaming\b/i,

            /\bsocial\b/i,

            /\bnight\b/i,

            /\bwhatsapp\b/i,

            /\bfacebook\b/i,

            /\binstagram\b/i,

            /\btiktok\b/i,

            /\btelegram\b/i

        ];

    return patterns.some(
        pattern =>
            pattern.test(
                normalized
            )
    );

}


// =========================================================
// BASE CATEGORY
// =========================================================
//
// We intentionally use conservative category boundaries.
//
// Daily:
//     1–7 days
//
// Monthly:
//     28–45 days
//
// 3 Months:
//     60–120 days
//
// Other:
//     unusual durations which do not cleanly belong.
//
// IMPORTANT:
//
// We do not call a 30-day product Daily just because it is
// shorter than 60 days.
//
// We do not call a 90-day product Monthly.
//
// We keep the category honest.
// =========================================================

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
        validityDays <=
        7
    ) {

        return "Daily";

    }

    if (
        validityDays >=
            28 &&
        validityDays <=
            45
    ) {

        return "Monthly";

    }

    if (
        validityDays >=
            60 &&
        validityDays <=
            120
    ) {

        return "3 Months";

    }

    return "Other";

}


// =========================================================
// EXPLICIT HOT IDS
// =========================================================
//
// Optional administrator override.
//
// Example:
//
//     HOT_DATA_PLAN_IDS=2676,2660,244542
//
// Only IDs which actually exist and are available can become
// Hot.
// =========================================================

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


// =========================================================
// PLAN VALUE SCORE
// =========================================================
//
// Hot is intended to help users find affordable, useful plans.
//
// We calculate a value score:
//
//     data MB / customer Naira
//
// Higher is better.
//
// We add a small validity preference so that a huge amount of
// data valid for only a tiny period does not automatically beat
// every longer-lasting plan.
//
// This is merchandising only.
//
// It does NOT change the product, price or provider variation.
// =========================================================

function calculateHotScore(
    plan
) {

    if (
        !plan ||
        !Number.isFinite(
            plan.dataAmountMegabytes
        ) ||
        plan.dataAmountMegabytes <= 0 ||
        !Number.isSafeInteger(
            plan.customerPriceKobo
        ) ||
        plan.customerPriceKobo <= 0
    ) {

        return null;

    }

    const customerPriceNaira =
        plan.customerPriceKobo /
        100;

    if (
        customerPriceNaira <=
        0
    ) {

        return null;

    }

    const dataPerNaira =
        plan.dataAmountMegabytes /
        customerPriceNaira;

    let validityMultiplier =
        1;

    if (
        Number.isFinite(
            plan.validityDays
        ) &&
        plan.validityDays > 0
    ) {

        if (
            plan.validityDays >=
            30
        ) {

            validityMultiplier =
                1.15;

        } else if (
            plan.validityDays >=
            7
        ) {

            validityMultiplier =
                1.08;

        } else if (
            plan.validityDays >=
            2
        ) {

            validityMultiplier =
                1.02;

        }

    }

    return (
        dataPerNaira *
        validityMultiplier
    );

}


// =========================================================
// RAW VARIATION VALIDATION
// =========================================================

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

    const providerPriceKobo =
        getProviderPriceKobo(
            variation
        );

    const availability =
        normalizeAvailability(
            variation.availability
        );

    if (
        !variationId ||
        !SUPPORTED_NETWORKS.includes(
            network
        ) ||
        !serviceName ||
        !dataPlan ||
        providerPriceKobo ===
        null ||
        availability !==
        "available"
    ) {

        return false;

    }

    return true;

}


// =========================================================
// NORMALIZE ONE VARIATION
// =========================================================
//
// Hot is assigned later after the complete catalogue is
// available, because automatic Hot selection compares real
// products against each other.
// =========================================================

function normalizeVariation(
    variation
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

    const providerPriceKobo =
        getProviderPriceKobo(
            variation
        );

    const customerPriceKobo =
        calculateCustomerPriceKobo(
            providerPriceKobo
        );

    if (
        customerPriceKobo ===
        null
    ) {

        return null;

    }

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

    const baseCategory =
        determineBaseCategory(
            validity.days
        );

    const extraValue =
        isExtraValuePlan(
            dataPlan
        );

    /*
     * The category field is retained for backward
     * compatibility with the existing backend.
     *
     * The new authoritative field is `categories`.
     */

    const categories =
        [];

    if (
        baseCategory !==
        "Other"
    ) {

        categories.push(
            baseCategory
        );

    }

    if (
        extraValue
    ) {

        categories.push(
            "Extra Value"
        );

    }

    /*
     * We start without Hot.
     *
     * Hot is assigned by the complete catalogue builder.
     */

    return {

        /*
         * Stable NovaPay identity.
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
         * Provider's exact product description.
         */

        dataPlan,

        /*
         * Display information.
         */

        dataAmount:
            dataAmount.label,

        dataAmountValue:
            dataAmount.value,

        dataAmountUnit:
            dataAmount.unit,

        dataAmountMegabytes:
            dataAmount.megabytes,

        validityDays:
            validity.days,

        validityLabel:
            validity.label,

        /*
         * Merchandising.
         */

        category:
            baseCategory,

        categories,

        isHot:
            false,

        isExtraValue:
            extraValue,

        /*
         * Provider/API acquisition pricing.
         *
         * `priceKobo` is retained for compatibility.
         */

        priceNaira:
            providerPriceKobo /
            100,

        priceKobo:
            providerPriceKobo,

        providerPriceNaira:
            providerPriceKobo /
            100,

        providerPriceKobo,

        acquisitionPriceNaira:
            providerPriceKobo /
            100,

        acquisitionPriceKobo:
            providerPriceKobo,

        /*
         * Customer-facing price.
         *
         * Defaults to exactly the provider/API price.
         */

        customerPriceNaira:
            customerPriceKobo /
            100,

        customerPriceKobo,

        customerMarginKobo:
            DATA_CUSTOMER_MARGIN_KOBO,

        customerMarginNaira:
            DATA_CUSTOMER_MARGIN_KOBO /
            100,

        /*
         * Only available products reach this point.
         */

        availability,

        /*
         * Audit/source metadata.
         */

        source:
            "vtu_data_variations"

    };

}


// =========================================================
// HOT SELECTION
// =========================================================
//
// Two modes:
//
// 1. Explicit HOT_DATA_PLAN_IDS exists:
//       only those real available plans become Hot.
//
// 2. No explicit configuration:
//       automatically select the best affordable plans.
//
// Automatic mode is designed around real customer behaviour:
//
//     - cheap enough to be useful
//     - meaningful amount of data
//     - strong data-per-naira value
//     - available now
//
// We do not manufacture a Hot price or plan.
// =========================================================

function selectAutomaticHotPlans(
    plans
) {

    const selectedIds =
        new Set();

    for (
        const network
        of NETWORK_ORDER
    ) {

        const candidates =
            plans
                .filter(
                    plan =>
                        plan.network ===
                        network
                )
                .filter(
                    plan =>
                        Number.isFinite(
                            plan.dataAmountMegabytes
                        )
                )
                .filter(
                    plan =>
                        plan.dataAmountMegabytes >=
                        HOT_MIN_DATA_MB
                )
                .filter(
                    plan =>
                        plan.customerPriceKobo <=
                        HOT_MAX_PRICE_KOBO
                )
                .map(
                    plan => ({

                        plan,

                        score:
                            calculateHotScore(
                                plan
                            )

                    })
                )
                .filter(
                    item =>
                        Number.isFinite(
                            item.score
                        )
                )
                .sort(
                    (
                        first,
                        second
                    ) => {

                        if (
                            second.score !==
                            first.score
                        ) {

                            return (
                                second.score -
                                first.score
                            );

                        }

                        if (
                            first.plan.customerPriceKobo !==
                            second.plan.customerPriceKobo
                        ) {

                            return (
                                first.plan.customerPriceKobo -
                                second.plan.customerPriceKobo
                            );

                        }

                        return (
                            second.plan.dataAmountMegabytes -
                            first.plan.dataAmountMegabytes
                        );

                    }
                );

        for (
            const candidate
            of candidates.slice(
                0,
                HOT_MAX_PLANS_PER_NETWORK
            )
        ) {

            selectedIds.add(
                candidate.plan.planId
            );

        }

    }

    return selectedIds;

}


// =========================================================
// APPLY HOT CATEGORY
// =========================================================

function applyHotCategory(
    plans
) {

    const configuredHotIds =
        getConfiguredHotPlanIds();

    const automaticHotIds =
        configuredHotIds.size >
        0
            ? configuredHotIds
            : selectAutomaticHotPlans(
                plans
            );

    return plans.map(
        plan => {

            const isHot =
                automaticHotIds.has(
                    plan.planId
                );

            const categories =
                [
                    ...plan.categories
                ];

            if (
                isHot &&
                !categories.includes(
                    "Hot"
                )
            ) {

                categories.unshift(
                    "Hot"
                );

            }

            /*
             * For backward compatibility:
             *
             * If Hot is the only meaningful merchandising
             * category, `category` becomes Hot.
             *
             * Otherwise the original base category remains.
             */

            let primaryCategory =
                plan.category;

            if (
                isHot &&
                primaryCategory ===
                "Other"
            ) {

                primaryCategory =
                    "Hot";

            }

            return Object.freeze({

                ...plan,

                category:
                    primaryCategory,

                categories:
                    Object.freeze(
                        categories
                    ),

                isHot

            });

        }
    );

}


// =========================================================
// DUPLICATE PLAN PROTECTION
// =========================================================
//
// A provider variation ID must identify exactly one product.
//
// If duplicate records disagree, fail safely.
// =========================================================

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

        if (
            existing.network !==
                variation.network ||

            existing.variationId !==
                variation.variationId ||

            existing.providerPriceKobo !==
                variation.providerPriceKobo ||

            existing.dataPlan !==
                variation.dataPlan
        ) {

            throw createCatalogError(
                "VTU returned conflicting Data variation information.",
                503,
                "CONFLICTING_DATA_VARIATION"
            );

        }

    }

    return Array.from(
        byPlanId.values()
    );

}


// =========================================================
// CATEGORY ORDER
// =========================================================

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

        "Extra Value":
            4,

        "Other":
            5

    };

    return (
        order[category] ??
        99
    );

}


// =========================================================
// SORT
// =========================================================
//
// Network:
//
//     MTN
//     Airtel
//     Glo
//     9mobile
//
// Then:
//
//     category
//     price
//     data amount
//     plan ID
// =========================================================

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

    /*
     * Hot products appear first.
     */

    if (
        first.isHot !==
        second.isHot
    ) {

        return first.isHot
            ? -1
            : 1;

    }

    const firstCategory =
        categoryOrder(
            first.category
        );

    const secondCategory =
        categoryOrder(
            second.category
        );

    if (
        firstCategory !==
        secondCategory
    ) {

        return (
            firstCategory -
            secondCategory
        );

    }

    if (
        first.customerPriceKobo !==
        second.customerPriceKobo
    ) {

        return (
            first.customerPriceKobo -
            second.customerPriceKobo
        );

    }

    const firstAmount =
        first.dataAmountMegabytes ??
        Number.POSITIVE_INFINITY;

    const secondAmount =
        second.dataAmountMegabytes ??
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


// =========================================================
// FETCH WITH TIMEOUT
// =========================================================

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

    } catch (
        error
    ) {

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


// =========================================================
// PARSE PROVIDER RESPONSE
// =========================================================

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


// =========================================================
// BUILD CURRENT CATALOG
// =========================================================

async function fetchCurrentCatalog() {

    const response =
        await fetchWithTimeout(
            VTU_DATA_VARIATIONS_URL
        );

    const rawVariations =
        await parseProviderResponse(
            response
        );

    /*
     * Normalize only real available products.
     */

    const normalizedPlans =
        rawVariations
            .map(
                variation =>
                    normalizeVariation(
                        variation
                    )
            )
            .filter(
                Boolean
            );

    if (
        normalizedPlans.length ===
        0
    ) {

        throw createCatalogError(
            "VTU returned no usable available Data plans.",
            503,
            "EMPTY_DATA_CATALOG"
        );

    }

    /*
     * One exact variation ID = one exact product.
     */

    const uniquePlans =
        buildUniqueCatalog(
            normalizedPlans
        );

    /*
     * Apply Hot merchandising only after all real products
     * are available for comparison.
     */

    const categorizedPlans =
        applyHotCategory(
            uniquePlans
        );

    categorizedPlans.sort(
        compareCatalogPlans
    );

    return Object.freeze(
        categorizedPlans
    );

}


// =========================================================
// CACHE CHECK
// =========================================================

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


// =========================================================
// GET DATA CATALOG
// =========================================================

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


// =========================================================
// GET DATA PLANS FOR NETWORK
// =========================================================

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


// =========================================================
// FIND EXACT DATA PLAN
// =========================================================
//
// This is important for purchase security.
//
// The service can request a fresh catalogue and then locate
// the exact variation ID.
//
// An unavailable variation will not be returned.
// =========================================================

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

    return {

        ...plan,

        categories:
            [
                ...plan.categories
            ]

    };

}


// =========================================================
// CACHE METADATA
// =========================================================

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
                0,

            fresh:
                false

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


// =========================================================
// CLEAR CACHE
// =========================================================

function clearCatalogCache() {

    catalogCache =
        null;

}


// =========================================================
// EXPORTS
// =========================================================

module.exports = Object.freeze({

    VTU_DATA_VARIATIONS_URL,

    VTU_CATALOG_TIMEOUT_MS,

    CATALOG_CACHE_TTL_MS,

    DATA_CUSTOMER_MARGIN_KOBO,

    HOT_MAX_PRICE_KOBO,

    HOT_MIN_DATA_MB,

    HOT_MAX_PLANS_PER_NETWORK,

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

    determineBaseCategory,

    isExtraValuePlan,

    calculateHotScore

});