"use strict";

const crypto = require("crypto");


// =====================================================
// NOVAPAY — VTU.NG AIRTIME PROVIDER ADAPTER
// =====================================================
//
// RESPONSIBILITY
//
// This module is the ONLY Airtime layer that communicates
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
// - sends Airtime orders
// - requeries Airtime orders
// - normalizes provider responses
// - reports provider outcome to the Airtime service
//
// PROVIDER OUTCOMES:
//
// success
// failure
// unknown
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

function createProviderRequestId(
    transactionId
) {

    const normalized =
        requireTransactionId(
            transactionId
        );


    return (
        "NP" +
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
     * Refresh an expired/invalid token once.
     *
     * The provider request ID remains exactly the same.
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
// CONFIRMED SUCCESS:
//
// completed-api
//
// CONFIRMED FAILURE:
//
// failed
// refunded
// cancelled
//
// Everything else remains UNKNOWN.
//
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
// PROVIDER FAILURE CODE NORMALIZATION
// =====================================================
//
// Some VTU.ng failures are communicated through a
// provider error code rather than a status such as
// "failed".
//
// These are definite failures because the provider has
// explicitly rejected the Airtime operation.
//
// IMPORTANT:
//
// Only codes that represent a definite rejection/failure
// are listed here.
//
// Ambiguous errors are NOT included.
//
// =====================================================

function normalizeProviderCode(
    code
) {

    const normalized =
        String(
            code ||
            ""
        )
            .trim()
            .toLowerCase();


    if (
        normalized ===
            "insufficient_funds" ||
        normalized ===
            "insufficient-funds" ||
        normalized ===
            "insufficient balance" ||
        normalized ===
            "insufficient_balance" ||
        normalized ===
            "order_failed" ||
        normalized ===
            "order-failed" ||
        normalized ===
            "product_unavailable" ||
        normalized ===
            "product-unavailable"
    ) {

        return "failure";

    }


    return "unknown";

}


// =====================================================
// PROVIDER FAILURE MESSAGE NORMALIZATION
// =====================================================
//
// We use the provider message as supporting evidence.
//
// We do NOT classify every arbitrary message as failure.
// Only explicit failure phrases are accepted.
//
// =====================================================

function normalizeProviderMessageOutcome(
    message
) {

    const normalized =
        String(
            message ||
            ""
        )
            .trim()
            .toLowerCase();


    if (!normalized) {

        return "unknown";

    }


    const definiteFailurePatterns = [

        "insufficient wallet balance",

        "insufficient wallet funds",

        "insufficient funds",

        "insufficient balance",

        "wallet balance is insufficient",

        "order failed",

        "order has failed",

        "airtime order failed",

        "product unavailable",

        "product is unavailable",

        "transaction failed",

        "transaction has failed",

        "request failed",

        "request has failed",

        "cancelled",

        "canceled",

        "refunded"

    ];


    for (
        const pattern
        of definiteFailurePatterns
    ) {

        if (
            normalized.includes(
                pattern
            )
        ) {

            return "failure";

        }

    }


    return "unknown";

}


// =====================================================
// MONEY CONVERSION
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
// NORMALIZE PROVIDER RESPONSE
// =====================================================
//
// Decision priority:
//
// 1. Explicit provider status
// 2. Explicit provider failure code
// 3. Explicit definite failure message
// 4. Otherwise unknown
//
// This prevents an ordinary HTTP error or ambiguous
// provider response from accidentally becoming a refund.
//
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


    /*
     * -----------------------------------------------------
     * 1. EXPLICIT PROVIDER STATUS
     * -----------------------------------------------------
     */

    const statusOutcome =
        normalizeProviderStatus(
            providerStatus
        );


    if (
        statusOutcome ===
        "success"
    ) {

        return {

            outcome:
                "success",

            providerStatus,

            providerReference,

            providerCostKobo,

            providerCode,

            message,

            httpStatus

        };

    }


    if (
        statusOutcome ===
        "failure"
    ) {

        return {

            outcome:
                "failure",

            providerStatus,

            providerReference,

            providerCostKobo,

            providerCode,

            message,

            httpStatus

        };

    }


    /*
     * -----------------------------------------------------
     * 2. EXPLICIT PROVIDER ERROR CODE
     * -----------------------------------------------------
     */

    const codeOutcome =
        normalizeProviderCode(
            providerCode
        );


    if (
        codeOutcome ===
        "failure"
    ) {

        return {

            outcome:
                "failure",

            providerStatus:
                providerStatus ||
                null,

            providerReference,

            providerCostKobo,

            providerCode,

            message,

            httpStatus

        };

    }


    /*
     * -----------------------------------------------------
     * 3. DEFINITE FAILURE MESSAGE
     * -----------------------------------------------------
     */

    const messageOutcome =
        normalizeProviderMessageOutcome(
            message
        );


    if (
        messageOutcome ===
        "failure"
    ) {

        return {

            outcome:
                "failure",

            providerStatus:
                providerStatus ||
                null,

            providerReference,

            providerCostKobo,

            providerCode,

            message,

            httpStatus

        };

    }


    /*
     * -----------------------------------------------------
     * 4. UNKNOWN
     * -----------------------------------------------------
     *
     * HTTP errors, processing states, queued states,
     * malformed business responses, and other ambiguous
     * provider conditions remain UNKNOWN.
     */

    return {

        outcome:
            "unknown",

        providerStatus:
            providerStatus ||
            null,

        providerReference,

        providerCostKobo,

        providerCode,

        message,

        httpStatus

    };

}


// =====================================================
// VALIDATE AIRTIME PROVIDER INPUT
// =====================================================

function validatePurchaseInput({
    transactionId,
    network,
    phoneNumber,
    amountKobo
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
            "Airtime network is required.",
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
            "Airtime phone number is required.",
            {
                kind:
                    "validation"
            }
        );

    }


    const amount =
        Number(
            amountKobo
        );


    if (
        !Number.isSafeInteger(
            amount
        ) ||
        amount <= 0 ||
        amount %
            100 !==
            0
    ) {

        throw new VtuProviderError(
            "Airtime amount must be a valid whole-naira amount.",
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

        amountKobo:
            amount

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

    const input =
        validatePurchaseInput({

            transactionId,

            network,

            phoneNumber,

            amountKobo

        });


    const providerRequestId =
        createProviderRequestId(
            input.transactionId
        );


    const amountNaira =
        input.amountKobo /
        100;


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
                            providerRequestId,

                        phone:
                            input.phoneNumber,

                        service_id:
                            input.network,

                        amount:
                            amountNaira

                    }

                }
            );

    }

    catch (error) {

        /*
         * Network failures, timeouts, malformed responses,
         * authentication failures, and other thrown provider
         * errors are still UNKNOWN unless a definite provider
         * failure was explicitly supplied by the provider.
         */

        if (
            error instanceof
            VtuProviderError
        ) {

            throw error;

        }


        throw new VtuProviderError(
            "VTU.ng Airtime request could not be verified.",
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

            message:
                normalized.message ||
                "VTU.ng confirmed that the Airtime order failed."

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

        message:
            normalized.message ||
            "VTU.ng is still processing the Airtime order."

    };

}


