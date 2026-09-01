// airtime/vtu.js

const crypto = require("crypto");


// =====================================================
// NOVAPAY VTU.NG PROVIDER ADAPTER
// =====================================================
//
// This file is the ONLY layer that talks directly to
// VTU.ng for Airtime.
//
// The rest of NovaPay must NOT know:
// - VTU.ng URLs
// - VTU authentication details
// - VTU response structure
// - VTU status names
//
// It converts VTU.ng responses into NovaPay's internal:
//
// success
// failure
// unknown
//
// IMPORTANT FINANCIAL RULE:
//
// Network errors, timeouts and unexpected provider
// responses are UNKNOWN.
//
// UNKNOWN NEVER automatically releases the user's
// reserved money.
//
// The transaction remains PENDING and can later be
// reconciled through VTU.ng requery.
//
// =====================================================


// =====================================================
// VTU.NG API CONFIGURATION
// =====================================================

const VTU_BASE_URL =
    (
        process.env.VTU_BASE_URL ||
        "https://vtu.ng/wp-json"
    ).replace(/\/+$/, "");


const VTU_AUTH_URL =
    `${VTU_BASE_URL}/jwt-auth/v1/token`;


const VTU_API_URL =
    `${VTU_BASE_URL}/api/v2`;


const VTU_USERNAME =
    String(
        process.env.VTU_USERNAME ||
        ""
    ).trim();


const VTU_PASSWORD =
    String(
        process.env.VTU_PASSWORD ||
        ""
    );


const REQUEST_TIMEOUT_MS =
    Number.isSafeInteger(
        Number(
            process.env.VTU_REQUEST_TIMEOUT_MS
        )
    ) &&
    Number(
        process.env.VTU_REQUEST_TIMEOUT_MS
    ) > 0
        ? Number(
            process.env.VTU_REQUEST_TIMEOUT_MS
        )
        : 15000;


// =====================================================
// TOKEN CACHE
// =====================================================
//
// VTU.ng JWT tokens expire after approximately 7 days.
//
// We keep the token in process memory.
//
// The token is NEVER returned to the frontend.
//
// If authentication fails, we clear the cached token
// and retry authentication once.
//
// =====================================================

let cachedToken = null;

let cachedTokenExpiresAt = 0;


// =====================================================
// ERROR CLASS
// =====================================================

class VtuProviderError extends Error {

    constructor(
        message,
        {
            kind = "unknown",
            httpStatus = null,
            providerCode = null,
            providerStatus = null,
            providerReference = null,
            rawMessage = null
        } = {}
    ) {

        super(message);

        this.name =
            "VtuProviderError";

        this.kind =
            kind;

        this.httpStatus =
            httpStatus;

        this.providerCode =
            providerCode;

        this.providerStatus =
            providerStatus;

        this.providerReference =
            providerReference;

        this.rawMessage =
            rawMessage;

    }

}


// =====================================================
// CONFIGURATION VALIDATION
// =====================================================

function validateConfiguration() {

    if (!VTU_USERNAME) {

        throw new VtuProviderError(
            "VTU.ng username is not configured.",
            {
                kind:
                    "configuration"
            }
        );

    }


    if (!VTU_PASSWORD) {

        throw new VtuProviderError(
            "VTU.ng password is not configured.",
            {
                kind:
                    "configuration"
            }
        );

    }

}


// =====================================================
// SAFE REQUEST ID
// =====================================================
//
// VTU.ng requires request_id and documents a maximum
// length of 50 characters.
//
// NovaPay transaction IDs are already unique.
//
// We additionally hash them into a short deterministic
// provider-safe identifier.
//
// =====================================================

