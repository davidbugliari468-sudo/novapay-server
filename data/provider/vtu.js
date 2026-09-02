"use strict";

const crypto = require("crypto");

const VTU_BASE_URL =
    process.env.VTU_BASE_URL || "https://vtu.ng/wp-json";

const VTU_AUTH_URL =
    process.env.VTU_AUTH_URL ||
    `${VTU_BASE_URL}/jwt-auth/v1/token`;

const VTU_API_BASE_URL =
    process.env.VTU_API_BASE_URL ||
    `${VTU_BASE_URL}/api/v2`;

const VTU_USERNAME = process.env.VTU_USERNAME || "";
const VTU_PASSWORD = process.env.VTU_PASSWORD || "";

const REQUEST_TIMEOUT_MS = Number.parseInt(
    process.env.VTU_REQUEST_TIMEOUT_MS || "15000",
    10
);

const MAX_TRANSACTION_ID_LENGTH = 200;
const MAX_PROVIDER_REQUEST_ID_LENGTH = 50;

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

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

        this.name = "VtuProviderError";
        this.kind = kind;
        this.httpStatus = httpStatus;
        this.providerCode = providerCode;
        this.providerStatus = providerStatus;
        this.providerReference = providerReference;
        this.rawMessage = rawMessage;

        Error.captureStackTrace?.(this, VtuProviderError);
    }
}

function createProviderError(message, options = {}) {
    return new VtuProviderError(message, options);
}

function requireNonEmptyString(value, fieldName, maxLength) {
    if (typeof value !== "string") {
        throw createProviderError(
            `Invalid ${fieldName}.`,
            {
                kind: "validation"
            }
        );
    }

    const normalized = value.trim();

    if (!normalized) {
        throw createProviderError(
            `Invalid ${fieldName}.`,
            {
                kind: "validation"
            }
        );
    }

    if (normalized.length > maxLength) {
        throw createProviderError(
            `Invalid ${fieldName}.`,
            {
                kind: "validation"
            }
        );
    }

    return normalized;
}

function requireTransactionId(transactionId) {
    return requireNonEmptyString(
        transactionId,
        "transaction ID",
        MAX_TRANSACTION_ID_LENGTH
    );
}

function normalizePhoneNumber(phoneNumber) {
    if (typeof phoneNumber !== "string") {
        throw createProviderError(
            "Invalid phone number.",
            {
                kind: "validation"
            }
        );
    }

    const digits = phoneNumber.replace(/\D/g, "");

    if (digits.length === 11 && digits.startsWith("0")) {
        return digits;
    }

    if (digits.length === 10 && digits.startsWith("8")) {
        return `0${digits}`;
    }

    if (digits.length === 13 && digits.startsWith("234")) {
        return `0${digits.slice(3)}`;
    }

    if (digits.length === 12 && digits.startsWith("234")) {
        return `0${digits.slice(3)}`;
    }

    throw createProviderError(
        "Invalid phone number.",
        {
            kind: "validation"
        }
    );
}

function normalizeNetwork(network) {
    if (typeof network !== "string") {
        throw createProviderError(
            "Invalid network.",
            {
                kind: "validation"
            }
        );
    }

    const normalized = network.trim().toLowerCase();

    const supportedNetworks = new Set([
        "mtn",
        "airtel",
        "glo",
        "9mobile"
    ]);

    if (!supportedNetworks.has(normalized)) {
        throw createProviderError(
            "Unsupported network.",
            {
                kind: "validation"
            }
        );
    }

    return normalized;
}

function normalizeVariationId(variationId) {
    return requireNonEmptyString(
        variationId,
        "variation ID",
        150
    );
}

function createProviderRequestId(transactionId) {
    const normalizedTransactionId =
        requireTransactionId(transactionId);

    const digest = crypto
        .createHash("sha256")
        .update(normalizedTransactionId, "utf8")
        .digest("hex");

    const requestId = `ND${digest.slice(0, 46)}`;

    if (requestId.length > MAX_PROVIDER_REQUEST_ID_LENGTH) {
        throw createProviderError(
            "Unable to create provider request ID.",
            {
                kind: "validation"
            }
        );
    }

    return requestId;
}

function clearAccessToken() {
    cachedAccessToken = null;
    cachedAccessTokenExpiresAt = 0;
}

function getCachedAccessToken() {
    if (!cachedAccessToken) {
        return null;
    }

    if (
        Date.now() >=
        cachedAccessTokenExpiresAt
    ) {
        clearAccessToken();
        return null;
    }

    return cachedAccessToken;
}

