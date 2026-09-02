"use strict";


// =====================================================
// NOVAPAY — AIRTIME REQUEST VALIDATION
// =====================================================
//
// RESPONSIBILITY
//
// This module validates and normalizes Airtime requests.
//
// It is deliberately independent from:
//
// - Firestore
// - wallet balances
// - wallet reservations
// - VTU.ng
// - transaction creation
// - authentication
//
// The service layer will receive only validated values.
//
// FLOW:
//
// HTTP request
//     ↓
// validation.js
//     ↓
// normalized Airtime request
//     ↓
// airtime/service.js
//
// =====================================================


// =====================================================
// SUPPORTED NETWORKS
// =====================================================
//
// These are the network identifiers NovaPay sends to
// the provider adapter.
//
// Keep provider-specific HTTP details OUT of this file.
//
// =====================================================

const SUPPORTED_NETWORKS =
    new Set([
        "mtn",
        "glo",
        "airtel",
        "9mobile"
    ]);


// =====================================================
// DEFAULT LIMITS
// =====================================================
//
// Amounts are represented internally in kobo.
//
// Defaults:
//
// minimum = ₦50
// maximum = ₦50,000
//
// Environment variables may override these limits.
//
// =====================================================

const DEFAULT_MIN_AMOUNT_KOBO =
    5000;

const DEFAULT_MAX_AMOUNT_KOBO =
    5000000;


function getConfiguredAmountLimit(
    environmentName,
    fallback
) {

    const configured =
        Number(
            process.env[
                environmentName
            ]
        );


    if (
        Number.isSafeInteger(
            configured
        ) &&
        configured > 0
    ) {

        return configured;

    }


    return fallback;

}


const MIN_AIRTIME_AMOUNT_KOBO =
    getConfiguredAmountLimit(
        "MIN_AIRTIME_AMOUNT_KOBO",
        DEFAULT_MIN_AMOUNT_KOBO
    );


const MAX_AIRTIME_AMOUNT_KOBO =
    getConfiguredAmountLimit(
        "MAX_AIRTIME_AMOUNT_KOBO",
        DEFAULT_MAX_AMOUNT_KOBO
    );


// =====================================================
// BASIC ERROR FACTORY
// =====================================================

function createValidationError(
    message
) {

    const error =
        new Error(
            message
        );

    error.statusCode =
        400;

    error.code =
        "INVALID_AIRTIME_REQUEST";

    return error;

}


// =====================================================
// NORMALIZE NETWORK
// =====================================================

function normalizeNetwork(
    network
) {

    const normalized =
        String(
            network ?? ""
        )
            .trim()
            .toLowerCase();


    if (!normalized) {

        throw createValidationError(
            "Airtime network is required."
        );

    }


    if (
        !SUPPORTED_NETWORKS.has(
            normalized
        )
    ) {

        throw createValidationError(
            "Unsupported Airtime network."
        );

    }


    return normalized;

}


// =====================================================
// NORMALIZE PHONE NUMBER
// =====================================================
//
// Accepted examples:
//
// 08012345678
// 08123456789
// 09012345678
// 09112345678
//
// Also accepts:
//
// +2348012345678
// 2348012345678
//
// Everything is normalized to:
//
// 08012345678
//
// This prevents different representations of the same
// Nigerian number from reaching the business layer.
//
// =====================================================

function normalizePhoneNumber(
    phoneNumber
) {

    const raw =
        String(
            phoneNumber ?? ""
        ).trim();


    if (!raw) {

        throw createValidationError(
            "Airtime phone number is required."
        );

    }


    /*
     * Remove harmless formatting characters.
     *
     * We intentionally do NOT blindly remove arbitrary
     * characters because malformed input should be rejected.
     */

    const cleaned =
        raw.replace(
            /[\s()-]/g,
            ""
        );


    let normalized =
        cleaned;


    /*
     * +234XXXXXXXXXX
     */

    if (
        normalized.startsWith(
            "+234"
        )
    ) {

        normalized =
            "0" +
            normalized.slice(
                4
            );

    }

    /*
     * 234XXXXXXXXXX
     */

    else if (
        normalized.startsWith(
            "234"
        )
    ) {

        normalized =
            "0" +
            normalized.slice(
                3
            );

    }


    /*
     * Nigerian local format:
     *
     * 0 + 10 digits
     */

    if (
        !/^0\d{10}$/.test(
            normalized
        )
    ) {

        throw createValidationError(
            "Enter a valid Nigerian Airtime phone number."
        );

    }


    /*
     * Nigerian mobile numbers currently use mobile
     * prefixes beginning with 070–079, 080–089,
     * 090–099 and 081–091 ranges.
     *
     * This deliberately validates the structure rather
     * than trying to determine the subscriber's actual
     * network from the number.
     *
     * The selected network remains a separate request
     * field.
     *
     * IMPORTANT:
     *
     * The prefix is exactly 3 digits. The previous version
     * extracted 4 digits and therefore caused valid numbers
     * such as 08012345678 to fail the prefix validation.
     */

    const prefix =
        normalized.slice(
            0,
            3
        );


    const validMobilePrefix =
        /^(070|071|080|081|090|091|082|083|084|085|086|087|088|089|092|093|094|095|096|097|098|099)$/
            .test(
                prefix
            );


    if (
        !validMobilePrefix
    ) {

        throw createValidationError(
            "Enter a valid Nigerian phone number."
        );

    }


    return normalized;

}


