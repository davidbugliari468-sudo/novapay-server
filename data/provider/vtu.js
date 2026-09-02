"use strict";

const crypto = require("crypto");


// =====================================================
// NOVAPAY — VTU.NG DATA PROVIDER ADAPTER
// =====================================================
//
// RESPONSIBILITY
//
// This module is the ONLY Data layer that communicates
// directly with VTU.ng.
//
// It does NOT:
//
// - access Firestore wallets
// - reserve wallet funds
// - commit wallet funds
// - release wallet funds
// - create NovaPay financial transactions
// - authenticate NovaPay users
// - trust frontend provider data
//
// It ONLY:
//
// - authenticates with VTU.ng
// - sends Data orders
// - requeried Data orders
// - normalizes provider responses
// - reports provider outcomes to the Data service
//
// PROVIDER OUTCOMES:
//
// success
// failure
// unknown
//
// UNKNOWN means:
//
// "We do not have enough evidence to conclude that the
// provider failed."
//
// Therefore the Data service MUST NOT release a wallet
// reservation merely because this adapter encountered a
// timeout, network error, malformed response, or other
// ambiguous provider condition.
//
// =====================================================


// =====================================================
// CONFIGURATION
// =====================================================

const VTU_BASE_URL =
    String(
        process.env.VTU_BASE_URL ||
        "https://vtu.ng/wp-json"
    )
        .trim()
        .replace(/\/+$/, "");


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


const configuredTimeout =
    Number(
        process.env.VTU_REQUEST_TIMEOUT_MS
    );


const VTU_REQUEST_TIMEOUT_MS =
    Number.isSafeInteger(
        configuredTimeout
    ) &&
    configuredTimeout > 0
        ? configuredTimeout
        : 15000;


// =====================================================
// TOKEN CACHE
// =====================================================

let cachedToken =
    null;


let cachedTokenExpiresAt =
    0;


// =====================================================
// PROVIDER ERROR
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

        super(
            message
        );

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
// TRANSACTION ID VALIDATION
// =====================================================

function requireTransactionId(
    transactionId
) {

    const normalized =
        String(
            transactionId ||
            ""
        ).trim();


    if (!normalized) {

        throw new VtuProviderError(
            "Transaction ID is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    if (
        normalized.length >
        200
    ) {

        throw new VtuProviderError(
            "Transaction ID is too long.",
            {
                kind:
                    "validation"
            }
        );

    }


    return normalized;

}


// =====================================================
// PROVIDER REQUEST ID
// =====================================================
//
// VTU.ng request_id has a maximum length.
//
// We derive it deterministically from the NovaPay
// transaction ID.
//
// Same NovaPay transaction:
//
//     transactionId
//          ↓
//     same request_id
//
// This is important when the original provider request
// times out and the order must later be requeried.
//
// Maximum output length:
//
//     48 characters
//
// =====================================================

function createProviderRequestId(
    transactionId
) {

    const normalized =
        requireTransactionId(
            transactionId
        );


    return (
        "ND" +
        crypto
            .createHash(
                "sha256"
            )
            .update(
                normalized,
                "utf8"
            )
            .digest(
                "hex"
            )
            .slice(
                0,
                46
            )
    );

}


// =====================================================
// ABORTABLE HTTP REQUEST
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
            VTU_REQUEST_TIMEOUT_MS
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
                    )
                        .slice(
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
// RESPONSE BODY PARSER
// =====================================================

async function parseJsonResponse(
    response
) {

    const text =
        await response.text();


    if (!text.trim()) {

        throw new VtuProviderError(
            "VTU.ng returned an empty response.",
            {
                kind:
                    "unknown",

                httpStatus:
                    response.status
            }
        );

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
                    response.status,

                rawMessage:
                    text.slice(
                        0,
                        300
                    )
            }
        );

    }

}


// =====================================================
// ACCESS TOKEN
// =====================================================

