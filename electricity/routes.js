"use strict";

const express = require("express");

const {
    requireAuth
} =
    require("../auth");

const {
    purchaseElectricity
} =
    require("./service");

const {
    verifyElectricityCustomer
} =
    require("./vtu");

const electricityProvider =
    require("./vtu");


const router =
    express.Router();


// =====================================================
// NOVAPAY — ELECTRICITY ROUTES
// =====================================================
//
// RESPONSIBILITY
//
// This module is the HTTP boundary for Electricity.
//
// Frontend
//    ↓
// Firebase authentication
//    ↓
// this route
//    ↓
// electricity/service.js
//    ↓
// electricity/vtu.js
//    ↓
// VTU.ng
//
// IMPORTANT:
//
// - UID always comes from Firebase authentication.
// - Frontend supplied UID is ignored.
// - Frontend never controls wallet reservations.
// - Frontend never controls transaction status.
// - Frontend never supplies provider credentials.
// - Financial operations happen inside service.js.
// =====================================================


// =====================================================
// CONSTANTS
// =====================================================

const MAX_AMOUNT_NAIRA =
    100000;

const MAX_CUSTOMER_ID_LENGTH =
    50;

const MAX_SERVICE_ID_LENGTH =
    50;

const MAX_METER_TYPE_LENGTH =
    20;


// =====================================================
// REQUEST BODY
// =====================================================

function getRequestBody(
    req
) {

    if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
    ) {

        throw createHttpError(
            "Request body is required.",
            400
        );

    }

    return req.body;

}


// =====================================================
// ERROR FACTORY
// =====================================================

function createHttpError(
    message,
    statusCode
) {

    const error =
        new Error(
            message
        );

    error.statusCode =
        statusCode;

    return error;

}


// =====================================================
// REQUIRED STRING
// =====================================================

function requireString(
    value,
    fieldName,
    maxLength
) {

    const normalized =
        String(
            value ?? ""
        ).trim();

    if (!normalized) {

        throw createHttpError(
            `${fieldName} is required.`,
            400
        );

    }

    if (
        normalized.length >
        maxLength
    ) {

        throw createHttpError(
            `${fieldName} is too long.`,
            400
        );

    }

    return normalized;

}


// =====================================================
// AMOUNT → KOBO
// =====================================================
//
// Frontend sends NGN.
//
// Backend internally uses kobo.
//
// Example:
//
// 100 NGN
//     ↓
// 10000 kobo
//
// Floating-point amounts are rejected.
// =====================================================

function parseAmountKobo(
    value
) {

    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {

        throw createHttpError(
            "Electricity amount is required.",
            400
        );

    }

    const stringValue =
        String(
            value
        ).trim();


    if (
        !/^\d+(?:\.\d{1,2})?$/.test(
            stringValue
        )
    ) {

        throw createHttpError(
            "Electricity amount must be a valid NGN amount.",
            400
        );

    }


    const number =
        Number(
            stringValue
        );


    if (
        !Number.isFinite(
            number
        ) ||
        number <= 0
    ) {

        throw createHttpError(
            "Electricity amount must be greater than zero.",
            400
        );

    }


    if (
        number >
        MAX_AMOUNT_NAIRA
    ) {

        throw createHttpError(
            "Electricity amount exceeds the maximum allowed amount.",
            400
        );

    }


    const amountKobo =
        Math.round(
            number * 100
        );


    if (
        !Number.isSafeInteger(
            amountKobo
        ) ||
        amountKobo <= 0
    ) {

        throw createHttpError(
            "Invalid electricity amount.",
            400
        );

    }


    return amountKobo;

}


// =====================================================
// AUTHENTICATED UID
// =====================================================

function requireAuthenticatedUid(
    req
) {

    const uid =
        req.user?.uid;


    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {

        throw createHttpError(
            "Authentication required.",
            401
        );

    }


    return uid.trim();

}


// =====================================================
// PROVIDER CLIENT
// =====================================================
//
// The provider adapter itself contains the VTU.ng
// authentication and API logic.
//
// No provider credentials are accepted from HTTP.
//
// =====================================================

function getProviderClient() {

    if (
        !electricityProvider ||
        typeof electricityProvider.verifyElectricityCustomer !==
            "function" ||
        typeof electricityProvider.purchaseElectricity !==
            "function"
    ) {

        throw new Error(
            "Electricity provider client is not available."
        );

    }


    return electricityProvider;

}


// =====================================================
// VERIFY ELECTRICITY CUSTOMER
// =====================================================
//
// POST /api/electricity/verify
//
// Expected body:
//
// {
//   serviceId,
//   meterType,
//   customerId
// }
//
// No money is reserved.
//
// No wallet is changed.
//
// This endpoint only verifies the meter/customer.
// =====================================================