// =====================================================
// PARSE WHOLE NAIRA AMOUNT
// =====================================================
//
// Public API requests use whole naira.
//
// Examples:
//
// "100"   → 10000 kobo
// 100     → 10000 kobo
// "100.00" is accepted
//
// Decimal fractions of a naira are rejected.
//
// We do not use floating point arithmetic for the final
// financial value.
//
// =====================================================

function parseAmountKobo(
    amount
) {

    if (
        typeof amount ===
        "number"
    ) {

        if (
            !Number.isSafeInteger(
                amount
            ) ||
            amount <= 0
        ) {

            throw createValidationError(
                "Invalid Airtime amount."
            );

        }


        return amount * 100;

    }


    const text =
        String(
            amount ?? ""
        ).trim();


    if (!text) {

        throw createValidationError(
            "Invalid Airtime amount."
        );

    }


    /*
     * Whole naira or exactly .00.
     */

    if (
        !/^\d+(?:\.00)?$/.test(
            text
        )
    ) {

        throw createValidationError(
            "Airtime amount must be a valid whole-naira amount."
        );

    }


    const nairaText =
        text.endsWith(
            ".00"
        )
            ? text.slice(
                0,
                -3
            )
            : text;


    const naira =
        Number(
            nairaText
        );


    if (
        !Number.isSafeInteger(
            naira
        ) ||
        naira <= 0
    ) {

        throw createValidationError(
            "Invalid Airtime amount."
        );

    }


    const amountKobo =
        naira * 100;


    if (
        !Number.isSafeInteger(
            amountKobo
        )
    ) {

        throw createValidationError(
            "Invalid Airtime amount."
        );

    }


    return amountKobo;

}


// =====================================================
// VALIDATE AMOUNT LIMITS
// =====================================================

function validateAmountLimits(
    amountKobo
) {

    if (
        amountKobo <
        MIN_AIRTIME_AMOUNT_KOBO
    ) {

        throw createValidationError(
            `Minimum Airtime amount is ₦${MIN_AIRTIME_AMOUNT_KOBO / 100}.`
        );

    }


    if (
        amountKobo >
        MAX_AIRTIME_AMOUNT_KOBO
    ) {

        throw createValidationError(
            `Maximum Airtime amount is ₦${MAX_AIRTIME_AMOUNT_KOBO / 100}.`
        );

    }


    return amountKobo;

}


// =====================================================
// VALIDATE REQUEST OBJECT
// =====================================================

function validateRequestObject(
    request
) {

    if (
        !request ||
        typeof request !==
        "object" ||
        Array.isArray(request)
    ) {

        throw createValidationError(
            "Airtime request is required."
        );

    }


    return request;

}


// =====================================================
// PUBLIC VALIDATOR
// =====================================================
//
// Input:
//
// {
//     phoneNumber: "08012345678",
//     network: "mtn",
//     amount: "100"
// }
//
// Output:
//
// {
//     phoneNumber: "08012345678",
//     network: "mtn",
//     amountKobo: 10000
// }
//
// =====================================================

function validateAirtimeRequest(
    request
) {

    const body =
        validateRequestObject(
            request
        );


    const network =
        normalizeNetwork(
            body.network
        );


    const phoneNumber =
        normalizePhoneNumber(
            body.phoneNumber
        );


    const amountKobo =
        parseAmountKobo(
            body.amount
        );


    validateAmountLimits(
        amountKobo
    );


    return {

        network,

        phoneNumber,

        amountKobo

    };

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    validateAirtimeRequest,

    normalizeNetwork,

    normalizePhoneNumber,

    parseAmountKobo,

    validateAmountLimits,

    SUPPORTED_NETWORKS,

    MIN_AIRTIME_AMOUNT_KOBO,

    MAX_AIRTIME_AMOUNT_KOBO

};