// airtime/routes.js

const express = require("express");

const router = express.Router();


// =====================================================
// NOVAPAY — AIRTIME HTTP ROUTES
// =====================================================
//
// RESPONSIBILITY
//
// This file is ONLY the HTTP/API boundary for Airtime.
//
// Flow:
//
// Frontend
//    ↓
// POST /airtime/purchase
//    ↓
// Authentication
//    ↓
// Request validation
//    ↓
// Airtime service
//    ↓
// Wallet reservation
//    ↓
// VTU.ng
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
// Those responsibilities belong to the service and
// reservation/provider layers.
//
// =====================================================


// =====================================================
// IMPORT VALIDATION
// =====================================================

const {
    validateAirtimeRequest
} = require("./validation");


// =====================================================
// IMPORT AIRTIME SERVICE
// =====================================================

const airtimeService =
    require("./service");


// =====================================================
// IMPORT VTU PROVIDER
// =====================================================
//
// The service may use the provider adapter internally.
//
// The route does not call VTU directly.
//
// =====================================================

const vtu =
    require("./vtu");


// =====================================================
// AUTHENTICATION RESOLUTION
// =====================================================
//
// NovaPay may expose its authentication middleware under
// different names depending on the existing auth module.
//
// We resolve the existing middleware instead of creating
// a second authentication implementation here.
//
// Authentication must happen BEFORE the Airtime service.
//
// =====================================================

