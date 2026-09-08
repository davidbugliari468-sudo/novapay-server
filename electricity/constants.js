"use strict";

/*
 * =====================================================
 * NOVAPAY — ELECTRICITY CONSTANTS
 * =====================================================
 *
 * The frontend uses short company identifiers such as:
 *
 *   ikedc
 *   ekedc
 *   aedc
 *   ibedc
 *   phed
 *   eedc
 *   bedc
 *   jed
 *
 * VTU.ng uses its own service IDs.
 *
 * The frontend identifiers MUST NOT be sent directly
 * to VTU.ng.
 *
 * This module provides the authoritative backend mapping.
 * =====================================================
 */


// =====================================================
// ELECTRICITY TRANSACTION STATUS
// =====================================================

const ELECTRICITY_STATUS = Object.freeze({

    PENDING:
        "pending",

    SUCCESS:
        "successful",

    FAILED:
        "failed",

    UNKNOWN:
        "unknown",

    MANUAL_REVIEW:
        "manual_review"

});


// =====================================================
// RECONCILIATION STATUS
// =====================================================

const RECONCILIATION_STATUS = Object.freeze({

    NOT_REQUIRED:
        "not_required",

    REQUIRED:
        "required",

    IN_PROGRESS:
        "in_progress",

    WAITING:
        "waiting",

    RESOLVED:
        "resolved",

    ESCALATED:
        "escalated"

});


// =====================================================
// METER TYPES
// =====================================================

const METER_TYPES = Object.freeze({

    PREPAID:
        "prepaid",

    POSTPAID:
        "postpaid"

});


// =====================================================
// FRONTEND COMPANY IDENTIFIERS
// =====================================================
//
// These are the values currently used by the
// Electricity frontend.
//
// Do not change these to VTU values.
// =====================================================

const ELECTRICITY_COMPANIES = Object.freeze({

    IKEDC:
        "ikedc",

    EKEDC:
        "ekedc",

    AEDC:
        "aedc",

    IBEDC:
        "ibedc",

    PHED:
        "phed",

    EEDC:
        "eedc",

    BEDC:
        "bedc",

    JED:
        "jed"

});


// =====================================================
// FRONTEND → VTU.ng SERVICE ID
// =====================================================
//
// This is the important backend translation layer.
//
// Frontend:
//     ikedc
//
// Backend → VTU:
//     ikeja-electric
// =====================================================

const ELECTRICITY_SERVICE_IDS = Object.freeze({

    ikedc:
        "ikeja-electric",

    ekedc:
        "eko-electric",

    aedc:
        "abuja-electric",

    ibedc:
        "ibadan-electric",

    phed:
        "portharcourt-electric",

    eedc:
        "enugu-electric",

    bedc:
        "benin-electric",

    jed:
        "jos-electric"

});


// =====================================================
// ADDITIONAL VTU SERVICES
// =====================================================
//
// These are supported by the provider but are not
// currently represented by buttons in the supplied
// frontend.
// =====================================================

const ADDITIONAL_VTU_SERVICE_IDS = Object.freeze({

    kedco:
        "kano-electric",

    kaedco:
        "kaduna-electric",

    yedc:
        "yola-electric",

    aba:
        "aba-electric"

});


// =====================================================
// ALL PROVIDER SERVICE IDS
// =====================================================

const SUPPORTED_VTU_SERVICE_IDS =
    Object.freeze(
        new Set([
            ...Object.values(
                ELECTRICITY_SERVICE_IDS
            ),

            ...Object.values(
                ADDITIONAL_VTU_SERVICE_IDS
            )
        ])
    );


// =====================================================
// ALL FRONTEND COMPANY IDS
// =====================================================

const SUPPORTED_ELECTRICITY_COMPANIES =
    Object.freeze(
        new Set([
            ...Object.keys(
                ELECTRICITY_SERVICE_IDS
            ),

            ...Object.keys(
                ADDITIONAL_VTU_SERVICE_IDS
            )
        ])
    );


// =====================================================
// PROVIDER STATUSES
// =====================================================

const PROVIDER_STATUSES = Object.freeze({

    SUCCESS:
        "completed-api",

    PROCESSING:
        "processing-api",

    QUEUED:
        "queued-api",

    INITIATED:
        "initiated-api",

    PENDING:
        "pending",

    ON_HOLD:
        "on-hold",

    FAILED:
        "failed",

    REFUNDED:
        "refunded",

    CANCELLED:
        "cancelled"

});


// =====================================================
// PROVIDER OUTCOMES
// =====================================================

const PROVIDER_OUTCOMES = Object.freeze({

    SUCCESS:
        "success",

    FAILURE:
        "failure",

    UNKNOWN:
        "unknown"

});


// =====================================================
// REASON CODES
// =====================================================

const ELECTRICITY_REASON_CODES = Object.freeze({

    INSUFFICIENT_FUNDS:
        "insufficient_funds",

    BELOW_MINIMUM_AMOUNT:
        "below_minimum_amount",

    BELOW_CUSTOMER_ARREARS:
        "below_customer_arrears",

    INVALID_SERVICE:
        "invalid_service",

    INVALID_SERVICE_ID:
        "invalid_service_id",

    INVALID_VARIATION_ID:
        "invalid_variation_id",

    MISSING_FIELDS:
        "missing_fields",

    DUPLICATE_REQUEST:
        "duplicate_request",

    DUPLICATE_REQUEST_ID:
        "duplicate_request_id",

    DUPLICATE_ORDER:
        "duplicate_order",

    ORDER_FAILED:
        "order_failed",

    PRODUCT_UNAVAILABLE:
        "product_unavailable",

    ORDER_NOT_FOUND:
        "order_not_found",

    WALLET_BUSY:
        "wallet_busy",

    RATE_LIMIT_EXCEEDED:
        "rate_limit_exceeded"

});


