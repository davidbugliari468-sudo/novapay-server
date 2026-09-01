// airtime/routes.js

const express = require("express");

const router =
    express.Router();


// =====================================================
// NOVAPAY AIRTIME ROUTES
// =====================================================
//
// RESPONSIBILITY
//
// This file is the HTTP/API layer for Airtime.
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
// VTU.ng adapter
//    ↓
// Wallet reservation/commit/release
//
// IMPORTANT:
//
// The frontend must NEVER:
//
// - call VTU.ng directly
// - provide provider credentials
// - provide provider cost
// - decide transaction status
// - debit the wallet
// - release wallet funds
// - create financial transactions
//
// =====================================================


// =====================================================
// IMPORT VALIDATION
// =====================================================

const {
    validateAirtimeRequest
} =
    require("./validation");


// =====================================================
// IMPORT AIRTIME SERVICE
// =====================================================

const airtimeService =
    require("./service");


// =====================================================
// IMPORT VTU PROVIDER
// =====================================================

const vtu =
    require("./vtu");


// =====================================================
// AUTHENTICATION
// =====================================================
//
// NovaPay authentication may already be implemented by
// the application's root auth middleware.
//
// We deliberately resolve the middleware dynamically so
// this route can work with the existing auth.js export
// naming without duplicating Firebase authentication
// logic here.
//
// Authentication MUST happen before the Airtime service.
//
// =====================================================

function getAuthenticationMiddleware() {

    let authModule;


    try {

        authModule =
            require("../auth");

    }

    catch {

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
// AUTHENTICATED USER ID
// =====================================================
//
// Different authentication middleware implementations
// may place the Firebase user in different request
// properties.
//
// We normalize those possibilities here.
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
        typeof uid !== "string" ||
        !uid.trim()
    ) {

        return null;

    }


    return uid.trim();

}


// =====================================================
// SAFE ERROR MESSAGE
// =====================================================
//
// Do not expose:
//
// - provider credentials
// - JWT tokens
// - raw provider payloads
// - stack traces
// - internal database information
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


    /*
     * Known business/application errors are safe to return.
     */

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

        "Your wallet balance is insufficient."

    ]);


    if (
        safeMessages.has(
            message
        )
    ) {

        return message;

    }


    /*
     * Keep common validation/configuration messages that
     * are already intended for API consumers.
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
     * Everything else receives a generic response.
     */

    return "Unable to process Airtime request.";

}


// =====================================================
// HTTP STATUS FROM ERROR
// =====================================================

function getErrorStatus(
    error
) {

    if (
        error?.statusCode &&
        Number.isInteger(
            Number(
                error.statusCode
            )
        )
    ) {

        const status =
            Number(
                error.statusCode
            );


        if (
            status >= 400 &&
            status <= 499
        ) {

            return status;

        }

    }


    if (
        error?.status >= 400 &&
        error?.status <= 499
    ) {

        return error.status;

    }


    return 500;

}


// =====================================================
// PURCHASE AIRTIME
// =====================================================
//
// POST /airtime/purchase
//
// Expected body:
//
// {
//     "phoneNumber": "08012345678",
//     "network": "mtn",
//     "amount": "100"
// }
//
// The validation layer converts:
//
// N100
// ↓
// 10000 kobo
//
// =====================================================

router.post(
    "/purchase",
    getAuthenticationMiddleware(),
    async (
        req,
        res
    ) => {

        /*
         * -------------------------------------------------
         * AUTHENTICATION
         * -------------------------------------------------
         */

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


        /*
         * -------------------------------------------------
         * REQUEST VALIDATION
         * -------------------------------------------------
         *
         * Validation happens before the business service.
         */

        let validated;


        try {

            validated =
                validateAirtimeRequest(
                    req.body
                );

        }

        catch (error) {

            return res.status(
                400
            ).json({

                success:
                    false,

                error:
                    getSafeErrorMessage(
                        error
                    )

            });

        }


        /*
         * -------------------------------------------------
         * EXECUTE AIRTIME PURCHASE
         * -------------------------------------------------
         *
         * The service owns:
         *
         * - transaction creation
         * - wallet reservation
         * - provider call
         * - provider interpretation
         * - wallet commit/release
         * - pending state
         */

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


            /*
             * ------------------------------------------------
             * SUCCESSFUL AIRTIME
             * ------------------------------------------------
             */

            if (
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


            /*
             * ------------------------------------------------
             * PENDING AIRTIME
             * ------------------------------------------------
             *
             * Pending is NOT an error.
             *
             * The frontend must show that the transaction
             * is being processed and must NOT automatically
             * submit another Airtime request.
             */

            if (
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
                        result.status,

                    message:
                        result.message ||
                        "Your Airtime request is being processed. Please do not retry yet."

                });

            }


            /*
             * ------------------------------------------------
             * CONFIRMED FAILURE
             * ------------------------------------------------
             */

            if (
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
                        result.status,

                    message:
                        result.message ||
                        "Airtime could not be completed."

                });

            }


            /*
             * ------------------------------------------------
             * UNKNOWN SERVICE RESULT
             * ------------------------------------------------
             *
             * Never assume success or failure if the service
             * gives an unexpected status.
             */

            return res.status(
                202
            ).json({

                success:
                    false,

                pending:
                    true,

                transactionId:
                    result.transactionId ||
                    null,

                status:
                    "pending",

                message:
                    "Your Airtime request is being verified. Please do not retry yet."

            });

        }

        catch (error) {

            /*
             * ------------------------------------------------
             * IMPORTANT
             * ------------------------------------------------
             *
             * If the service throws after creating a pending
             * transaction, we do not attempt to manually refund
             * anything here.
             *
             * Wallet financial state belongs to the service
             * and reservation layer.
             */

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
// GET AIRTIME TRANSACTION
// =====================================================
//
// GET /airtime/transaction/:transactionId
//
// This allows the authenticated user to check the state
// of their own Airtime transaction.
//
// IMPORTANT:
//
// A user may ONLY retrieve their own transaction.
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
                    "Airtime transaction ID is required."

            });

        }


        try {

            const transaction =
                await airtimeService.getAirtimeTransaction(
                    transactionId
                );


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


            /*
             * ------------------------------------------------
             * OWNERSHIP CHECK
             * ------------------------------------------------
             *
             * Never allow one authenticated user to inspect
             * another user's transaction.
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
                        "Airtime transaction not found."

                });

            }


            /*
             * ------------------------------------------------
             * SAFE FRONTEND RESPONSE
             * ------------------------------------------------
             *
             * Do not expose internal reconciliation fields,
             * provider errors, wallet reservation IDs, or
             * internal accounting information.
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