router.post(
    "/verify",
    requireAuth,
    async (
        req,
        res
    ) => {

        try {

            const uid =
                requireAuthenticatedUid(
                    req
                );


            /*
             * UID is intentionally obtained from auth
             * but is not sent to VTU.
             *
             * Verification is a provider lookup and
             * does not operate on the wallet.
             */

            void uid;


            const body =
                getRequestBody(
                    req
                );


            const serviceId =
                requireString(
                    body.serviceId,
                    "Electricity service",
                    MAX_SERVICE_ID_LENGTH
                )
                    .toLowerCase();


            const meterType =
                requireString(
                    body.meterType,
                    "Electricity meter type",
                    MAX_METER_TYPE_LENGTH
                )
                    .toLowerCase();


            const customerId =
                requireString(
                    body.customerId ??
                    body.meterNumber,
                    "Electricity meter number",
                    MAX_CUSTOMER_ID_LENGTH
                );


            const providerClient =
                getProviderClient();


            const result =
                await providerClient.verifyElectricityCustomer({

                    customerId,

                    serviceId,

                    meterType

                });


            return res.status(200).json({

                success:
                    true,

                verification: {

                    verified:
                        true,

                    serviceId,

                    meterType,

                    customerId,

                    customerName:
                        result?.customerName ||
                        null,

                    customerAddress:
                        result?.customerAddress ||
                        null,

                    accountNumber:
                        result?.accountNumber ||
                        null,

                    meterNumber:
                        result?.meterNumber ||
                        null,

                    outstanding:
                        result?.outstanding ??
                        null,

                    minPurchaseAmount:
                        result?.minPurchaseAmount ??
                        null,

                    maxPurchaseAmount:
                        result?.maxPurchaseAmount ??
                        null

                },

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay electricity verification error:",
                {

                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error?.message ||
                        "Unknown error"

                }
            );


            const statusCode =
                Number.isInteger(
                    error?.statusCode
                )
                    ? error.statusCode
                    : 500;


            return res.status(
                statusCode
            ).json({

                success:
                    false,

                error:
                    statusCode >= 500
                        ? "Unable to verify electricity customer."
                        : error.message,

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// PURCHASE ELECTRICITY
// =====================================================
//
// POST /api/electricity/purchase
//
// Expected body:
//
// {
//   serviceId,
//   meterType,
//   customerId,
//   amount
// }
//
// `amount` is NGN from the frontend.
//
// It is converted to kobo before reaching the financial
// service.
//
// IMPORTANT:
//
// The route does NOT:
//
// - reserve funds
// - commit funds
// - release funds
// - set transaction status
//
// All financial decisions belong to service.js.
// =====================================================

router.post(
    "/purchase",
    requireAuth,
    async (
        req,
        res
    ) => {

        try {

            const uid =
                requireAuthenticatedUid(
                    req
                );


            const body =
                getRequestBody(
                    req
                );


            const serviceId =
                requireString(
                    body.serviceId,
                    "Electricity service",
                    MAX_SERVICE_ID_LENGTH
                )
                    .toLowerCase();


            const meterType =
                requireString(
                    body.meterType,
                    "Electricity meter type",
                    MAX_METER_TYPE_LENGTH
                )
                    .toLowerCase();


            const customerId =
                requireString(
                    body.customerId ??
                    body.meterNumber,
                    "Electricity meter number",
                    MAX_CUSTOMER_ID_LENGTH
                );


            const amountKobo =
                parseAmountKobo(
                    body.amount
                );


            const providerClient =
                getProviderClient();


            const result =
                await purchaseElectricity({

                    uid,

                    serviceId,

                    meterType,

                    customerId,

                    amountKobo,

                    providerClient

                });


            /*
             * The HTTP status does not determine the
             * financial outcome.
             *
             * The service has already decided whether
             * the provider result was:
             *
             * successful
             * failed
             * unknown
             *
             * Unknown remains financially reserved.
             */

            let httpStatus =
                200;


            if (
                result?.status ===
                "failed"
            ) {

                httpStatus =
                    400;

            }


            if (
                result?.status ===
                "unknown"
            ) {

                /*
                 * 202 means NovaPay accepted the request
                 * but does not yet have a definitive
                 * provider outcome.
                 */

                httpStatus =
                    202;

            }


            return res.status(
                httpStatus
            ).json({

                success:
                    result?.status ===
                    "successful",

                status:
                    result?.status ||
                    "unknown",

                transactionId:
                    result?.transactionId ||
                    null,

                amountKobo:
                    result?.amountKobo ??
                    amountKobo,

                serviceId:
                    result?.serviceId ||
                    serviceId,

                meterType:
                    result?.meterType ||
                    meterType,

                customerId:
                    result?.customerId ||
                    customerId,

                providerReference:
                    result?.providerReference ||
                    null,

                message:
                    result?.message ||
                    (
                        result?.status ===
                        "successful"
                            ? "Electricity purchase completed successfully."
                            : result?.status ===
                              "failed"
                                ? "Electricity purchase failed."
                                : "Your electricity request is being verified. Please do not retry yet."
                    ),

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay electricity purchase error:",
                {

                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error?.message ||
                        "Unknown error"

                }
            );


            const statusCode =
                Number.isInteger(
                    error?.statusCode
                )
                    ? error.statusCode
                    : 500;


            return res.status(
                statusCode
            ).json({

                success:
                    false,

                error:
                    statusCode >= 500
                        ? "Unable to process electricity purchase."
                        : error.message,

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// MODULE EXPORT
// =====================================================

module.exports =
    router;