function createProviderRequestId(
    transactionId
) {

    const normalized =
        String(
            transactionId || ""
        ).trim();


    if (!normalized) {

        throw new VtuProviderError(
            "NovaPay transaction ID is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    return (
        "NP" +
        crypto
            .createHash("sha256")
            .update(normalized)
            .digest("hex")
            .slice(0, 46)
    );

}


// =====================================================
// ABORTABLE FETCH
// =====================================================

async function fetchWithTimeout(
    url,
    options = {}
) {

    const controller =
        new AbortController();


    const timeout =
        setTimeout(
            () => {
                controller.abort();
            },
            REQUEST_TIMEOUT_MS
        );


    try {

        return await fetch(
            url,
            {
                ...options,
                signal:
                    controller.signal
            }
        );

    }

    catch (error) {

        if (
            error?.name ===
            "AbortError"
        ) {

            throw new VtuProviderError(
                "VTU.ng request timed out.",
                {
                    kind:
                        "timeout"
                }
            );

        }


        throw new VtuProviderError(
            "Unable to reach VTU.ng.",
            {
                kind:
                    "network",
                rawMessage:
                    String(
                        error?.message ||
                        ""
                    ).slice(
                        0,
                        300
                    )
            }
        );

    }

    finally {

        clearTimeout(
            timeout
        );

    }

}


// =====================================================
// SAFE JSON PARSING
// =====================================================

async function parseJsonResponse(
    response
) {

    const text =
        await response.text();


    if (!text) {

        return null;

    }


    try {

        return JSON.parse(
            text
        );

    }

    catch {

        throw new VtuProviderError(
            "VTU.ng returned an invalid response.",
            {
                kind:
                    "unknown",
                httpStatus:
                    response.status
            }
        );

    }

}


// =====================================================
// GET ACCESS TOKEN
// =====================================================

async function getAccessToken({
    forceRefresh = false
} = {}) {

    validateConfiguration();


    const now =
        Date.now();


    /*
     * Keep a safety margin before the token expires.
     *
     * We don't want to start a financial request with a
     * token that is about to expire.
     */

    if (
        !forceRefresh &&
        cachedToken &&
        cachedTokenExpiresAt >
            now + 10 * 60 * 1000
    ) {

        return cachedToken;

    }


    let response;


    try {

        response =
            await fetchWithTimeout(
                VTU_AUTH_URL,
                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/json",

                        "Accept":
                            "application/json"

                    },

                    body:
                        JSON.stringify({

                            username:
                                VTU_USERNAME,

                            password:
                                VTU_PASSWORD

                        })

                }
            );

    }

    catch (error) {

        throw error;

    }


    const data =
        await parseJsonResponse(
            response
        );


    if (
        !response.ok ||
        !data ||
        typeof data.token !==
            "string" ||
        !data.token.trim()
    ) {

        throw new VtuProviderError(
            "VTU.ng authentication failed.",
            {

                kind:
                    "authentication",

                httpStatus:
                    response.status,

                providerCode:
                    data?.code ||
                    null,

                rawMessage:
                    String(
                        data?.message ||
                        ""
                    ).slice(
                        0,
                        300
                    )

            }
        );

    }


    cachedToken =
        data.token.trim();


    /*
     * VTU.ng documents a 7-day token lifetime.
     *
     * We cache for slightly less than 7 days.
     */

    cachedTokenExpiresAt =
        now +
        (
            6 * 24 * 60 * 60 * 1000
        );


    return cachedToken;

}


// =====================================================
// CLEAR TOKEN
// =====================================================

function clearAccessToken() {

    cachedToken =
        null;

    cachedTokenExpiresAt =
        0;

}


// =====================================================
// AUTHENTICATED API REQUEST
// =====================================================

