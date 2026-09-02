"use strict";

const express = require("express");

const {
    purchaseDataForCustomer,
    getTransaction,
    getDataPlans
} = require("./service");

const router = express.Router();

const MAX_BODY_KEYS = 20;

function resolveAuthMiddleware() {
    try {
        const authModule =
            require("../auth");

        if (
            typeof authModule.requireAuth ===
            "function"
        ) {
            return authModule.requireAuth;
        }
    } catch {
        // Authentication middleware will be handled
        // by the explicit configuration check below.
    }

    throw new Error(
        "Data routes could not load the authentication middleware."
    );
}

const requireAuth =
    resolveAuthMiddleware();

function getAuthenticatedUid(
    req
) {
    const uid =
        req?.user?.uid ||
        req?.auth?.uid ||
        req?.firebaseUser?.uid;

    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {
        const error =
            new Error(
                "Authenticated user ID is missing."
            );

        error.code =
            "AUTH_REQUIRED";

        error.statusCode =
            401;

        throw error;
    }

    return uid.trim();
}

function createRouteError(
    message,
    code,
    statusCode = 400
) {
    const error =
        new Error(message);

    error.code =
        code;

    error.statusCode =
        statusCode;

    return error;
}

function validateRequestBody(
    req
) {
    if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
    ) {
        throw createRouteError(
            "Invalid request body.",
            "INVALID_REQUEST_BODY",
            400
        );
    }

    const keys =
        Object.keys(
            req.body
        );

    if (
        keys.length >
        MAX_BODY_KEYS
    ) {
        throw createRouteError(
            "Invalid request body.",
            "INVALID_REQUEST_BODY",
            400
        );
    }

    return req.body;
}

function getStringField(
    body,
    fieldName,
    {
        required = true,
        maxLength = 200
    } = {}
) {
    const value =
        body[fieldName];

    if (
        value === undefined ||
        value === null
    ) {
        if (!required) {
            return null;
        }

        throw createRouteError(
            `${fieldName} is required.`,
            `MISSING_${fieldName
                .toUpperCase()
                .replace(/[^A-Z0-9]+/g, "_")}`,
            400
        );
    }

    if (
        typeof value !== "string"
    ) {
        throw createRouteError(
            `Invalid ${fieldName}.`,
            `INVALID_${fieldName
                .toUpperCase()
                .replace(/[^A-Z0-9]+/g, "_")}`,
            400
        );
    }

    const normalized =
        value.trim();

    if (
        required &&
        !normalized
    ) {
        throw createRouteError(
            `${fieldName} is required.`,
            `MISSING_${fieldName
                .toUpperCase()
                .replace(/[^A-Z0-9]+/g, "_")}`,
            400
        );
    }

    if (
        normalized.length >
        maxLength
    ) {
        throw createRouteError(
            `Invalid ${fieldName}.`,
            `INVALID_${fieldName
                .toUpperCase()
                .replace(/[^A-Z0-9]+/g, "_")}`,
            400
        );
    }

    return normalized || null;
}

function normalizeNetwork(
    value
) {
    const normalized =
        getStringField(
            {
                network: value
            },
            "network",
            {
                required: true,
                maxLength: 20
            }
        );

    const allowed =
        new Set([
            "mtn",
            "airtel",
            "glo",
            "9mobile"
        ]);

    if (
        !allowed.has(
            normalized.toLowerCase()
        )
    ) {
        throw createRouteError(
            "Unsupported network.",
            "INVALID_NETWORK",
            400
        );
    }

    return normalized.toLowerCase();
}

function getSafeCustomerError(
    error
) {
    const safeMessages =
        new Map([
            [
                "AUTH_REQUIRED",
                "Authentication is required."
            ],
            [
                "INVALID_REQUEST_BODY",
                "Invalid request."
            ],
            [
                "MISSING_NETWORK",
                "Please select a network."
            ],
            [
                "INVALID_NETWORK",
                "Please select a valid network."
            ],
            [
                "MISSING_PHONENUMBER",
                "Please enter a valid phone number."
            ],
            [
                "INVALID_PHONENUMBER",
                "Please enter a valid phone number."
            ],
            [
                "MISSING_PLANID",
                "Please select a data plan."
            ],
            [
                "INVALID_PLANID",
                "Please select a valid data plan."
            ],
            [
                "MISSING_REFERENCE",
                "Invalid transaction reference."
            ],
            [
                "INVALID_REFERENCE",
                "Invalid transaction reference."
            ],
            [
                "DATA_PLAN_NOT_FOUND",
                "This data plan is no longer available."
            ],
            [
                "DATA_PLAN_UNAVAILABLE",
                "This data plan is currently unavailable."
            ],
            [
                "DATA_PLAN_CHANGED",
                "This data plan has changed. Please refresh and try again."
            ],
            [
                "DATA_PLAN_PRICE_CHANGED",
                "The price of this data plan has changed. Please refresh and try again."
            ],
            [
                "DATA_PLAN_NETWORK_MISMATCH",
                "The selected data plan does not match the selected network."
            ],
            [
                "DATA_PROVIDER_REJECTED",
                "Data purchase could not be completed."
            ],
            [
                "DATA_RECONCILIATION_REQUIRED",
                "Your data purchase is being confirmed. Please check your transaction history shortly."
            ],
            [
                "DATA_COMMIT_RECONCILIATION_REQUIRED",
                "Your data purchase was received and is being finalized."
            ],
            [
                "INSUFFICIENT_WALLET_BALANCE",
                "Insufficient wallet balance."
            ],
            [
                "WALLET_NOT_FOUND",
                "Your wallet could not be found."
            ],
            [
                "INVALID_AMOUNT",
                "Invalid transaction amount."
            ],
            [
                "RESERVATION_FAILED",
                "Unable to reserve funds for this purchase."
            ]
        ]);

    if (
        error?.code &&
        safeMessages.has(
            error.code
        )
    ) {
        return safeMessages.get(
            error.code
        );
    }

    return "Data purchase could not be completed.";
}