async function getAccessToken({
    forceRefresh = false
} = {}) {

    validateConfiguration();


    const now =
        Date.now();


    if (
        !forceRefresh &&
        cachedToken &&
        cachedTokenExpiresAt >
            now +
            (
                10 *
                60 *
                1000
            )
    ) {

        return cachedToken;

    }


    const response =
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


    let data;


    try {

        data =
            await parseJsonResponse(
                response
            );

    }

    catch (error) {

        if (
            error instanceof
            VtuProviderError
        ) {

            throw error;

        }


        throw new VtuProviderError(
            "VTU.ng authentication response could not be verified.",
            {
                kind:
                    "unknown",

                httpStatus:
                    response.status
            }
        );

    }


    if (
        !response.ok
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
                    )
                        .slice(
                            0,
                            300
                        )

            }
        );

    }


    if (
        typeof data?.token !==
            "string" ||
        !data.token.trim()
    ) {

        throw new VtuProviderError(
            "VTU.ng authentication returned no token.",
            {
                kind:
                    "authentication",

                httpStatus:
                    response.status
            }
        );

    }


    cachedToken =
        data.token.trim();


    /*
     * VTU.ng token lifetime is approximately seven days.
     *
     * Cache below that period so an almost-expired token
     * is not used for a provider operation.
     */

    cachedTokenExpiresAt =
        now +
        (
            6 *
            24 *
            60 *
            60 *
            1000
        );


    return cachedToken;

}


// =====================================================
// CLEAR ACCESS TOKEN
// =====================================================

function clearAccessToken() {

    cachedToken =
        null;


    cachedTokenExpiresAt =
        0;

}


// =====================================================
// AUTHENTICATED PROVIDER REQUEST
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
     * A 401/403 may mean the cached token has expired.
     *
     * Refresh once and retry the same provider operation.
     *
     * The request_id does not change.
     */

    if (
        (
            response.status ===
                401 ||
            response.status ===
                403
        ) &&
        retryAuthentication
    ) {

        clearAccessToken();


        token =
            await getAccessToken({
                forceRefresh:
                    true
            });


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


    let data;


    try {

        data =
            await parseJsonResponse(
                response
            );

    }

    catch (error) {

        if (
            error instanceof
            VtuProviderError
        ) {

            error.httpStatus =
                response.status;

            throw error;

        }


        throw new VtuProviderError(
            "VTU.ng response could not be verified.",
            {

                kind:
                    "unknown",

                httpStatus:
                    response.status

            }
        );

    }


    return {

        response,

        data

    };

}


// =====================================================
// PROVIDER STATUS NORMALIZATION
// =====================================================
//
// Confirmed success:
//
// completed-api
//
// Confirmed failure:
//
// failed
// refunded
// cancelled
//
// Everything else:
//
// unknown
//
// Processing/pending states are NEVER treated as failure.
// =====================================================

