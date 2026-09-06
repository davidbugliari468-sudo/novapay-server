"use strict";

const express = require("express");

const {
    purchaseData,
    getPurchaseStatus
} = require("./service");

const {
    validateUid
} = require("./validation");

function createDataRouter(requireAuth) {
    if (typeof requireAuth !== "function") {
        throw new Error(
            "createDataRouter requires requireAuth middleware."
        );
    }

    const router = express.Router();

    /*
     * POST /api/data/purchase
     *
     * Customer submits:
     * {
     *   network: "1",
     *   phoneNumber: "08012345678",
     *   planId: "123",
     *   reference: "..."
     * }
     *
     * The server obtains the authoritative plan and
     * price from BabsPay. The client never supplies
     * the amount to debit.
     */
    router.post(
        "/purchase",
        requireAuth,
        async (req, res) => {
            try {
                const uid =
                    req.user &&
                    (
                        req.user.uid ||
                        req.user.userId
                    );

                validateUid(uid);

                const body =
                    req.body || {};

                const result =
                    await purchaseData({
                        uid,
                        network:
                            body.network,
                        phoneNumber:
                            body.phoneNumber,
                        planId:
                            body.planId,
                        reference:
                            body.reference
                    });

                return res.status(
                    result.httpStatus ||
                    200
                ).json({
                    ok:
                        true,

                    status:
                        result.status,

                    transactionId:
                        result.transactionId,

                    reference:
                        result.reference,

                    reservationId:
                        result.reservationId,

                    plan:
                        result.plan,

                    customerPriceKobo:
                        result.customerPriceKobo,

                    message:
                        result.message ||
                        getCustomerMessage(
                            result.status
                        )
                });
            } catch (error) {
                return handleRouteError(
                    res,
                    error
                );
            }
        }
    );

    /*
     * GET /api/data/status/:transactionId
     *
     * Used by the frontend to check a purchase that
     * is pending/unknown without exposing internal
     * provider details.
     */
    router.get(
        "/status/:transactionId",
        requireAuth,
        async (req, res) => {
            try {
                const uid =
                    req.user &&
                    (
                        req.user.uid ||
                        req.user.userId
                    );

                validateUid(uid);

                const transactionId =
                    String(
                        req.params.transactionId ||
                        ""
                    ).trim();

                if (
                    !transactionId ||
                    transactionId.length > 200
                ) {
                    return res.status(400).json({
                        ok:
                            false,
                        error:
                            "Invalid transaction ID."
                    });
                }

                const result =
                    await getPurchaseStatus({
                        uid,
                        transactionId
                    });

                return res.status(
                    200
                ).json({
                    ok:
                        true,

                    status:
                        result.status,

                    transactionId:
                        result.transactionId,

                    reference:
                        result.reference,

                    plan:
                        result.plan,

                    customerPriceKobo:
                        result.customerPriceKobo,

                    message:
                        result.message ||
                        getCustomerMessage(
                            result.status
                        )
                });
            } catch (error) {
                return handleRouteError(
                    res,
                    error
                );
            }
        }
    );

    return router;
}

function getCustomerMessage(
    status
) {
    switch (status) {
        case "successful":
            return "Data purchase successful.";

        case "pending":
            return "Your data purchase is being processed.";

        case "unknown":
            return "Your data purchase is still being verified.";

        case "failed":
        case "reversed":
            return "Data purchase was not completed.";

        default:
            return "Unable to determine the current transaction status.";
    }
}

function handleRouteError(
    res,
    error
) {
    const code =
        error &&
        error.code;

    switch (code) {
        case "INVALID_UID":
        case "INVALID_NETWORK":
        case "INVALID_PHONE":
        case "INVALID_PHONE_NUMBER":
        case "INVALID_PLAN_ID":
        case "INVALID_REFERENCE":
            return res.status(400).json({
                ok:
                    false,
                error:
                    "Invalid Data purchase information."
            });

        case "PLAN_NOT_FOUND":
        case "PLAN_INACTIVE":
        case "PLAN_NETWORK_MISMATCH":
            return res.status(400).json({
                ok:
                    false,
                error:
                    "The selected Data plan is no longer available. Please refresh and try again."
            });

        case "INSUFFICIENT_WALLET_BALANCE":
            return res.status(400).json({
                ok:
                    false,
                error:
                    "Insufficient wallet balance."
            });

        case "RESERVATION_TRANSACTION_MISMATCH":
        case "RESERVATION_METADATA_MISMATCH":
        case "INVALID_RESERVATION_STATE":
        case "MISSING_RESERVATION_ID":
            console.error(
                "Data reservation integrity error:",
                code
            );

            return res.status(500).json({
                ok:
                    false,
                error:
                    "We could not safely complete this transaction. Please try again or contact support."
            });

        case "PROVIDER_AUTH_ERROR":
            console.error(
                "BabsPay authentication error."
            );

            return res.status(503).json({
                ok:
                    false,
                error:
                    "Data service is temporarily unavailable."
            });

        case "PROVIDER_RATE_LIMIT":
            return res.status(503).json({
                ok:
                    false,
                error:
                    "Data service is temporarily busy. Please try again shortly."
            });

        case "PROVIDER_TIMEOUT":
        case "PROVIDER_NETWORK_ERROR":
        case "PROVIDER_REQUERY_UNAVAILABLE":
            return res.status(202).json({
                ok:
                    true,
                status:
                    "unknown",
                message:
                    "Your request is being verified. Please check the transaction status shortly."
            });

        case "PROVIDER_FAILURE":
        case "DATA_PURCHASE_FAILED":
            return res.status(400).json({
                ok:
                    false,
                error:
                    "Data purchase could not be completed."
            });

        case "TRANSACTION_NOT_FOUND":
            return res.status(404).json({
                ok:
                    false,
                error:
                    "Data transaction not found."
            });

        case "UNAUTHORIZED":
        case "FORBIDDEN":
            return res.status(403).json({
                ok:
                    false,
                error:
                    "You are not authorized to access this transaction."
            });

        default:
            console.error(
                "Unhandled Data route error:",
                error &&
                    error.message
                    ? error.message
                    : error
            );

            return res.status(500).json({
                ok:
                    false,
                error:
                    "Unable to process the Data request right now."
            });
    }
}

module.exports = {
    createDataRouter
};