async function authenticatedRequest(
    path,
    {
        method = "GET",
        body = null,
        retryAuthentication = true
    } = {}
) {

    let token =
        await getAccessToken();


    let response;


    try {

        response =
            await fetchWithTimeout(
                `${VTU_API_URL}/${path}`,
                {

                    method,

                    headers: {

                        "Authorization":
                            `Bearer ${token}`,

                        "Content-Type":
                            "application/json",

                        "Accept":
                            "application/json"

                    },

                    body:
                        body === null
                            ? undefined
                            : JSON.stringify(
                                body
                            )

                }
            );

    }

    catch (error) {

        throw error;

    }


    /*
     * If VTU says the JWT is invalid, obtain a fresh
     * token and retry the HTTP request once.
     *
     * This is safe because the actual Airtime request
     * uses the same request_id.
     */

    if (
        (
            response.status === 401 ||
            response.status === 403
        ) &&
        retryAuthentication
    ) {

        clearAccessToken();


        token =
            await getAccessToken({
                forceRefresh:
                    true
            });


        try {

            response =
                await fetchWithTimeout(
                    `${VTU_API_URL}/${path}`,
                    {

                        method,

                        headers: {

                            "Authorization":
                                `Bearer ${token}`,

                            "Content-Type":
                                "application/json",

                            "Accept":
                                "application/json"

                        },

                        body:
                            body === null
                                ? undefined
                                : JSON.stringify(
                                    body
                                )

                    }
                );

        }

        catch (error) {

            throw error;

        }

    }


    const data =
        await parseJsonResponse(
            response
        );


    return {

        response,

        data

    };

}


// =====================================================
// PROVIDER STATUS NORMALIZATION
// =====================================================
//
// VTU.ng documents:
//
// completed-api
// processing-api
// queued-api
// initiated-api
// cancelled
// failed
// refunded
// pending
// on-hold
//
// Only completed-api is a confirmed success.
//
// Failed/refunded/cancelled are confirmed provider
// failure states.
//
// Everything else remains UNKNOWN/PENDING.
//
// =====================================================

function normalizeProviderStatus(
    status
) {

    const normalized =
        String(
            status || ""
        )
            .trim()
            .toLowerCase();


    if (
        normalized ===
            "completed-api"
    ) {

        return "success";

    }


    if (
        normalized ===
            "failed" ||
        normalized ===
            "refunded" ||
        normalized ===
            "cancelled"
    ) {

        return "failure";

    }


    return "unknown";

}


// =====================================================
// MONEY TO KOBO
// =====================================================
//
// VTU returns monetary values as numbers/strings in NGN.
//
// We convert them into integer kobo.
//
// Example:
//
// "97.50"
// → 9750
//
// Avoid floating point financial calculations.
//
// =====================================================

function nairaToKobo(
    value
) {

    const text =
        String(
            value ?? ""
        ).trim();


    if (!/^\d+(\.\d{1,2})?$/.test(text)) {

        return null;

    }


    const parts =
        text.split(".");


    const naira =
        Number(
            parts[0]
        );


    const koboText =
        (
            parts[1] ||
            ""
        ).padEnd(
            2,
            "0"
        );


    const kobo =
        Number(
            koboText || "0"
        );


    if (
        !Number.isSafeInteger(
            naira
        ) ||
        !Number.isSafeInteger(
            kobo
        )
    ) {

        return null;

    }


    const total =
        (
            naira * 100
        ) +
        kobo;


    if (
        !Number.isSafeInteger(
            total
        )
    ) {

        return null;

    }


    return total;

}


// =====================================================
// EXTRACT PROVIDER REFERENCE
// =====================================================

function extractProviderReference(
    data
) {

    const reference =
        data?.order_id ??
        data?.data?.order_id ??
        null;


    if (
        reference === null ||
        reference === undefined
    ) {

        return null;

    }


    const normalized =
        String(
            reference
        ).trim();


    return normalized ||
        null;

}


// =====================================================
// EXTRACT PROVIDER COST
// =====================================================
//
// VTU.ng's Airtime response includes amount_charged.
//
// Example:
//
// amount       = 100.00
// discount     = 2.50
// amount_charged = 97.50
//
// Therefore provider cost is amount_charged.
//
// This allows NovaPay to calculate:
//
// gross gain = customer amount - provider cost
//
// =====================================================