function cacheAccessToken(token, expiresInSeconds = 3600) {
    const normalizedToken =
        requireNonEmptyString(
            token,
            "provider access token",
            10000
        );

    const numericExpiresIn =
        Number(expiresInSeconds);

    const safeExpiresIn =
        Number.isFinite(numericExpiresIn) &&
        numericExpiresIn > 0
            ? numericExpiresIn
            : 3600;

    const safetyWindowMs =
        Math.min(
            10 * 60 * 1000,
            Math.max(
                30 * 1000,
                safeExpiresIn * 1000 * 0.1
            )
        );

    cachedAccessToken = normalizedToken;

    cachedAccessTokenExpiresAt =
        Date.now() +
        Math.max(
            30 * 1000,
            safeExpiresIn * 1000 - safetyWindowMs
        );

    return cachedAccessToken;
}

async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = REQUEST_TIMEOUT_MS
) {
    const controller =
        new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        timeoutMs
    );

    try {
        return await fetch(
            url,
            {
                ...options,
                signal: controller.signal
            }
        );
    } catch (error) {
        if (error?.name === "AbortError") {
            throw createProviderError(
                "VTU request timed out.",
                {
                    kind: "timeout"
                }
            );
        }

        throw createProviderError(
            "Unable to reach VTU.",
            {
                kind: "network",
                rawMessage: error?.message || null
            }
        );
    } finally {
        clearTimeout(timeout);
    }
}

async function readJsonResponse(response) {
    const text = await response.text();

    if (!text) {
        throw createProviderError(
            "VTU returned an empty response.",
            {
                kind: "unknown",
                httpStatus: response.status
            }
        );
    }

    try {
        return JSON.parse(text);
    } catch {
        throw createProviderError(
            "VTU returned an invalid response.",
            {
                kind: "unknown",
                httpStatus: response.status,
                rawMessage: text.slice(0, 500)
            }
        );
    }
}

function getProviderMessage(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const candidates = [
        payload.message,
        payload.msg,
        payload.error,
        payload.detail
    ];

    for (const value of candidates) {
        if (
            typeof value === "string" &&
            value.trim()
        ) {
            return value.trim();
        }
    }

    return null;
}

function getProviderCode(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const candidates = [
        payload.code,
        payload.error_code,
        payload.status_code
    ];

    for (const value of candidates) {
        if (
            typeof value === "string" ||
            typeof value === "number"
        ) {
            return String(value);
        }
    }

    return null;
}

function getProviderStatus(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const candidates = [
        payload.status,
        payload.order_status,
        payload.transaction_status,
        payload.data?.status
    ];

    for (const value of candidates) {
        if (
            typeof value === "string" &&
            value.trim()
        ) {
            return value.trim().toLowerCase();
        }
    }

    return null;
}

function normalizeProviderStatus(status) {
    if (
        typeof status !== "string" ||
        !status.trim()
    ) {
        return "unknown";
    }

    const normalized =
        status
            .trim()
            .toLowerCase()
            .replace(/[_\s]+/g, "-");

    const successStatuses = new Set([
        "completed",
        "completed-api",
        "successful",
        "success",
        "processing-completed"
    ]);

    const failureStatuses = new Set([
        "failed",
        "failure",
        "refunded",
        "cancelled",
        "canceled",
        "reversed"
    ]);

    if (successStatuses.has(normalized)) {
        return "success";
    }

    if (failureStatuses.has(normalized)) {
        return "failure";
    }

    return "unknown";
}

function extractProviderReference(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const candidates = [
        payload.order_id,
        payload.reference,
        payload.transaction_id,
        payload.transaction_reference,
        payload.data?.order_id,
        payload.data?.reference,
        payload.data?.transaction_id
    ];

    for (const value of candidates) {
        if (
            typeof value === "string" ||
            typeof value === "number"
        ) {
            const normalized = String(value).trim();

            if (normalized) {
                return normalized.slice(0, 200);
            }
        }
    }

    return null;
}

function extractProviderCostKobo(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const candidates = [
        payload.amount_charged,
        payload.data?.amount_charged
    ];

    for (const value of candidates) {
        const parsed = nairaToKobo(value);

        if (parsed !== null) {
            return parsed;
        }
    }

    return null;
}

function extractReturnedVariationId(payload) {
    if (!payload || typeof payload !== "object") {
        return null;
    }

    const candidates = [
        payload.variation_id,
        payload.variation,
        payload.data?.variation_id,
        payload.data?.variation
    ];

    for (const value of candidates) {
        if (
            typeof value === "string" ||
            typeof value === "number"
        ) {
            const normalized = String(value).trim();

            if (normalized) {
                return normalized;
            }
        }
    }

    return null;
}

