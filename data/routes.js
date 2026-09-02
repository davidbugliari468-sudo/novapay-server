"use strict";

const express = require("express");

const router = express.Router();


// =====================================================
// NOVAPAY — DATA HTTP ROUTES
// =====================================================
//
// RESPONSIBILITY
//
// This file is ONLY the HTTP/API boundary for Data.
//
// Flow:
//
// Frontend
//    ↓
// POST /data/purchase
//    ↓
// Authentication
//    ↓
// Data service
//    ↓
// Wallet reservation
//    ↓
// VTU.ng Data API
//    ↓
// Commit / release / pending
//
// IMPORTANT
//
// This file MUST NOT:
//
// - debit wallets
// - reserve wallet funds directly
// - release wallet funds directly
// - call Firestore financial operations directly
// - call VTU.ng directly
// - trust frontend wallet balances
// - accept provider cost from frontend
// - accept transaction status from frontend
// - accept provider credentials from frontend
//
// Those responsibilities belong to the service,
// reservation, and provider layers.
//
// =====================================================


// =====================================================
// DATA SERVICE
// =====================================================

const dataService =
    require("./service");


// =====================================================
// DATA PROVIDER
// =====================================================
//
// The route passes the provider adapter into the service.
//
// The route itself never calls VTU.ng.
//
// IMPORTANT:
// The provider adapter is located at:
//
// data/provider/vtu.js
//
// Therefore this relative import is:
//
// ./provider/vtu
//
// =====================================================

const vtu =
    require("./provider/vtu");


// =====================================================
// DATA CATALOG
// =====================================================

const {
    getDataCatalog,
    getDataPlansForNetwork
} = require("./catalog");


// =====================================================
// AUTHENTICATION RESOLUTION
// =====================================================
//
// Use the same authentication architecture already used
// by the working Airtime routes.
//
// =====================================================

function getAuthenticationMiddleware() {

    let authModule;

    try {

        authModule =
            require("../auth");

    } catch (error) {

        throw new Error(
            "NovaPay authentication module could not be loaded."
        );

    }

    const possibleNames = [

        "authenticate",

        "authenticateUser",

        "requireAuth",

        "requireAuthentication",

        "verifyToken",

        "verifyFirebaseToken",

        "authMiddleware",

        "auth"

    ];

    for (
        const name
        of possibleNames
    ) {

        if (
            typeof authModule?.[name] ===
            "function"
        ) {

            return authModule[name];

        }

    }

    /*
     * Support an auth module that exports the middleware
     * directly as the module itself.
     */

    if (
        typeof authModule ===
        "function"
    ) {

        return authModule;

    }

    throw new Error(
        "A valid authentication middleware was not found."
    );

}


// =====================================================
// AUTHENTICATED UID
// =====================================================
//
// Normalize the possible locations used by the existing
// authentication layer.
//
// =====================================================

function getAuthenticatedUid(req) {

    const uid =
        req?.user?.uid ||
        req?.auth?.uid ||
        req?.firebaseUser?.uid ||
        req?.user?.localId ||
        null;

    if (
        typeof uid !==
        "string"
    ) {

        return null;

    }

    const normalized =
        uid.trim();

    return normalized ||
        null;

}


// =====================================================
// SAFE ERROR MESSAGE
// =====================================================
//
// Never expose:
//
// - provider credentials
// - access tokens
// - JWTs
// - stack traces
// - Firestore internals
// - raw provider payloads
// - internal database paths
//
// =====================================================

function getSafeErrorMessage(error) {

    const message =
        String(
            error?.publicMessage ||
            error?.message ||
            ""
        ).trim();

    if (!message) {

        return "Unable to process Data request.";

    }

    const safeMessages = new Set([

        "Authenticated user ID is required.",

        "Data request is required.",

        "Data network is required.",

        "Unsupported Data network.",

        "Data phone number is required.",

        "Enter a valid Nigerian phone number.",

        "Invalid Data amount.",

        "Data amount must be a positive integer in kobo.",

        "Data plan is required.",

        "Data plan not found.",

        "Data plan is unavailable.",

        "Insufficient wallet balance."

    ]);

    if (
        safeMessages.has(message)
    ) {

        return message;

    }

    /*
     * Preserve controlled Data amount messages.
     */

    if (
        message.startsWith(
            "Minimum Data amount is"
        )
    ) {

        return message;

    }

    if (
        message.startsWith(
            "Maximum Data amount is"
        )
    ) {

        return message;

    }

    /*
     * Preserve the deliberate price-change error.
     */

    if (
        message ===
        "Data plan price has changed. Please refresh the available plans."
    ) {

        return message;

    }

    /*
     * Provider and unexpected internal errors must not
     * be exposed directly.
     */

    return "Unable to process Data request.";

}


