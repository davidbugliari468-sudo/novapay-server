"use strict";

/**
 * NovaPay Data Validation
 *
 * Responsibility:
 * - Validate and normalize customer-supplied Data purchase input.
 * - Validate identifiers and basic request structure.
 * - Normalize Nigerian phone numbers.
 * - Validate currency.
 *
 * IMPORTANT:
 * - This module does NOT determine Data plan price.
 * - This module does NOT determine provider cost.
 * - This module does NOT determine Data amount.
 * - This module does NOT determine validity.
 * - This module does NOT determine availability.
 * - This module does NOT determine the provider variation.
 *
 * Those values belong to the authoritative backend catalog
 * and provider layers.
 *
 * Purchase authority:
 *
 *     client input
 *          ↓
 *     validation
 *          ↓
 *     authoritative catalog
 *          ↓
 *     exact NovaPay product
 *          ↓
 *     exact VTU variation
 */


// =====================================================
// CONSTANTS
// =====================================================

const SUPPORTED_NETWORKS = Object.freeze([
    "mtn",
    "airtel",
    "glo",
    "9mobile"
]);

const SUPPORTED_CURRENCY =
    "NGN";

const MAX_PHONE_DIGITS =
    11;

const MAX_PLAN_ID_LENGTH =
    150;

const MAX_REFERENCE_LENGTH =
    150;


// =====================================================
// ERROR HELPER
// =====================================================

function createValidationError(
    message,
    code = "INVALID_DATA_REQUEST"
) {

    const error =
        new Error(
            message
        );

    error.statusCode =
        400;

    error.code =
        code;

    return error;

}


// =====================================================
// STRING NORMALIZATION
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
//
// Network is accepted only as request context.
//
// The authoritative plan lookup must still verify that
// the selected plan actually belongs to the requested
// network.
//
// =====================================================

function normalizeNetwork(
    value
) {

    const network =
        normalizeString(
            value
        ).toLowerCase();

    if (
        !network
    ) {

        throw createValidationError(
            "Data network is required.",
            "DATA_NETWORK_REQUIRED"
        );

    }

    if (
        !SUPPORTED_NETWORKS.includes(
            network
        )
    ) {

        throw createValidationError(
            "Unsupported Data network.",
            "UNSUPPORTED_DATA_NETWORK"
        );

    }

    return network;

}


// =====================================================
// PHONE NUMBER
// =====================================================
//
// Accepted examples:
//
//     08012345678
//     8012345678
//     +2348012345678
//     2348012345678
//
// Normalized output:
//
//     08012345678
//
// Separators such as spaces, hyphens, dots and parentheses
// are removed.
//
// The provider layer will perform any additional provider-
// specific validation required before fulfillment.
// =====================================================

function normalizePhoneNumber(
    value
) {

    let phone =
        normalizeString(
            value
        );

    if (
        !phone
    ) {

        throw createValidationError(
            "Data phone number is required.",
            "DATA_PHONE_REQUIRED"
        );

    }

    /*
     * Remove common formatting characters.
     *
     * We deliberately do not remove arbitrary characters.
     * After these known separators are removed, anything
     * else must still result in a numeric phone number.
     */

    phone =
        phone.replace(
            /[\s().-]/g,
            ""
        );

    /*
     * Convert international Nigerian format to the local
     * 11-digit format used throughout NovaPay.
     */

    if (
        phone.startsWith(
            "+234"
        )
    ) {

        phone =
            "0" +
            phone.slice(
                4
            );

    } else if (
        phone.startsWith(
            "234"
        )
    ) {

        phone =
            "0" +
            phone.slice(
                3
            );

    } else if (
        phone.startsWith(
            "80"
        ) &&
        phone.length ===
        10
    ) {

        phone =
            "0" +
            phone;

    }

    /*
     * Nigerian local mobile numbers must contain exactly
     * 11 digits after normalization.
     */

    if (
        !/^\d+$/.test(
            phone
        ) ||
        phone.length !==
        MAX_PHONE_DIGITS
    ) {

        throw createValidationError(
            "Enter a valid Nigerian phone number.",
            "INVALID_DATA_PHONE"
        );

    }

    /*
     * Local Nigerian mobile numbers begin with 0 followed
     * by a valid Nigerian mobile-network prefix.
     *
     * The network-specific provider validation remains in
     * the provider/catalog layer because the actual product
     * selected by the customer determines the network.
     */

    if (
        !/^0[789]\d{9}$/.test(
            phone
        )
    ) {

        throw createValidationError(
            "Enter a valid Nigerian phone number.",
            "INVALID_DATA_PHONE"
        );

    }

    return phone;

}