function nairaToKobo(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    let numeric;

    if (typeof value === "number") {
        numeric = value;
    } else if (typeof value === "string") {
        const cleaned = value
            .replace(/₦/g, "")
            .replace(/,/g, "")
            .trim();

        numeric = Number(cleaned);
    } else {
        return null;
    }

    if (
        !Number.isFinite(numeric) ||
        numeric < 0
    ) {
        return null;
    }

    const kobo = Math.round(
        numeric * 100
    );

    if (!Number.isSafeInteger(kobo)) {
        return null;
    }

    return kobo;
}

function normalizeProviderResponse(
    payload,
    {
        requestedVariationId = null,
        httpStatus = null,
        requestId = null
    } = {}
) {
    const rawStatus =
        getProviderStatus(payload);

    const outcome =
        normalizeProviderStatus(
            rawStatus
        );

    const providerReference =
        extractProviderReference(payload);

    const providerCostKobo =
        extractProviderCostKobo(payload);

    const returnedVariationId =
        extractReturnedVariationId(payload);

    return {
        outcome,
        providerStatus: rawStatus,
        providerReference,
        providerCostKobo,
        providerCode: getProviderCode(payload),
        message: getProviderMessage(payload),
        requestedVariationId,
        returnedVariationId,
        requestId,
        httpStatus,
        raw: payload
    };
}

async function getAccessToken() {
    const cached =
        getCachedAccessToken();

    if (cached) {
        return cached;
    }

    if (
        !VTU_USERNAME ||
        !VTU_PASSWORD
    ) {
        throw createProviderError(
            "VTU credentials are not configured.",
            {
                kind: "configuration"
            }
        );
    }

    const response =
        await fetchWithTimeout(
            VTU_AUTH_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    Accept:
                        "application/json"
                },
                body: JSON.stringify({
                    username: VTU_USERNAME,
                    password: VTU_PASSWORD
                })
            }
        );

    const payload =
        await readJsonResponse(
            response
        );

    if (!response.ok) {
        throw createProviderError(
            "VTU authentication failed.",
            {
                kind:
                    response.status >= 500
                        ? "provider"
                        : "authentication",
                httpStatus: response.status,
                providerCode:
                    getProviderCode(payload),
                providerStatus:
                    getProviderStatus(payload),
                rawMessage:
                    getProviderMessage(payload)
            }
        );
    }

    const token =
        payload?.token ||
        payload?.access_token;

    if (
        typeof token !== "string" ||
        !token.trim()
    ) {
        throw createProviderError(
            "VTU authentication returned no access token.",
            {
                kind: "authentication",
                httpStatus: response.status
            }
        );
    }

    const expiresIn =
        payload?.expires_in ||
        payload?.expires ||
        3600;

    return cacheAccessToken(
        token,
        expiresIn
    );
}

async function authenticatedRequest(
    path,
    {
        method = "POST",
        body = null,
        retryAuthentication = true
    } = {}
) {
    let accessToken =
        await getAccessToken();

    const url =
        `${VTU_API_BASE_URL}${path}`;

    const makeRequest =
        async token => {
            const headers = {
                Accept:
                    "application/json",
                Authorization:
                    `Bearer ${token}`
            };

            if (body !== null) {
                headers["Content-Type"] =
                    "application/json";
            }

            return fetchWithTimeout(
                url,
                {
                    method,
                    headers,
                    body:
                        body === null
                            ? undefined
                            : JSON.stringify(body)
                }
            );
        };

    let response =
        await makeRequest(
            accessToken
        );

    if (
        (response.status === 401 ||
            response.status === 403) &&
        retryAuthentication
    ) {
        clearAccessToken();

        accessToken =
            await getAccessToken();

        response =
            await makeRequest(
                accessToken
            );
    }

    return response;
}

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
        normalizeNetwork(
            network
        );

    const normalizedPhoneNumber =
        normalizePhoneNumber(
            phoneNumber
        );

    const normalizedVariationId =
        normalizeVariationId(
            variationId
        );

    return {
        transactionId:
            normalizedTransactionId,
        network:
            normalizedNetwork,
        phoneNumber:
            normalizedPhoneNumber,
        variationId:
            normalizedVariationId
    };
}