// =====================================================
// HTTP ERROR STATUS
// =====================================================

function getErrorStatus(error) {

    const statusCode =
        Number(
            error?.statusCode
        );

    if (
        Number.isInteger(statusCode) &&
        statusCode >= 400 &&
        statusCode <= 499
    ) {

        return statusCode;

    }

    const status =
        Number(
            error?.status
        );

    if (
        Number.isInteger(status) &&
        status >= 400 &&
        status <= 499
    ) {

        return status;

    }

    return 500;

}


// =====================================================
// GET /plans
// =====================================================
//
// Public catalog endpoint.
//
// The catalog itself contains no customer's private
// information and does not perform financial operations.
//
// Optional:
//
//   GET /api/data/plans
//
//   GET /api/data/plans?network=mtn
//
// =====================================================

router.get(
    "/plans",
    async (
        req,
        res
    ) => {

        try {

            const network =
                typeof req.query.network ===
                "string"
                    ? req.query.network.trim()
                    : "";

            if (network) {

                const plans =
                    await getDataPlansForNetwork(
                        network
                    );

                return res.status(
                    200
                ).json({

                    success:
                        true,

                    plans

                });

            }

            const plans =
                await getDataCatalog();

            return res.status(
                200
            ).json({

                success:
                    true,

                plans

            });

        } catch (error) {

            console.error(
                "Data catalog retrieval error:",
                {
                    message:
                        String(
                            error?.message ||
                            "Unknown error"
                        ).slice(
                            0,
                            300
                        )
                }
            );

            return res.status(
                503
            ).json({

                success:
                    false,

                error:
                    "Data plans are temporarily unavailable."

            });

        }

    }
);


// =====================================================
// POST /purchase
// =====================================================
//
// Purchase Data.
//
// Expected frontend request:
//
// {
//     "phoneNumber": "08012345678",
//     "network": "mtn",
//     "planId": "..."
//
// }
//
// The Data service performs the authoritative validation,
// price verification, reservation, provider operation,
// and final wallet accounting.
//
// =====================================================

router.post(
    "/purchase",
    getAuthenticationMiddleware(),
    async (
        req,
        res
    ) => {

        // -------------------------------------------------
        // AUTHENTICATED UID
        // -------------------------------------------------

        const uid =
            getAuthenticatedUid(
                req
            );

        if (!uid) {

            return res.status(
                401
            ).json({

                success:
                    false,

                error:
                    "Authentication is required."

            });

        }

        // -------------------------------------------------
        // EXECUTE DATA PURCHASE
        // -------------------------------------------------
        //
        // Data service owns the complete financial workflow.
        //

        try {

            const result =
                await dataService.purchaseData({

                    uid,

                    input:
                        req.body,

                    providerClient:
                        vtu

                });

            // =============================================
            // SUCCESS
            // =============================================

            if (
                result &&
                result.status ===
                "successful"
            ) {

                return res.status(
                    200
                ).json({

                    success:
                        true,

                    pending:
                        false,

                    transactionId:
                        result.transactionId,

                    status:
                        result.status,

                    amountKobo:
                        result.amountKobo,

                    network:
                        result.network,

                    phoneNumber:
                        result.phoneNumber,

                    planId:
                        result.planId,

                    providerReference:
                        result.providerReference ||
                        null,

                    gainKobo:
                        result.gainKobo ??
                        null

                });

            }

            // =============================================
            // PENDING
            // =============================================
            //
            // Pending/unknown provider results must NOT be
            // turned into a failure.
            //
            // The client must not be encouraged to retry
            // the same financial operation.
            //

            if (
                result &&
                (
                    result.status ===
                    "pending" ||

                    result.status ===
                    "unknown"
                )
            ) {

                return res.status(
                    202
                ).json({

                    success:
                        false,

                    pending:
                        true,

                    transactionId:
                        result.transactionId,

                    status:
                        "pending",

                    message:
                        result.message ||
                        "Your Data request is being processed. Please do not retry yet."

                });

            }

            // =============================================
            // CONFIRMED FAILURE
            // =============================================

            if (
                result &&
                result.status ===
                "failed"
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    pending:
                        false,

                    transactionId:
                        result.transactionId,

                    status:
                        "failed",

                    message:
                        result.message ||
                        "Data purchase could not be completed."

                });

            }

            // =============================================
            // UNKNOWN SERVICE RESULT
            // =============================================
            //
            // Never assume success or failure.
            //

            return res.status(
                202
            ).json({

                success:
                    false,

                pending:
                    true,

                transactionId:
                    result?.transactionId ||
                    null,

                status:
                    "pending",

                message:
                    "Your Data request is being verified. Please do not retry yet."

            });

        } catch (error) {

            console.error(
                "Data purchase error:",
                {

                    uid,

                    message:
                        String(
                            error?.message ||
                            "Unknown error"
                        ).slice(
                            0,
                            300
                        )

                }
            );

            return res.status(
                getErrorStatus(
                    error
                )
            ).json({

                success:
                    false,

                error:
                    getSafeErrorMessage(
                        error
                    )

            });

        }

    }
);