function normalizeProviderStatus(
    status
) {

    const normalized =
        String(
            status ||
            ""
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
// MONEY CONVERSION
// =====================================================
//
// Provider monetary values are represented in NGN.
//
// Convert safely to integer kobo.
//
// Examples:
//
// 100
// "100"
// "100.00"
// "97.50"
// =====================================================

function nairaToKobo(
    value
) {

    const text =
        String(
            value ??
            ""
        ).trim();


    if (
        !/^\d+(?:\.\d{1,2})?$/.test(
            text
        )
    ) {

        return null;

    }


    const parts =
        text.split(".");


    const naira =
        Number(
            parts[0]
        );


    const koboPart =
        (
            parts[1] ||
            ""
        )
            .padEnd(
                2,
                "0"
            );


    const kobo =
        Number(
            koboPart ||
            "0"
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
            naira *
            100
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
// PROVIDER REFERENCE EXTRACTION
// =====================================================

function extractProviderReference(
    data
) {

    const payload =
        data?.data &&
        typeof data.data ===
            "object"
            ? data.data
            : data;


    const candidates = [

        payload?.order_id,

        payload?.reference,

        payload?.transaction_id

    ];


    for (
        const candidate
        of candidates
    ) {

        if (
            candidate ===
                null ||
            candidate ===
                undefined
        ) {

            continue;

        }


        const normalized =
            String(
                candidate
            ).trim();


        if (
            normalized
        ) {

            return normalized;

        }

    }


    return null;

}


// =====================================================
// PROVIDER COST EXTRACTION
// =====================================================
//
// VTU.ng can return amount_charged.
//
// This represents the amount charged by the provider.
//
// Example:
//
// customer charge:
//     ₦799
//
// provider charge:
//     ₦779
//
// providerCostKobo:
//     77900
//
// The Data service uses this value to calculate the
// provider-side gross margin.
// =====================================================

function extractProviderCostKobo(
    data
) {

    const payload =
        data?.data &&
        typeof data.data ===
            "object"
            ? data.data
            : data;


    const amountCharged =
        payload?.amount_charged;


    if (
        amountCharged ===
            null ||
        amountCharged ===
            undefined
    ) {

        return null;

    }


    return nairaToKobo(
        amountCharged
    );

}


// =====================================================
// PROVIDER RESPONSE NORMALIZATION
// =====================================================

function normalizeProviderResponse(
    data,
    httpStatus
) {

    const payload =
        data?.data &&
        typeof data.data ===
            "object"
            ? data.data
            : data || {};


    const providerStatus =
        String(
            payload?.status ||
            data?.status ||
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


    const providerCode =
        data?.code ??
        payload?.code ??
        null;


    const message =
        String(
            data?.message ??
            payload?.message ??
            ""
        )
            .trim()
            .slice(
                0,
                500
            ) ||
        null;


    const variationId =
        payload?.variation_id ??
        null;


    const providerRequestId =
        payload?.request_id ??
        null;


    return {

        outcome,

        providerStatus:
            providerStatus ||
            null,

        providerReference,

        providerCostKobo,

        providerCode,

        message,

        variationId:
            variationId === null
                ? null
                : String(
                    variationId
                ),

        providerRequestId:
            providerRequestId === null
                ? null
                : String(
                    providerRequestId
                ),

        httpStatus

    };

}


// =====================================================
// PURCHASE INPUT VALIDATION
// =====================================================

function validatePurchaseInput({
    transactionId,
    network,
    phoneNumber,
    variationId
}) {

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );


    const normalizedNetwork =
        String(
            network ||
            ""
        )
            .trim()
            .toLowerCase();


    if (!normalizedNetwork) {

        throw new VtuProviderError(
            "Data network is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    const supportedNetworks = [

        "mtn",

        "airtel",

        "glo",

        "9mobile"

    ];


    if (
        !supportedNetworks.includes(
            normalizedNetwork
        )
    ) {

        throw new VtuProviderError(
            "Unsupported Data network.",
            {
                kind:
                    "validation"
            }
        );

    }


    const normalizedPhone =
        String(
            phoneNumber ||
            ""
        ).trim();


    if (!normalizedPhone) {

        throw new VtuProviderError(
            "Data phone number is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    const normalizedVariationId =
        String(
            variationId ??
            ""
        ).trim();


    if (!normalizedVariationId) {

        throw new VtuProviderError(
            "Data variation ID is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    if (
        normalizedVariationId.length >
        100
    ) {

        throw new VtuProviderError(
            "Data variation ID is too long.",
            {
                kind:
                    "validation"
            }
        );

    }


    return {

        transactionId:
            normalizedTransactionId,

        network:
            normalizedNetwork,

        phoneNumber:
            normalizedPhone,

        variationId:
            normalizedVariationId

    };

}


// =====================================================
// PURCHASE DATA
// =====================================================
//
// This function does NOT reserve or debit NovaPay money.
//
// The Data service must already have:
//
// 1. validated the customer request
// 2. verified the selected variation
// 3. determined the authoritative customer amount
// 4. created the NovaPay Data transaction
// 5. reserved the customer's wallet funds
//
// This adapter only sends the provider order.
//
// IMPORTANT:
//
// The customer amount is deliberately NOT sent to VTU.ng.
//
// VTU.ng determines the provider price from variation_id.
// =====================================================

async function purchaseData({
    transactionId,
    network,
    phoneNumber,
    variationId
}) {

    const input =
        validatePurchaseInput({

            transactionId,

            network,

            phoneNumber,

            variationId

        });


    const providerRequestId =
        createProviderRequestId(
            input.transactionId
        );


    let result;


    try {

        result =
            await authenticatedRequest(
                "data",
                {

                    method:
                        "POST",

                    body: {

                        request_id:
                            providerRequestId,

                        phone:
                            input.phoneNumber,

                        service_id:
                            input.network,

                        variation_id:
                            input.variationId

                    }

                }
            );

    }

    catch (error) {

        /*
         * NEVER convert an uncertain provider operation
         * into a confirmed failure.
         *
         * The Data service must keep the reservation
         * protected and reconcile later.
         */

        if (
            error instanceof
            VtuProviderError
        ) {

            throw error;

        }


        throw new VtuProviderError(
            "VTU.ng Data request could not be verified.",
            {
                kind:
                    "unknown"
            }
        );

    }


    const normalized =
        normalizeProviderResponse(
            result.data,
            result.response.status
        );


    if (
        normalized.outcome ===
        "success"
    ) {

        return {

            outcome:
                "success",

            providerRequestId,

            providerReference:
                normalized.providerReference,

            providerCostKobo:
                normalized.providerCostKobo,

            providerStatus:
                normalized.providerStatus,

            providerCode:
                normalized.providerCode,

            providerVariationId:
                normalized.variationId,

            message:
                normalized.message

        };

    }


    if (
        normalized.outcome ===
        "failure"
    ) {

        return {

            outcome:
                "failure",

            providerRequestId,

            providerReference:
                normalized.providerReference,

            providerCostKobo:
                normalized.providerCostKobo,

            providerStatus:
                normalized.providerStatus,

            providerCode:
                normalized.providerCode,

            providerVariationId:
                normalized.variationId,

            message:
                normalized.message ||
                "VTU.ng confirmed that the Data order failed."

        };

    }


    return {

        outcome:
            "unknown",

        providerRequestId,

        providerReference:
            normalized.providerReference,

        providerCostKobo:
            normalized.providerCostKobo,

        providerStatus:
            normalized.providerStatus,

        providerCode:
            normalized.providerCode,

        providerVariationId:
            normalized.variationId,

        message:
            normalized.message ||
            "VTU.ng is still processing the Data order."

    };

}


// =====================================================
// REQUERY DATA
// =====================================================
//
// Uses the EXACT SAME deterministic request ID generated
// from the original NovaPay transaction ID.
//
// This allows an uncertain Data order to be checked
// without creating a second provider order.
// =====================================================

async function requeryData(
    transactionId
) {

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );


    const providerRequestId =
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
                            providerRequestId

                    }

                }
            );

    }

    catch (error) {

        if (
            error instanceof
            VtuProviderError
        ) {

            throw error;

        }


        throw new VtuProviderError(
            "Unable to verify the VTU.ng Data order.",
            {
                kind:
                    "unknown"
            }
        );

    }


    const normalized =
        normalizeProviderResponse(
            result.data,
            result.response.status
        );


    return {

        outcome:
            normalized.outcome,

        providerRequestId,

        providerReference:
            normalized.providerReference,

        providerCostKobo:
            normalized.providerCostKobo,

        providerStatus:
            normalized.providerStatus,

        providerCode:
            normalized.providerCode,

        providerVariationId:
            normalized.variationId,

        message:
            normalized.message

    };

}


// =====================================================
// PROVIDER WALLET BALANCE
// =====================================================
//
// This is the VTU.ng reseller/provider wallet.
//
// It is NOT the NovaPay user's wallet.
//
// It must NEVER be used to determine whether the
// customer has enough money in NovaPay.
//
// =====================================================

async function getProviderBalance() {

    const result =
        await authenticatedRequest(
            "balance",
            {

                method:
                    "GET"

            }
        );


    const payload =
        result.data?.data &&
        typeof result.data.data ===
            "object"
            ? result.data.data
            : result.data;


    const balance =
        Number(
            payload?.balance
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
                    "unknown",

                httpStatus:
                    result.response.status
            }
        );

    }


    return {

        balanceNaira:
            balance,

        balanceKobo:
            Math.round(
                balance *
                100
            ),

        currency:
            String(
                payload?.currency ||
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

    purchaseData,

    requeryData,

    getProviderBalance,

    getAccessToken,

    clearAccessToken,

    createProviderRequestId,

    normalizeProviderStatus,

    normalizeProviderResponse,

    nairaToKobo,

    VtuProviderError

};