function getAuthenticationMiddleware() {

    let authModule;


    try {

        authModule =
            require("../auth");

    }

    catch (error) {

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
// Different authentication middleware implementations
// can attach the authenticated Firebase user to different
// request properties.
//
// Normalize those possibilities into one UID.
//
// =====================================================

function getAuthenticatedUid(
    req
) {

    const uid =
        req?.user?.uid ||
        req?.auth?.uid ||
        req?.firebaseUser?.uid ||
        req?.user?.localId ||
        null;


    if (
        typeof uid !== "string"
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
// Only deliberately safe business messages are returned.
//
// =====================================================

function getSafeErrorMessage(
    error
) {

    const message =
        String(
            error?.message ||
            ""
        ).trim();


    if (!message) {

        return "Unable to process Airtime request.";

    }


    const safeMessages = new Set([

        "Authenticated user ID is required.",

        "Airtime request is required.",

        "Airtime network is required.",

        "Unsupported Airtime network.",

        "Airtime phone number is required.",

        "Enter a valid Nigerian Airtime phone number.",

        "Enter a valid Nigerian phone number.",

        "Invalid Airtime amount.",

        "Airtime amount must be a positive integer in kobo.",

        "Airtime amount must be a valid whole-naira amount.",

        "Unable to reserve wallet funds.",

        "Your wallet balance is insufficient.",

        "Insufficient wallet balance."

    ]);


    if (
        safeMessages.has(
            message
        )
    ) {

        return message;

    }


    /*
     * Preserve configured Airtime limit messages.
     */

    if (
        message.startsWith(
            "Minimum Airtime amount is"
        )
    ) {

        return message;

    }


    if (
        message.startsWith(
            "Maximum Airtime amount is"
        )
    ) {

        return message;

    }


    /*
     * Provider errors and unexpected internal errors
     * must not be exposed directly to the client.
     */

    return "Unable to process Airtime request.";

}


// =====================================================
// HTTP ERROR STATUS
// =====================================================
//
// Service errors may carry statusCode/status.
//
// Only valid client-error status codes are accepted.
//
// Everything else becomes HTTP 500.
//
// =====================================================

function getErrorStatus(
    error
) {

    const statusCode =
        Number(
            error?.statusCode
        );


    if (
        Number.isInteger(
            statusCode
        ) &&
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
        Number.isInteger(
            status
        ) &&
        status >= 400 &&
        status <= 499
    ) {

        return status;

    }


    return 500;

}


// =====================================================
// POST /purchase
// =====================================================
//
// Purchase Airtime.
//
// Expected frontend body:
//
// {
//     "phoneNumber": "08012345678",
//     "network": "glo",
//     "amount": "50"
// }
//
// The frontend supplies ONLY the customer request.
//
// The server calculates the financial amount.
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
        // VALIDATE REQUEST
        // -------------------------------------------------
        //
        // Validation happens before the financial service.
        //
        // This prevents malformed requests from reaching
        // wallet reservation or VTU.ng.
        //

        let validated;


        try {

            validated =
                validateAirtimeRequest(
                    req.body
                );

        }

        catch (error) {

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


        // -------------------------------------------------
        // EXECUTE PURCHASE
        // -------------------------------------------------
        //
        // The Airtime service owns the complete business
        // workflow.
        //
        // The route does NOT perform financial operations.
        //

        try {

            const result =
                await airtimeService.purchaseAirtime({

                    uid,

                    network:
                        validated.network,

                    phoneNumber:
                        validated.phoneNumber,

                    amountKobo:
                        validated.amountKobo,

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

                    rewardPoints:
                        result.rewardPoints,

                    gainKobo:
                        result.gainKobo

                });

            }


            // =============================================
            // PENDING
            // =============================================
            //
            // A pending provider result is NOT a failure.
            //
            // Most importantly, the frontend must not be
            // encouraged to submit the same purchase again.
            //

            if (
                result &&
                result.status ===
                "pending"
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
                        "Your Airtime request is being processed. Please do not retry yet."

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
                        "Airtime could not be completed."

                });

            }


            // =============================================
            // UNKNOWN RESULT
            // =============================================
            //
            // Never turn an unexpected service result into
            // an assumed success or assumed failure.
            //
            // Financial state belongs to the service.
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
                    "Your Airtime request is being verified. Please do not retry yet."

            });

        }

        catch (error) {

            // -------------------------------------------------
            // SERVER LOG
            // -------------------------------------------------
            //
            // Log only controlled diagnostic information.
            //
            // Do not log:
            //
            // - authorization tokens
            // - provider passwords
            // - provider JWT
            // - complete provider response
            //

            console.error(
                "Airtime purchase error:",
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


            // -------------------------------------------------
            // CLIENT RESPONSE
            // -------------------------------------------------

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
// Retrieve one Airtime transaction.
//
// SECURITY:
//
// The authenticated UID MUST match the transaction UID.
//
// A transaction belonging to another user is returned as
// 404 instead of 403 so the endpoint does not disclose
// whether another user's transaction exists.
//
// =====================================================

router.get(
    "/transaction/:transactionId",
    getAuthenticationMiddleware(),
    async (
        req,
        res
    ) => {

        // -------------------------------------------------
        // AUTHENTICATION
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
        // TRANSACTION ID
        // -------------------------------------------------

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
                    "Airtime transaction ID is required."

            });

        }


        /*
         * Basic identifier length protection.
         */

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
                    "Airtime transaction ID is invalid."

            });

        }


        // -------------------------------------------------
        // LOAD TRANSACTION
        // -------------------------------------------------

        try {

            const transaction =
                await airtimeService.getAirtimeTransaction(
                    transactionId
                );


            // -------------------------------------------------
            // NOT FOUND
            // -------------------------------------------------

            if (!transaction) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Airtime transaction not found."

                });

            }


            // -------------------------------------------------
            // OWNERSHIP CHECK
            // -------------------------------------------------
            //
            // Never expose another user's transaction.
            //

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
                        "Airtime transaction not found."

                });

            }


            // -------------------------------------------------
            // SAFE RESPONSE
            // -------------------------------------------------
            //
            // Internal wallet reservation/accounting fields
            // are deliberately excluded.
            //

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

                    amountKobo:
                        transaction.amountKobo,

                    currency:
                        transaction.currency,

                    status:
                        transaction.status,

                    providerReference:
                        transaction.providerReference ||
                        null,

                    rewardPoints:
                        transaction.rewardPoints ||
                        0,

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

        }

        catch (error) {

            console.error(
                "Airtime transaction lookup error:",
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
                500
            ).json({

                success:
                    false,

                error:
                    "Unable to retrieve Airtime transaction."

            });

        }

    }
);


// =====================================================
// ROUTER EXPORT
// =====================================================

module.exports =
    router;