// =====================================================
// RECONCILIATION CONFIGURATION
// =====================================================

const RECONCILIATION_CONFIG = Object.freeze({

    BACKOFF_MINUTES:
        Object.freeze([
            1,
            5,
            15,
            30,
            60
        ]),

    MAX_ATTEMPTS:
        5

});


// =====================================================
// AMOUNT LIMITS
// =====================================================

const ELECTRICITY_LIMITS = Object.freeze({

    MAX_AMOUNT_NAIRA:
        100000,

    MAX_AMOUNT_KOBO:
        10000000

});


// =====================================================
// INPUT LIMITS
// =====================================================

const ELECTRICITY_INPUT_LIMITS = Object.freeze({

    MAX_CUSTOMER_ID_LENGTH:
        50,

    MAX_SERVICE_ID_LENGTH:
        50,

    MAX_METER_TYPE_LENGTH:
        20

});


// =====================================================
// SERVICE ID NORMALIZATION
// =====================================================
//
// Converts the frontend identifier to the provider
// identifier.
//
// Examples:
//
//   ikedc → ikeja-electric
//   phed  → portharcourt-electric
//   jed   → jos-electric
//
// If a provider service ID is already supplied,
// it is accepted as an internal/provider value.
// =====================================================

function normalizeElectricityServiceId(
    serviceId
) {

    const normalized =
        String(
            serviceId ?? ""
        )
            .trim()
            .toLowerCase();


    if (!normalized) {

        return null;

    }


    if (
        Object.prototype.hasOwnProperty.call(
            ELECTRICITY_SERVICE_IDS,
            normalized
        )
    ) {

        return ELECTRICITY_SERVICE_IDS[
            normalized
        ];

    }


    if (
        Object.prototype.hasOwnProperty.call(
            ADDITIONAL_VTU_SERVICE_IDS,
            normalized
        )
    ) {

        return ADDITIONAL_VTU_SERVICE_IDS[
            normalized
        ];

    }


    if (
        SUPPORTED_VTU_SERVICE_IDS.has(
            normalized
        )
    ) {

        return normalized;

    }


    return null;

}


// =====================================================
// FRONTEND COMPANY VALIDATION
// =====================================================

function isSupportedElectricityCompany(
    company
) {

    const normalized =
        String(
            company ?? ""
        )
            .trim()
            .toLowerCase();


    return SUPPORTED_ELECTRICITY_COMPANIES.has(
        normalized
    );

}


// =====================================================
// SERVICE ID VALIDATION
// =====================================================

function isSupportedElectricityServiceId(
    serviceId
) {

    return Boolean(
        normalizeElectricityServiceId(
            serviceId
        )
    );

}


// =====================================================
// METER TYPE VALIDATION
// =====================================================

function isSupportedMeterType(
    meterType
) {

    const normalized =
        String(
            meterType ?? ""
        )
            .trim()
            .toLowerCase();


    return (
        normalized ===
            METER_TYPES.PREPAID ||
        normalized ===
            METER_TYPES.POSTPAID
    );

}


// =====================================================
// PROVIDER STATUS CLASSIFICATION
// =====================================================

function isDefiniteProviderFailureStatus(
    status
) {

    const normalized =
        String(
            status ?? ""
        )
            .trim()
            .toLowerCase();


    return (
        normalized ===
            PROVIDER_STATUSES.FAILED ||
        normalized ===
            PROVIDER_STATUSES.REFUNDED ||
        normalized ===
            PROVIDER_STATUSES.CANCELLED
    );

}


function isProviderSuccessStatus(
    status
) {

    return (
        String(
            status ?? ""
        )
            .trim()
            .toLowerCase() ===
        PROVIDER_STATUSES.SUCCESS
    );

}


function isProviderPendingStatus(
    status
) {

    const normalized =
        String(
            status ?? ""
        )
            .trim()
            .toLowerCase();


    return (
        normalized ===
            PROVIDER_STATUSES.PROCESSING ||
        normalized ===
            PROVIDER_STATUSES.QUEUED ||
        normalized ===
            PROVIDER_STATUSES.INITIATED ||
        normalized ===
            PROVIDER_STATUSES.PENDING ||
        normalized ===
            PROVIDER_STATUSES.ON_HOLD
    );

}


// =====================================================
// GENERAL PROVIDER STATUS CLASSIFIER
// =====================================================

function classifyProviderStatus(
    status
) {

    if (
        isProviderSuccessStatus(
            status
        )
    ) {

        return PROVIDER_OUTCOMES.SUCCESS;

    }


    if (
        isDefiniteProviderFailureStatus(
            status
        )
    ) {

        return PROVIDER_OUTCOMES.FAILURE;

    }


    return PROVIDER_OUTCOMES.UNKNOWN;

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    ELECTRICITY_STATUS,

    RECONCILIATION_STATUS,

    METER_TYPES,

    ELECTRICITY_COMPANIES,

    ELECTRICITY_SERVICE_IDS,

    ADDITIONAL_VTU_SERVICE_IDS,

    SUPPORTED_VTU_SERVICE_IDS,

    SUPPORTED_ELECTRICITY_COMPANIES,

    PROVIDER_STATUSES,

    PROVIDER_OUTCOMES,

    ELECTRICITY_REASON_CODES,

    RECONCILIATION_CONFIG,

    ELECTRICITY_LIMITS,

    ELECTRICITY_INPUT_LIMITS,

    normalizeElectricityServiceId,

    isSupportedElectricityCompany,

    isSupportedElectricityServiceId,

    isSupportedMeterType,

    isDefiniteProviderFailureStatus,

    isProviderSuccessStatus,

    isProviderPendingStatus,

    classifyProviderStatus

};