function assertVariationIdentity(
    response,
    requestedVariationId
) {
    if (
        !response ||
        !response.returnedVariationId
    ) {
        return;
    }

    if (
        response.returnedVariationId !==
        requestedVariationId
    ) {
        throw createProviderError(
            "VTU returned a different data variation.",
            {
                kind: "provider",
                httpStatus:
                    response.httpStatus,
                providerCode:
                    response.providerCode,
                providerStatus:
                    response.providerStatus,
                providerReference:
                    response.providerReference,
                rawMessage:
                    "Provider variation mismatch."
            }
        );
    }
}

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

    const requestId =
        createProviderRequestId(
            input.transactionId
        );

    const response =
        await authenticatedRequest(
            "/data",
            {
                method: "POST",
                body: {
                    request_id:
                        requestId,
                    phone:
                        input.phoneNumber,
                    service_id:
                        input.network,
                    variation_id:
                        input.variationId
                }
            }
        );

    const payload =
        await readJsonResponse(
            response
        );

    if (
        response.status === 401 ||
        response.status === 403
    ) {
        throw createProviderError(
            "VTU authentication was rejected.",
            {
                kind: "authentication",
                httpStatus:
                    response.status,
                providerCode:
                    getProviderCode(payload),
                providerStatus:
                    getProviderStatus(payload),
                rawMessage:
                    getProviderMessage(payload)
            }
        );
    }

    if (!response.ok) {
        const providerStatus =
            getProviderStatus(payload);

        const normalizedStatus =
            normalizeProviderStatus(
                providerStatus
            );

        if (
            normalizedStatus ===
            "failure"
        ) {
            return normalizeProviderResponse(
                payload,
                {
                    requestedVariationId:
                        input.variationId,
                    httpStatus:
                        response.status,
                    requestId
                }
            );
        }

        throw createProviderError(
            "VTU rejected the data request.",
            {
                kind:
                    response.status >= 500
                        ? "provider"
                        : "rejected",
                httpStatus:
                    response.status,
                providerCode:
                    getProviderCode(payload),
                providerStatus,
                rawMessage:
                    getProviderMessage(payload)
            }
        );
    }

    const normalized =
        normalizeProviderResponse(
            payload,
            {
                requestedVariationId:
                    input.variationId,
                httpStatus:
                    response.status,
                requestId
            }
        );

    assertVariationIdentity(
        normalized,
        input.variationId
    );

    return normalized;
}

async function requeryData({
    transactionId
}) {
    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const requestId =
        createProviderRequestId(
            normalizedTransactionId
        );

    const response =
        await authenticatedRequest(
            "/requery",
            {
                method: "POST",
                body: {
                    request_id:
                        requestId
                }
            }
        );

    const payload =
        await readJsonResponse(
            response
        );

    if (
        response.status === 401 ||
        response.status === 403
    ) {
        throw createProviderError(
            "VTU authentication was rejected.",
            {
                kind: "authentication",
                httpStatus:
                    response.status,
                providerCode:
                    getProviderCode(payload),
                providerStatus:
                    getProviderStatus(payload),
                rawMessage:
                    getProviderMessage(payload)
            }
        );
    }

    if (!response.ok) {
        const normalizedStatus =
            normalizeProviderStatus(
                getProviderStatus(payload)
            );

        if (
            normalizedStatus ===
            "failure"
        ) {
            return normalizeProviderResponse(
                payload,
                {
                    httpStatus:
                        response.status,
                    requestId
                }
            );
        }

        throw createProviderError(
            "VTU requery failed.",
            {
                kind:
                    response.status >= 500
                        ? "provider"
                        : "rejected",
                httpStatus:
                    response.status,
                providerCode:
                    getProviderCode(payload),
                providerStatus:
                    getProviderStatus(payload),
                rawMessage:
                    getProviderMessage(payload)
            }
        );
    }

    return normalizeProviderResponse(
        payload,
        {
            httpStatus:
                response.status,
            requestId
        }
    );
}

async function getProviderBalance() {
    const response =
        await authenticatedRequest(
            "/balance",
            {
                method: "GET"
            }
        );

    const payload =
        await readJsonResponse(
            response
        );

    if (!response.ok) {
        throw createProviderError(
            "Unable to retrieve VTU balance.",
            {
                kind:
                    response.status >= 500
                        ? "provider"
                        : "rejected",
                httpStatus:
                    response.status,
                providerCode:
                    getProviderCode(payload),
                providerStatus:
                    getProviderStatus(payload),
                rawMessage:
                    getProviderMessage(payload)
            }
        );
    }

    const rawBalance =
        payload?.balance ??
        payload?.data?.balance ??
        payload?.wallet_balance ??
        payload?.data?.wallet_balance;

    const balanceKobo =
        nairaToKobo(
            rawBalance
        );

    if (balanceKobo === null) {
        throw createProviderError(
            "VTU returned an invalid balance.",
            {
                kind: "unknown",
                httpStatus:
                    response.status
            }
        );
    }

    return {
        balanceKobo,
        balanceNaira:
            balanceKobo / 100
    };
}

module.exports = {
    VtuProviderError,
    purchaseData,
    requeryData,
    getProviderBalance,
    getAccessToken,
    clearAccessToken,
    createProviderRequestId,
    normalizeProviderStatus,
    normalizeProviderResponse,
    nairaToKobo
};