function extractProviderCostKobo(
    data
) {

    const amountCharged =
        data?.amount_charged ??
        data?.data?.amount_charged;


    if (
        amountCharged ===
            undefined ||
        amountCharged ===
            null
    ) {

        return null;

    }


    return nairaToKobo(
        amountCharged
    );

}


// =====================================================
// NORMALIZE AIRTIME RESPONSE
// =====================================================

function normalizeAirtimeResponse(
    data,
    httpStatus
) {

    const payload =
        data?.data &&
        typeof data.data === "object"
            ? data.data
            : data || {};


    const providerStatus =
        String(
            payload.status ||
            ""
        )
            .trim()
            .toLowerCase();


    const outcome =
        normalizeProviderStatus(
            providerStatus
        );


    const providerReference =
        extractProviderReference(
            data
        );


    const providerCostKobo =
        extractProviderCostKobo(
            data
        );


    const message =
        String(
            data?.message ||
            ""
        )
            .trim() ||
            null;


    return {

        outcome,

        providerReference,

        providerCostKobo,

        providerStatus:
            providerStatus ||
            null,

        providerCode:
            data?.code ||
            null,

        message,

        httpStatus

    };

}


// =====================================================
// PURCHASE AIRTIME
// =====================================================

async function purchaseAirtime({
    transactionId,
    network,
    phoneNumber,
    amountKobo
}) {

    const normalizedTransactionId =
        String(
            transactionId || ""
        ).trim();


    const normalizedNetwork =
        String(
            network || ""
        )
            .trim()
            .toLowerCase();


    const normalizedPhone =
        String(
            phoneNumber || ""
        ).trim();


    const amount =
        Number(
            amountKobo
        );


    if (!normalizedTransactionId) {

        throw new VtuProviderError(
            "Transaction ID is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    if (!normalizedNetwork) {

        throw new VtuProviderError(
            "Airtime network is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    if (!normalizedPhone) {

        throw new VtuProviderError(
            "Airtime phone number is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        amount % 100 !== 0
    ) {

        throw new VtuProviderError(
            "Airtime amount must be a valid whole-naira amount.",
            {
                kind:
                    "validation"
            }
        );

    }


    const amountNaira =
        amount / 100;


    const requestId =
        createProviderRequestId(
            normalizedTransactionId
        );


    let result;


    try {

        result =
            await authenticatedRequest(
                "airtime",
                {

                    method:
                        "POST",

                    body: {

                        request_id:
                            requestId,

                        phone:
                            normalizedPhone,

                        service_id:
                            normalizedNetwork,

                        amount:
                            amountNaira

                    }

                }
            );

    }

    catch (error) {

        /*
         * CRITICAL:
         *
         * A timeout/network error does NOT mean VTU.ng
         * failed to process the Airtime.
         *
         * Therefore throw an UNKNOWN provider error.
         *
         * The Airtime service will keep the transaction
         * pending and reconciliation will use request_id.
         */

        if (
            error instanceof
            VtuProviderError
        ) {

            throw error;

        }


        throw new VtuProviderError(
            "VTU.ng request could not be verified.",
            {
                kind:
                    "unknown"
            }
        );

    }


    const normalized =
        normalizeAirtimeResponse(
            result.data,
            result.response.status
        );


    /*
     * A completed-api response is the ONLY confirmed
     * successful provider result.
     */

    if (
        normalized.outcome ===
        "success"
    ) {

        return {

            outcome:
                "success",

            providerReference:
                normalized.providerReference,

            providerCostKobo:
                normalized.providerCostKobo,

            providerStatus:
                normalized.providerStatus,

            providerCode:
                normalized.providerCode,

            message:
                normalized.message,

            providerRequestId:
                requestId

        };

    }


    /*
     * Explicit failed/refunded/cancelled states are
     * confirmed provider failures.
     */

    if (
        normalized.outcome ===
        "failure"
    ) {

        return {

            outcome:
                "failure",

            providerReference:
                normalized.providerReference,

            providerCostKobo:
                normalized.providerCostKobo,

            providerStatus:
                normalized.providerStatus,

            providerCode:
                normalized.providerCode,

            message:
                normalized.message ||
                "VTU.ng confirmed that the Airtime order failed.",

            providerRequestId:
                requestId

        };

    }


    /*
     * Processing, queued, initiated, pending and on-hold
     * are NOT failures.
     *
     * They remain unknown/pending until requery/webhook
     * confirms the final state.
     */

    return {

        outcome:
            "unknown",

        providerReference:
            normalized.providerReference,

        providerCostKobo:
            normalized.providerCostKobo,

        providerStatus:
            normalized.providerStatus,

        providerCode:
            normalized.providerCode,

        message:
            normalized.message ||
            "VTU.ng is still processing the Airtime order.",

        providerRequestId:
            requestId

    };

}


// =====================================================
// REQUERY AIRTIME ORDER
// =====================================================
//
// This is extremely important for NovaPay.
//
// If the original Airtime request times out:
//
// NovaPay
//    ↓
// VTU request sent
//    ↓
// network timeout
//
// We DON'T refund immediately.
//
// Later:
//
// NovaPay
//    ↓
// POST /api/v2/requery
//    ↓
// request_id
//    ↓
// final provider status
//
// =====================================================

async function requeryAirtime(
    transactionId
) {

    const normalizedTransactionId =
        String(
            transactionId || ""
        ).trim();


    if (!normalizedTransactionId) {

        throw new VtuProviderError(
            "Transaction ID is required for requery.",
            {
                kind:
                    "validation"
            }
        );

    }


    const requestId =
        createProviderRequestId(
            normalizedTransactionId
        );


    let result;


    try {

        result =
            await authenticatedRequest(
                "requery",
                {

                    method:
                        "POST",

                    body: {

                        request_id:
                            requestId

                    }

                }
            );

    }

    catch (error) {

        /*
         * Requery itself can fail.
         *
         * That still does NOT prove the original Airtime
         * failed.
         */

        if (
            error instanceof
            VtuProviderError
        ) {

            throw error;

        }


        throw new VtuProviderError(
            "Unable to verify the VTU.ng Airtime order.",
            {
                kind:
                    "unknown"
            }
        );

    }


    const normalized =
        normalizeAirtimeResponse(
            result.data,
            result.response.status
        );


    return {

        outcome:
            normalized.outcome,

        providerReference:
            normalized.providerReference,

        providerCostKobo:
            normalized.providerCostKobo,

        providerStatus:
            normalized.providerStatus,

        providerCode:
            normalized.providerCode,

        message:
            normalized.message,

        providerRequestId:
            requestId

    };

}


// =====================================================
// CHECK VTU WALLET BALANCE
// =====================================================
//
// This is an operational/admin function.
//
// It is NOT the user's NovaPay wallet.
//
// It checks the VTU.ng reseller wallet that NovaPay
// uses to fulfill Airtime.
//
// =====================================================

async function getProviderBalance() {

    let result;


    try {

        result =
            await authenticatedRequest(
                "balance",
                {

                    method:
                        "GET"

                }
            );

    }

    catch (error) {

        throw error;

    }


    const payload =
        result.data?.data ||
        {};


    const balance =
        Number(
            payload.balance
        );


    if (
        !Number.isFinite(
            balance
        ) ||
        balance < 0
    ) {

        throw new VtuProviderError(
            "VTU.ng returned an invalid wallet balance.",
            {
                kind:
                    "unknown"
            }
        );

    }


    return {

        balanceNaira:
            balance,

        balanceKobo:
            Math.round(
                balance * 100
            ),

        currency:
            String(
                payload.currency ||
                "NGN"
            )
                .trim()
                .toUpperCase()

    };

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    purchaseAirtime,

    requeryAirtime,

    getProviderBalance,

    getAccessToken,

    clearAccessToken,

    createProviderRequestId,

    VtuProviderError

};