// =====================================================
// GET /transaction/:transactionId
// =====================================================
//
// Retrieve one Data transaction.
//
// Ownership is checked before returning the transaction.
//
// =====================================================

router.get(
    "/transaction/:transactionId",
    getAuthenticationMiddleware(),
    async (
        req,
        res
    ) => {

        const uid =
            getAuthenticatedUid(
                req
            );

        if (!uid) {

            return res.status(
                401
            ).json({

                success:
                    false,

                error:
                    "Authentication is required."

            });

        }

        const transactionId =
            String(
                req.params.transactionId ||
                ""
            ).trim();

        if (!transactionId) {

            return res.status(
                400
            ).json({

                success:
                    false,

                error:
                    "Data transaction ID is required."

            });

        }

        if (
            transactionId.length >
            200
        ) {

            return res.status(
                400
            ).json({

                success:
                    false,

                error:
                    "Data transaction ID is invalid."

            });

        }

        try {

            const transaction =
                await dataService.getDataTransaction({

                    uid,

                    transactionId

                });

            if (!transaction) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Data transaction not found."

                });

            }

            /*
             * Do not expose another user's transaction.
             */

            if (
                transaction.uid !==
                uid
            ) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Data transaction not found."

                });

            }

            /*
             * Only return fields appropriate for the client.
             *
             * Internal wallet reservation/accounting fields
             * remain backend-only.
             */

            return res.status(
                200
            ).json({

                success:
                    true,

                transaction: {

                    id:
                        transaction.id,

                    service:
                        transaction.service,

                    network:
                        transaction.network,

                    phoneNumber:
                        transaction.phoneNumber,

                    planId:
                        transaction.planId,

                    planName:
                        transaction.planName ||
                        null,

                    amountKobo:
                        transaction.amountKobo,

                    currency:
                        transaction.currency,

                    status:
                        transaction.status,

                    providerReference:
                        transaction.providerReference ||
                        null,

                    gainKobo:
                        transaction.gainKobo ??
                        null,

                    createdAt:
                        transaction.createdAt ||
                        null,

                    updatedAt:
                        transaction.updatedAt ||
                        null

                }

            });

        } catch (error) {

            console.error(
                "Data transaction lookup error:",
                {

                    uid,

                    transactionId,

                    message:
                        String(
                            error?.message ||
                            "Unknown error"
                        ).slice(
                            0,
                            300
                        )

                }
            );

            return res.status(
                getErrorStatus(
                    error
                )
            ).json({

                success:
                    false,

                error:
                    getSafeErrorMessage(
                        error
                    )

            });

        }

    }
);


// =====================================================
// ROUTER EXPORT
// =====================================================

module.exports =
    router;