// airtime/validation.js

// =====================================================
// NOVAPAY — AIRTIME VALIDATION
// =====================================================
//
// Purpose:
//
// This module validates and normalizes all Airtime
// purchase input before it reaches the transaction
// service or VTU provider.
//
// IMPORTANT:
//
// - Frontend input is never trusted.
// - Amounts are converted to kobo here.
// - Phone numbers are normalized to Nigerian format.
// - Networks are normalized to canonical internal names.
// - No wallet logic belongs in this file.
// - No provider logic belongs in this file.
//
// Canonical networks:
//
//   mtn
//   glo
//   airtel
//   9mobile
//
// Canonical phone format:
//
//   08012345678
//
// Canonical money format:
//
//   integer kobo
//
// Example:
//
//   "100"     → 10000
//   "100.50"  → 10050
//
// =====================================================


// =====================================================
// CONSTANTS
// =====================================================

const MIN_AIRTIME_NAIRA = 50;

const MAX_AIRTIME_NAIRA = 50000;

const MIN_AIRTIME_KOBO =
    MIN_AIRTIME_NAIRA * 100;

const MAX_AIRTIME_KOBO =
    MAX_AIRTIME_NAIRA * 100;


// =====================================================
// SUPPORTED NETWORKS
// =====================================================
//
// These are NovaPay's internal canonical names.
//
// Provider-specific network IDs must NOT be placed
// here. Those belong in the VTU provider adapter.
// =====================================================

const SUPPORTED_NETWORKS =
    Object.freeze([
        "mtn",
        "glo",
        "airtel",
        "9mobile"
    ]);


// =====================================================
// NETWORK ALIASES
// =====================================================
//
// Multiple frontend/provider naming conventions can map
// into one canonical NovaPay network name.
//
// IMPORTANT:
//
// The lookup keys are already normalized to lowercase.
// =====================================================

const NETWORK_ALIASES =
    Object.freeze({

        mtn:
            "mtn",

        "mtn-ng":
            "mtn",

        glo:
            "glo",

        "glo-ng":
            "glo",

        airtel:
            "airtel",

        "airtel-ng":
            "airtel",

        "9mobile":
            "9mobile",

        "9mobile-ng":
            "9mobile",

        etisalat:
            "9mobile",

        "etisalat-ng":
            "9mobile"

    });


// =====================================================
// NORMALIZE NETWORK
// =====================================================

function normalizeNetwork(value) {

    const network =
        String(
            value ?? ""
        )
            .trim()
            .toLowerCase();


    if (!network) {

        return "";

    }


    return (
        NETWORK_ALIASES[network] ||
        network
    );

}


// =====================================================
// VALIDATE NETWORK
// =====================================================

function validateNetwork(value) {

    const network =
        normalizeNetwork(value);


    if (
        !SUPPORTED_NETWORKS.includes(
            network
        )
    ) {

        throw new Error(
            "Unsupported Airtime network."
        );

    }


    return network;

}


// =====================================================
// NORMALIZE PHONE NUMBER
// =====================================================
//
// Accepted:
//
//   08012345678
//   07012345678
//   08112345678
//   +2348012345678
//   2348012345678
//
// Internal result:
//
//   08012345678
//
// Spaces, brackets and hyphens are removed.
// =====================================================

function normalizePhoneNumber(value) {

    let phone =
        String(
            value ?? ""
        )
            .trim()
            .replace(
                /[\s()-]/g,
                ""
            );


    if (!phone) {

        return "";

    }


    // ---------------------------------------------
    // INTERNATIONAL NIGERIAN FORMAT
    // +2348012345678
    // ---------------------------------------------

    if (
        phone.startsWith("+234")
    ) {

        phone =
            "0" +
            phone.slice(4);

    }


    // ---------------------------------------------
    // INTERNATIONAL NIGERIAN FORMAT WITHOUT +
    // 2348012345678
    // ---------------------------------------------

    else if (
        phone.startsWith("234") &&
        phone.length === 13
    ) {

        phone =
            "0" +
            phone.slice(3);

    }


    return phone;

}