function getStatusCode(
    error
) {
    const statusCode =
        Number(error?.statusCode);

    if (
        Number.isInteger(statusCode) &&
        statusCode >= 400 &&
        statusCode <= 599
    ) {
        return statusCode;
    }

    if (
        error?.code ===
        "AUTH_REQUIRED"
    ) {
        return 401;
    }

    if (
        error?.code ===
        "DATA_PLAN_CHANGED" ||
        error?.code ===
        "DATA_PLAN_PRICE_CHANGED" ||
        error?.code ===
        "DATA_PLAN_UNAVAILABLE" ||
        error?.code ===
        "DATA_PLAN_NOT_FOUND"
    ) {
        return 409;
    }

    return 400;
}

/*
 * GET /api/data/plans
 *
 * Returns the current server-authoritative Data catalog.
 *
 * The frontend may display these plans, but it must
 * send only the plan identity back when purchasing.
 */
router.get(
    "/plans",
    requireAuth,
    async (req, res) => {
        try {
            const forceRefresh =
                req.query?.refresh === "true";

            const plans =
                await getDataPlans({
                    forceRefresh
                });

            return res.status(200).json({
                success: true,
                plans
            });
        } catch (error) {
            console.error(
                "Data catalog error:",
                {
                    code:
                        error?.code ||
                        "UNKNOWN",
                    message:
                        error?.message ||
                        "Unknown error"
                }
            );

            return res.status(503).json({
                success: false,
                error:
                    "Data plans are temporarily unavailable. Please try again later."
            });
        }
    }
);

/*
 * POST /api/data/purchase
 *
 * Expected body:
 *
 * {
 *   "network": "mtn",
 *   "phoneNumber": "08012345678",
 *   "planId": "provider-variation-id",
 *   "reference": "optional-client-reference"
 * }
 *
 * IMPORTANT:
 * There is intentionally NO amount field.
 *
 * The server obtains the authoritative customer price
 * from the Data catalog.
 */
router.post(
    "/purchase",
    requireAuth,
    async (req, res) => {
        try {
            const body =
                validateRequestBody(
                    req
                );

            const network =
                normalizeNetwork(
                    body.network
                );

            const phoneNumber =
                getStringField(
                    body,
                    "phoneNumber",
                    {
                        required: true,
                        maxLength: 30
                    }
                );

            const planId =
                getStringField(
                    body,
                    "planId",
                    {
                        required: true,
                        maxLength: 150
                    }
                );

            const reference =
                getStringField(
                    body,
                    "reference",
                    {
                        required: false,
                        maxLength: 150
                    }
                );

            const uid =
                getAuthenticatedUid(
                    req
                );

            const result =
                await purchaseDataForCustomer({
                    uid,
                    network,
                    phoneNumber,
                    planId,
                    reference
                });

            if (
                result.status ===
                "successful"
            ) {
                return res.status(200).json({
                    success: true,
                    status: "successful",
                    transactionId:
                        result.transactionId,
                    reference:
                        result.reference,
                    plan:
                        result.plan,
                    message:
                        result.message
                });
            }

            if (
                result.status ===
                "pending"
            ) {
                return res.status(202).json({
                    success: false,
                    status: "pending",
                    transactionId:
                        result.transactionId,
                    reference:
                        result.reference,
                    message:
                        result.message
                });
            }

            return res.status(400).json({
                success: false,
                status:
                    result.status ||
                    "failed",
                transactionId:
                    result.transactionId ||
                    null,
                reference:
                    result.reference ||
                    null,
                error:
                    "Data purchase could not be completed."
            });
        } catch (error) {
            console.error(
                "Data purchase error:",
                {
                    code:
                        error?.code ||
                        "UNKNOWN",
                    statusCode:
                        error?.statusCode ||
                        null,
                    message:
                        error?.message ||
                        "Unknown error"
                }
            );

            const statusCode =
                getStatusCode(
                    error
                );

            return res.status(
                statusCode
            ).json({
                success: false,
                error:
                    getSafeCustomerError(
                        error
                    )
            });
        }
    }
);

/*
 * GET /api/data/transactions/:transactionId
 *
 * Customer can only retrieve their own transaction.
 * Ownership is enforced again inside the service.
 */
router.get(
    "/transactions/:transactionId",
    requireAuth,
    async (req, res) => {
        try {
            const uid =
                getAuthenticatedUid(
                    req
                );

            const transactionId =
                getStringField(
                    {
                        transactionId:
                            req.params
                                .transactionId
                    },
                    "transactionId",
                    {
                        required: true,
                        maxLength: 200
                    }
                );

            const transaction =
                await getTransaction(
                    uid,
                    transactionId
                );

            if (!transaction) {
                return res.status(404).json({
                    success: false,
                    error:
                        "Transaction not found."
                });
            }

            return res.status(200).json({
                success: true,
                transaction
            });
        } catch (error) {
            console.error(
                "Data transaction lookup error:",
                {
                    code:
                        error?.code ||
                        "UNKNOWN",
                    message:
                        error?.message ||
                        "Unknown error"
                }
            );

            return res.status(
                getStatusCode(
                    error
                )
            ).json({
                success: false,
                error:
                    getSafeCustomerError(
                        error
                    )
            });
        }
    }
);

module.exports = router;