// =====================================================
// REQUERY AIRTIME
// =====================================================

async function requeryAirtime(
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
            "Unable to verify the VTU.ng Airtime order.",
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

        message:
            normalized.message

    };

}


// =====================================================
// CHECK AIRTIME STATUS
// =====================================================
//
// Interface used by the Airtime reconciliation worker.
//
// It verifies the provider request ID and delegates to
// the existing deterministic requery implementation.
//
// =====================================================

async function checkAirtimeStatus({
    transactionId,
    providerRequestId = null
}) {

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );


    const expectedProviderRequestId =
        createProviderRequestId(
            normalizedTransactionId
        );


    if (
        providerRequestId !==
            null &&
        String(
            providerRequestId
        ).trim() !==
            expectedProviderRequestId
    ) {

        throw new VtuProviderError(
            "VTU.ng provider request ID does not match the NovaPay transaction.",
            {
                kind:
                    "validation"
            }
        );

    }


    return await requeryAirtime(
        normalizedTransactionId
    );

}


// =====================================================
// PROVIDER WALLET BALANCE
// =====================================================
//
// This is the VTU.ng reseller/provider wallet.
//
// It is NOT the NovaPay user's wallet.
//
// It must never be used to determine whether the user
// can purchase Airtime.
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

    purchaseAirtime,

    requeryAirtime,

    checkAirtimeStatus,

    getProviderBalance,

    getAccessToken,

    clearAccessToken,

    createProviderRequestId,

    normalizeProviderStatus,

    normalizeProviderResponse,

    nairaToKobo,

    VtuProviderError

};