// =====================================================
// VALIDATE PHONE NUMBER
// =====================================================
//
// Nigerian mobile numbers:
//
//   070xxxxxxxx
//   080xxxxxxxx
//   081xxxxxxxx
//   090xxxxxxxx
//   091xxxxxxxx
//
// The second digit after the leading 0 must be one
// of 7, 8 or 9.
//
// The third digit must be 0 or 1.
//
// Total length = 11 digits.
// =====================================================

function validatePhoneNumber(value) {

    const phone =
        normalizePhoneNumber(value);


    if (
        !/^0[789][01]\d{8}$/.test(
            phone
        )
    ) {

        throw new Error(
            "Enter a valid Nigerian Airtime phone number."
        );

    }


    return phone;

}


// =====================================================
// NAIRA → KOBO
// =====================================================
//
// We intentionally parse the decimal string instead of
// relying on floating-point multiplication.
//
// Good:
//
//   "100"       → 10000
//   "100.5"     → 10050
//   "100.50"    → 10050
//   "50.01"     → 5001
//
// Invalid:
//
//   "100.123"
//   "₦100"
//   "1,000"
//   "-100"
//   "abc"
//   ""
//
// =====================================================

function nairaToKobo(amountNaira) {

    const normalized =
        String(
            amountNaira ?? ""
        )
            .trim();


    if (
        !/^\d+(\.\d{1,2})?$/.test(
            normalized
        )
    ) {

        throw new Error(
            "Invalid Airtime amount."
        );

    }


    const parts =
        normalized.split(".");


    const nairaPart =
        parts[0];


    const decimalPart =
        parts[1] || "";


    const naira =
        Number(
            nairaPart
        );


    if (
        !Number.isSafeInteger(
            naira
        )
    ) {

        throw new Error(
            "Airtime amount is too large."
        );

    }


    const koboPart =
        Number(
            (decimalPart + "00")
                .slice(0, 2)
        );


    const amountKobo =
        naira * 100 +
        koboPart;


    if (
        !Number.isSafeInteger(
            amountKobo
        )
    ) {

        throw new Error(
            "Airtime amount is too large."
        );

    }


    return amountKobo;

}


// =====================================================
// VALIDATE AMOUNT
// =====================================================
//
// Returns integer kobo.
//
// Minimum:
//
//   ₦50
//
// Maximum:
//
//   ₦50,000
// =====================================================

function validateAmountNaira(value) {

    const amountKobo =
        nairaToKobo(value);


    if (
        amountKobo <
        MIN_AIRTIME_KOBO
    ) {

        throw new Error(
            `Minimum Airtime amount is ₦${MIN_AIRTIME_NAIRA}.`
        );

    }


    if (
        amountKobo >
        MAX_AIRTIME_KOBO
    ) {

        throw new Error(
            `Maximum Airtime amount is ₦${MAX_AIRTIME_NAIRA.toLocaleString()}.`
        );

    }


    return amountKobo;

}


// =====================================================
// VALIDATE REQUEST
// =====================================================
//
// Expected input:
//
// {
//     phoneNumber: "08012345678",
//     network: "mtn",
//     amount: "100"
// }
//
// Also accepts:
//
// body.phone
//
// and:
//
// body.serviceId
//
// for compatibility with existing frontend payloads.
//
// Returns only normalized, trusted values.
// =====================================================

function validateAirtimeRequest(body) {

    if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body)
    ) {

        throw new Error(
            "Airtime request is required."
        );

    }


    const phoneNumber =
        validatePhoneNumber(
            body.phoneNumber ??
            body.phone
        );


    const network =
        validateNetwork(
            body.network ??
            body.serviceId
        );


    const amountKobo =
        validateAmountNaira(
            body.amount
        );


    return {

        phoneNumber,

        network,

        amountKobo

    };

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    MIN_AIRTIME_NAIRA,

    MAX_AIRTIME_NAIRA,

    MIN_AIRTIME_KOBO,

    MAX_AIRTIME_KOBO,

    SUPPORTED_NETWORKS,

    normalizeNetwork,

    validateNetwork,

    normalizePhoneNumber,

    validatePhoneNumber,

    nairaToKobo,

    validateAmountNaira,

    validateAirtimeRequest

};