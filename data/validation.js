"use strict";

/**
 * NovaPay Data Validation
 *
 * Responsibility:
 * - Validate and normalize incoming Data purchase input.
 * - Reject malformed or unsafe values before they reach the service/provider.
 *
 * This file MUST NOT:
 * - modify wallets
 * - create transactions
 * - call providers
 * - calculate or modify profit
 * - trust client-supplied financial state
 */

const SUPPORTED_NETWORKS = Object.freeze([
    "mtn",
    "glo",
    "airtel",
    "9mobile"
]);

const MIN_AMOUNT_KOBO = 100; // ₦1.00
const MAX_AMOUNT_KOBO = 5_000_000; // ₦50,000.00

const MAX_PHONE_DIGITS = 11;

function createValidationError(message, field = null) {
    const error = new Error(message);
    error.code = "VALIDATION_ERROR";
    error.statusCode = 400;

    if (field) {
        error.field = field;
    }

    return error;
}

function normalizeString(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim();
}

function normalizeNetwork(value) {
    const network = normalizeString(value).toLowerCase();

    if (!SUPPORTED_NETWORKS.includes(network)) {
        throw createValidationError(
            "Unsupported network.",
            "network"
        );
    }

    return network;
}

function normalizePhoneNumber(value) {
    const raw = normalizeString(value);

    if (!raw) {
        throw createValidationError(
            "Phone number is required.",
            "phoneNumber"
        );
    }

    // Accept common Nigerian formats:
    // 08012345678
    // 8012345678
    // +2348012345678
    // 2348012345678
    let normalized = raw.replace(/[\s\-().]/g, "");

    if (normalized.startsWith("+234")) {
        normalized = `0${normalized.slice(4)}`;
    } else if (normalized.startsWith("234")) {
        normalized = `0${normalized.slice(3)}`;
    }

    if (!/^0\d{10}$/.test(normalized)) {
        throw createValidationError(
            "Enter a valid Nigerian phone number.",
            "phoneNumber"
        );
    }

    if (normalized.length !== MAX_PHONE_DIGITS) {
        throw createValidationError(
            "Enter a valid Nigerian phone number.",
            "phoneNumber"
        );
    }

    return normalized;
}

function parseAmountKobo(value) {
    let amountKobo;

    if (typeof value === "number") {
        amountKobo = value;
    } else if (
        typeof value === "string" &&
        /^\d+$/.test(value.trim())
    ) {
        amountKobo = Number(value.trim());
    } else {
        throw createValidationError(
            "Amount must be a valid integer in kobo.",
            "amountKobo"
        );
    }

    if (!Number.isSafeInteger(amountKobo)) {
        throw createValidationError(
            "Amount is outside the supported range.",
            "amountKobo"
        );
    }

    if (
        amountKobo < MIN_AMOUNT_KOBO ||
        amountKobo > MAX_AMOUNT_KOBO
    ) {
        throw createValidationError(
            "Amount is outside the supported Data purchase range.",
            "amountKobo"
        );
    }

    return amountKobo;
}

function normalizePlanId(value) {
    const planId = normalizeString(value);

    if (!planId) {
        throw createValidationError(
            "Data plan is required.",
            "planId"
        );
    }

    /*
     * Plan IDs are identifiers, not arbitrary user-generated text.
     *
     * Keep the accepted character set intentionally narrow so values
     * cannot contain unexpected control characters or excessive data.
     */
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(planId)) {
        throw createValidationError(
            "Invalid Data plan.",
            "planId"
        );
    }

    return planId;
}

function normalizeReference(value) {
    const reference = normalizeString(value);

    if (!reference) {
        return null;
    }

    if (reference.length > 150) {
        throw createValidationError(
            "Reference is too long.",
            "reference"
        );
    }

    /*
     * The reference is useful for idempotency when supplied by our
     * trusted client flow, but it is NEVER used as proof of payment
     * or proof of wallet ownership.
     */
    if (!/^[A-Za-z0-9._:-]+$/.test(reference)) {
        throw createValidationError(
            "Invalid reference.",
            "reference"
        );
    }

    return reference;
}

function validateCurrency(value) {
    if (value === undefined || value === null || value === "") {
        return "NGN";
    }

    const currency = normalizeString(value).toUpperCase();

    if (currency !== "NGN") {
        throw createValidationError(
            "Only NGN is supported.",
            "currency"
        );
    }

    return currency;
}

function validatePurchaseInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw createValidationError(
            "Invalid Data purchase request."
        );
    }

    const network = normalizeNetwork(input.network);
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    const planId = normalizePlanId(input.planId);
    const amountKobo = parseAmountKobo(input.amountKobo);
    const currency = validateCurrency(input.currency);
    const reference = normalizeReference(input.reference);

    return Object.freeze({
        network,
        phoneNumber,
        planId,
        amountKobo,
        currency,
        reference
    });
}

module.exports = Object.freeze({
    SUPPORTED_NETWORKS,
    MIN_AMOUNT_KOBO,
    MAX_AMOUNT_KOBO,
    createValidationError,
    normalizeNetwork,
    normalizePhoneNumber,
    parseAmountKobo,
    normalizePlanId,
    normalizeReference,
    validateCurrency,
    validatePurchaseInput
});