// =====================================================
// PLAN ID
// =====================================================
//
// The plan ID identifies the product the customer selected.
//
// IMPORTANT:
//
// The client supplies identity only.
//
// The backend later resolves this ID to:
//
//     NovaPay product
//     ↓
//     exact provider variation
//     ↓
//     authoritative price
//     ↓
//     authoritative data amount
//     ↓
//     authoritative validity
//
// No price or product attributes are trusted from the
// client.
// =====================================================

function normalizePlanId(
    value
) {

    const planId =
        normalizeString(
            value
        );

    if (
        !planId
    ) {

        throw createValidationError(
            "Data plan is required.",
            "DATA_PLAN_REQUIRED"
        );

    }

    if (
        planId.length >
        MAX_PLAN_ID_LENGTH
    ) {

        throw createValidationError(
            "Data plan ID is too long.",
            "INVALID_DATA_PLAN_ID"
        );

    }

    /*
     * Restrict plan IDs to a predictable identifier format.
     *
     * Allowed:
     *
     *     letters
     *     numbers
     *     dot
     *     underscore
     *     colon
     *     hyphen
     *
     * This prevents arbitrary strings from becoming
     * backend product identifiers.
     */

    if (
        !/^[A-Za-z0-9._:-]+$/.test(
            planId
        )
    ) {

        throw createValidationError(
            "Invalid Data plan ID.",
            "INVALID_DATA_PLAN_ID"
        );

    }

    return planId;

}


// =====================================================
// CLIENT REFERENCE
// =====================================================
//
// A client reference can be used as an idempotency/correlation
// value.
//
// It is NOT:
//
//     - a payment proof
//     - a transaction ID
//     - a wallet authorization
//     - a provider request ID
//
// NovaPay creates the authoritative transaction ID itself.
// =====================================================

function normalizeReference(
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

    const reference =
        normalizeString(
            value
        );

    if (
        !reference
    ) {

        return null;

    }

    if (
        reference.length >
        MAX_REFERENCE_LENGTH
    ) {

        throw createValidationError(
            "Data purchase reference is too long.",
            "INVALID_REFERENCE"
        );

    }

    if (
        !/^[A-Za-z0-9._:-]+$/.test(
            reference
        )
    ) {

        throw createValidationError(
            "Invalid Data purchase reference.",
            "INVALID_REFERENCE"
        );

    }

    return reference;

}


// =====================================================
// CURRENCY
// =====================================================
//
// NovaPay Data wallet accounting currently operates in NGN.
// The client cannot select another currency.
// =====================================================

function validateCurrency(
    value
) {

    const currency =
        normalizeString(
            value
        ).toUpperCase();

    /*
     * Currency may be omitted by the client because NGN is
     * the only supported Data purchase currency.
     */

    if (
        !currency
    ) {

        return SUPPORTED_CURRENCY;

    }

    if (
        currency !==
        SUPPORTED_CURRENCY
    ) {

        throw createValidationError(
            "Unsupported currency.",
            "UNSUPPORTED_CURRENCY"
        );

    }

    return SUPPORTED_CURRENCY;

}


// =====================================================
// PURCHASE INPUT
// =====================================================
//
// Final customer input contract:
//
//     {
//         network,
//         phoneNumber,
//         planId,
//         currency,
//         reference
//     }
//
// `amountKobo` is deliberately NOT accepted as an
// authoritative purchase field.
//
// The backend catalog determines the customer price.
// =====================================================

function validatePurchaseInput({
    network,
    phoneNumber,
    planId,
    currency,
    reference
} = {}) {

    const normalizedNetwork =
        normalizeNetwork(
            network
        );

    const normalizedPhoneNumber =
        normalizePhoneNumber(
            phoneNumber
        );

    const normalizedPlanId =
        normalizePlanId(
            planId
        );

    const normalizedCurrency =
        validateCurrency(
            currency
        );

    const normalizedReference =
        normalizeReference(
            reference
        );

    return Object.freeze({

        network:
            normalizedNetwork,

        phoneNumber:
            normalizedPhoneNumber,

        planId:
            normalizedPlanId,

        currency:
            normalizedCurrency,

        reference:
            normalizedReference

    });

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = Object.freeze({

    SUPPORTED_NETWORKS,

    SUPPORTED_CURRENCY,

    MAX_PHONE_DIGITS,

    MAX_PLAN_ID_LENGTH,

    MAX_REFERENCE_LENGTH,

    createValidationError,

    normalizeString,

    normalizeNetwork,

    normalizePhoneNumber,

    normalizePlanId,

    normalizeReference,

    validateCurrency,

    validatePurchaseInput

});