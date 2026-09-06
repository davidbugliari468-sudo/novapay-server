"use strict";

const crypto = require("crypto");
const { db } = require("../firebase-admin");

const babspay = require("./provider/babspay");
const {
    validatePurchaseInput,
    validateUid
} = require("./validation");
const {
    requirePlan
} = require("./catalog");

const {
    reserveFunds,
    getReservation,
    commitReservation,
    releaseReservation
} = require("../wallet/reservation");

const DATA_TRANSACTIONS_COLLECTION =
    "dataTransactions";

const SERVICE_NAME = "data";
const CURRENCY = "NGN";

const STATUS_PENDING = "pending";
const STATUS_SUCCESSFUL = "successful";
const STATUS_FAILED = "failed";
const STATUS_UNKNOWN = "unknown";
const STATUS_REVERSED = "reversed";

const MAX_PHONE_LENGTH = 15;
const MAX_REFERENCE_LENGTH = 150;

const CUSTOMER_MARKUP_KOBO = parseNonNegativeIntegerEnv(
    "DATA_CUSTOMER_MARKUP_KOBO",
    0
);

const MAX_CUSTOMER_PRICE_KOBO =
    parsePositiveIntegerEnv(
        "MAX_DATA_CUSTOMER_PRICE_KOBO",
        5_000_000
    );

function parseNonNegativeIntegerEnv(
    name,
    fallback
) {
    const raw = process.env[name];

    if (
        raw === undefined ||
        raw === null ||
        raw === ""
    ) {
        return fallback;
    }

    const value =
        Number.parseInt(
            String(raw).trim(),
            10
        );

    if (
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw new Error(
            `Invalid ${name} configuration`
        );
    }

    return value;
}

function parsePositiveIntegerEnv(
    name,
    fallback
) {
    const raw = process.env[name];

    if (
        raw === undefined ||
        raw === null ||
        raw === ""
    ) {
        return fallback;
    }

    const value =
        Number.parseInt(
            String(raw).trim(),
            10
        );

    if (
        !Number.isSafeInteger(value) ||
        value <= 0
    ) {
        throw new Error(
            `Invalid ${name} configuration`
        );
    }

    return value;
}

function createError(
    message,
    code = "DATA_SERVICE_ERROR"
) {
    const error =
        new Error(message);

    error.code = code;

    return error;
}

function normalizeReference(
    reference
) {
    const value =
        String(reference ?? "")
            .trim();

    if (!value) {
        throw createError(
            "Transaction reference is required.",
            "INVALID_REFERENCE"
        );
    }

    if (
        value.length >
        MAX_REFERENCE_LENGTH
    ) {
        throw createError(
            "Transaction reference is too long.",
            "INVALID_REFERENCE"
        );
    }

    return value;
}

function normalizePhone(
    phoneNumber
) {
    const value =
        String(phoneNumber ?? "")
            .trim()
            .replace(
                /[\s().-]/g,
                ""
            );

    if (!value) {
        throw createError(
            "Recipient phone number is required.",
            "INVALID_PHONE"
        );
    }

    if (
        value.length >
        MAX_PHONE_LENGTH
    ) {
        throw createError(
            "Recipient phone number is invalid.",
            "INVALID_PHONE"
        );
    }

    return value;
}

function calculateCustomerPriceKobo(
    providerPriceKobo
) {
    if (
        !Number.isSafeInteger(
            providerPriceKobo
        ) ||
        providerPriceKobo <= 0
    ) {
        throw createError(
            "Invalid provider plan price.",
            "INVALID_PROVIDER_PRICE"
        );
    }

    const customerPriceKobo =
        providerPriceKobo +
        CUSTOMER_MARKUP_KOBO;

    if (
        !Number.isSafeInteger(
            customerPriceKobo
        ) ||
        customerPriceKobo <= 0
    ) {
        throw createError(
            "Invalid customer plan price.",
            "INVALID_CUSTOMER_PRICE"
        );
    }

    if (
        customerPriceKobo >
        MAX_CUSTOMER_PRICE_KOBO
    ) {
        throw createError(
            "Data plan price exceeds the configured limit.",
            "CUSTOMER_PRICE_LIMIT_EXCEEDED"
        );
    }

    return customerPriceKobo;
}

function createTransactionId(
    reservationId
) {
    return `DATA_${reservationId}`;
}

function getTransactionRef(
    transactionId
) {
    return db
        .collection(
            DATA_TRANSACTIONS_COLLECTION
        )
        .doc(transactionId);
}

function createAuditId() {
    return (
        "AUD_" +
        Date.now().toString(36) +
        "_" +
        crypto
            .randomBytes(8)
            .toString("hex")
    );
}

function sanitizeProviderReference(
    value
) {
    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    const normalized =
        String(value).trim();

    if (!normalized) {
        return null;
    }

    return normalized.slice(
        0,
        200
    );
}

function normalizeProviderOutcome(
    result
) {
    if (
        !result ||
        typeof result !== "object"
    ) {
        return {
            outcome: STATUS_UNKNOWN,
            providerReference: null,
            message:
                "Invalid provider response."
        };
    }

    const outcome =
        String(
            result.outcome || ""
        )
            .trim()
            .toLowerCase();

    const providerReference =
        sanitizeProviderReference(
            result.providerReference ||
            result.ref ||
            result.reference ||
            null
        );

    const message =
        String(
            result.message ||
            result.msg ||
            ""
        )
            .trim()
            .slice(0, 500);

    if (
        outcome ===
            STATUS_SUCCESSFUL ||
        outcome === "success"
    ) {
        if (!providerReference) {
            return {
                outcome:
                    STATUS_UNKNOWN,
                providerReference:
                    null,
                message:
                    "Provider reported success without a provider reference."
            };
        }

        return {
            outcome:
                STATUS_SUCCESSFUL,
            providerReference,
            message
        };
    }

    if (
        outcome === STATUS_FAILED ||
        outcome === "failure" ||
        outcome === "fail"
    ) {
        return {
            outcome:
                STATUS_FAILED,
            providerReference,
            message
        };
    }

    if (
        outcome === STATUS_PENDING ||
        outcome === "processing" ||
        outcome === "queued"
    ) {
        return {
            outcome:
                STATUS_PENDING,
            providerReference,
            message
        };
    }

    if (
        outcome === STATUS_REVERSED ||
        outcome === "reverse"
    ) {
        return {
            outcome:
                STATUS_REVERSED,
            providerReference,
            message
        };
    }

    return {
        outcome:
            STATUS_UNKNOWN,
        providerReference,
        message
    };
}

async function createTransactionRecord({
    transactionId,
    uid,
    reference,
    phoneNumber,
    plan,
    customerPriceKobo,
    reservationId
}) {
    const transactionRef =
        getTransactionRef(
            transactionId
        );

    const now =
        new Date();

    const record = {
        id:
            transactionId,

        uid,

        reference,

        reservationId,

        service:
            SERVICE_NAME,

        status:
            STATUS_PENDING,

        currency:
            CURRENCY,

        customerPriceKobo,

        providerPriceKobo:
            plan.priceKobo,

        networkId:
            plan.networkId,

        networkName:
            plan.networkName,

        planId:
            plan.planId,

        planCode:
            plan.planCode,

        planName:
            plan.planName,

        planType:
            plan.planType,

        validity:
            plan.validity,

        phoneNumber,

        provider:
            "babspay",

        providerReference:
            null,

        providerMessage:
            null,

        createdAt:
            now,

        updatedAt:
            now,

        completedAt:
            null,

        reconciliationRequired:
            false
    };

    await transactionRef.create(
        record
    );

    return record;
}

async function updateTransactionRecord({
    transactionId,
    updates
}) {
    const transactionRef =
        getTransactionRef(
            transactionId
        );

    await transactionRef.update({
        ...updates,
        updatedAt:
            new Date()
    });
}

async function getTransactionRecord(
    transactionId
) {
    const transactionRef =
        getTransactionRef(
            transactionId
        );

    const snapshot =
        await transactionRef.get();

    if (!snapshot.exists) {
        throw createError(
            "Data transaction was not found.",
            "DATA_TRANSACTION_NOT_FOUND"
        );
    }

    return {
        id:
            snapshot.id,
        ...snapshot.data()
    };
}

async function purchaseData({
    uid,
    network,
    phoneNumber,
    planId,
    reference,
    type = null
}) {
    const authenticatedUid =
        validateUid(uid);

    const normalizedReference =
        normalizeReference(
            reference
        );

    const normalizedPhone =
        normalizePhone(
            phoneNumber
        );

    const validated =
        validatePurchaseInput({
            network,
            phoneNumber:
                normalizedPhone,
            planId,
            reference:
                normalizedReference
        });

    /*
     * Always resolve the plan from the server-side
     * BabsPay catalogue.
     *
     * The frontend never supplies the amount.
     */
    const plan =
        await requirePlan(
            validated.planId,
            {
                network:
                    validated.network,
                type:
                    type || undefined,
                forceRefresh:
                    true
            }
        );

    const customerPriceKobo =
        calculateCustomerPriceKobo(
            plan.priceKobo
        );

    /*
     * Reserve the exact customer amount BEFORE
     * contacting BabsPay.
     *
     * The provider price and selected plan are stored
     * inside reservation metadata so reconciliation can
     * later verify what was purchased.
     */
    const reservation =
        await reserveFunds({
            uid:
                authenticatedUid,

            reference:
                normalizedReference,

            amountKobo:
                customerPriceKobo,

            currency:
                CURRENCY,

            service:
                SERVICE_NAME,

            metadata: {
                provider:
                    "babspay",

                planId:
                    plan.planId,

                planCode:
                    plan.planCode,

                networkId:
                    plan.networkId,

                networkName:
                    plan.networkName,

                planName:
                    plan.planName,

                planType:
                    plan.planType,

                validity:
                    plan.validity,

                providerPriceKobo:
                    plan.priceKobo,

                customerPriceKobo,

                phoneNumber:
                    normalizedPhone
            }
        });

    /*
     * If a previous request already created this
     * reservation, do not create another financial
     * transaction.
     */
    const transactionId =
        createTransactionId(
            reservation.id
        );

    let transactionRecord;

    try {
        transactionRecord =
            await getTransactionRecord(
                transactionId
            );
    } catch (error) {
        if (
            error.code !==
            "DATA_TRANSACTION_NOT_FOUND"
        ) {
            throw error;
        }

        transactionRecord =
            await createTransactionRecord({
                transactionId,
                uid:
                    authenticatedUid,
                reference:
                    normalizedReference,
                phoneNumber:
                    normalizedPhone,
                plan,
                customerPriceKobo,
                reservationId:
                    reservation.id
            });
    }

    /*
     * A committed reservation means the provider
     * transaction was already finalized successfully.
     */
    if (
        reservation.status ===
        "committed"
    ) {
        return {
            ok:
                true,

            status:
                STATUS_SUCCESSFUL,

            transactionId,

            reservationId:
                reservation.id,

            reference:
                normalizedReference,

            plan: {
                planId:
                    plan.planId,

                networkId:
                    plan.networkId,

                networkName:
                    plan.networkName,

                planName:
                    plan.planName,

                planType:
                    plan.planType,

                validity:
                    plan.validity
            },

            amountKobo:
                customerPriceKobo,

            providerReference:
                transactionRecord
                    .providerReference ||
                null
        };
    }

    /*
     * A released reservation must never be reused.
     */
    if (
        reservation.status ===
        "released"
    ) {
        throw createError(
            "This Data purchase request has already been released.",
            "RESERVATION_ALREADY_RELEASED"
        );
    }

    /*
     * If the transaction is already terminal,
     * return the stored state instead of purchasing
     * again.
     */
    if (
        transactionRecord.status ===
            STATUS_SUCCESSFUL ||
        transactionRecord.status ===
            STATUS_FAILED
    ) {
        return {
            ok:
                transactionRecord.status ===
                STATUS_SUCCESSFUL,

            status:
                transactionRecord.status,

            transactionId,

            reservationId:
                reservation.id,

            reference:
                normalizedReference,

            providerReference:
                transactionRecord
                    .providerReference ||
                null
        };
    }

    let providerResult;

    try {
        /*
         * IMPORTANT:
         *
         * The provider adapter is responsible for
         * translating these internal fields into the
         * exact BabsPay request:
         *
         * network
         * phone
         * ref
         * data_plan
         */
        providerResult =
            await babspay.purchaseData({
                network:
                    plan.networkId,

                phone:
                    normalizedPhone,

                reference:
                    normalizedReference,

                planId:
                    plan.planId
            });
    } catch (error) {
        /*
         * We do NOT release here.
         *
         * A network timeout / connection failure does
         * not tell us whether BabsPay processed the
         * transaction.
         *
         * The reservation therefore remains pending
         * until reconciliation rechecks BabsPay.
         */
        await updateTransactionRecord({
            transactionId,
            updates: {
                status:
                    STATUS_UNKNOWN,

                providerMessage:
                    "Provider response could not be confirmed.",

                reconciliationRequired:
                    true
            }
        });

        return {
            ok:
                false,

            status:
                STATUS_UNKNOWN,

            transactionId,

            reservationId:
                reservation.id,

            reference:
                normalizedReference,

            message:
                "Your Data purchase is being verified. Please do not retry yet."
        };
    }

    const outcome =
        normalizeProviderOutcome(
            providerResult
        );

    if (
        outcome.outcome ===
        STATUS_SUCCESSFUL
    ) {
        /*
         * Provider explicitly confirmed success.
         *
         * Only NOW do we debit the customer's wallet.
         */
        const committed =
            await commitReservation({
                uid:
                    authenticatedUid,

                reservationId:
                    reservation.id,

                provider:
                    "babspay"
            });

        await updateTransactionRecord({
            transactionId,
            updates: {
                status:
                    STATUS_SUCCESSFUL,

                providerReference:
                    outcome.providerReference,

                providerMessage:
                    outcome.message ||
                    "Data purchase successful.",

                reconciliationRequired:
                    false,

                completedAt:
                    new Date(),

                walletReservationStatus:
                    committed.status
            }
        });

        return {
            ok:
                true,

            status:
                STATUS_SUCCESSFUL,

            transactionId,

            reservationId:
                reservation.id,

            reference:
                normalizedReference,

            amountKobo:
                customerPriceKobo,

            plan: {
                planId:
                    plan.planId,

                networkId:
                    plan.networkId,

                networkName:
                    plan.networkName,

                planName:
                    plan.planName,

                planType:
                    plan.planType,

                validity:
                    plan.validity
            },

            providerReference:
                outcome.providerReference
        };
    }

    if (
        outcome.outcome ===
        STATUS_FAILED ||
        outcome.outcome ===
        STATUS_REVERSED
    ) {
        /*
         * Only an explicit provider failure/reversal
         * allows the reservation to be released.
         */
        const released =
            await releaseReservation({
                uid:
                    authenticatedUid,

                reservationId:
                    reservation.id,

                reason:
                    outcome.message ||
                    (
                        outcome.outcome ===
                        STATUS_REVERSED
                            ? "Provider reversed Data transaction."
                            : "Provider rejected Data transaction."
                    ),

                provider:
                    "babspay"
            });

        await updateTransactionRecord({
            transactionId,
            updates: {
                status:
                    STATUS_FAILED,

                providerReference:
                    outcome.providerReference,

                providerMessage:
                    outcome.message ||
                    "Data purchase failed.",

                reconciliationRequired:
                    false,

                completedAt:
                    new Date(),

                walletReservationStatus:
                    released.status
            }
        });

        return {
            ok:
                false,

            status:
                STATUS_FAILED,

            transactionId,

            reservationId:
                reservation.id,

            reference:
                normalizedReference,

            providerReference:
                outcome.providerReference,

            message:
                "The Data purchase could not be completed. Your wallet was not charged."
        };
    }

    /*
     * Pending or unknown means:
     *
     * DO NOT debit.
     * DO NOT release.
     * DO NOT let the customer retry with the same
     * reference.
     *
     * Reconciliation must determine the final result.
     */
    await updateTransactionRecord({
        transactionId,
        updates: {
            status:
                outcome.outcome ===
                STATUS_PENDING
                    ? STATUS_PENDING
                    : STATUS_UNKNOWN,

            providerReference:
                outcome.providerReference,

            providerMessage:
                outcome.message ||
                "Provider transaction requires verification.",

            reconciliationRequired:
                true
        }
    });

    return {
        ok:
            false,

        status:
            outcome.outcome ===
            STATUS_PENDING
                ? STATUS_PENDING
                : STATUS_UNKNOWN,

        transactionId,

        reservationId:
            reservation.id,

        reference:
            normalizedReference,

        providerReference:
            outcome.providerReference,

        message:
            "Your Data purchase is being processed. Please do not retry yet."
    };
}

async function getPurchaseStatus({
    uid,
    reservationId
}) {
    const authenticatedUid =
        validateUid(uid);

    const reservation =
        await getReservation(
            reservationId
        );

    if (
        reservation.uid !==
        authenticatedUid
    ) {
        throw createError(
            "Transaction ownership mismatch.",
            "TRANSACTION_OWNERSHIP_ERROR"
        );
    }

    const transactionId =
        createTransactionId(
            reservation.id
        );

    let transaction;

    try {
        transaction =
            await getTransactionRecord(
                transactionId
            );
    } catch (error) {
        if (
            error.code ===
            "DATA_TRANSACTION_NOT_FOUND"
        ) {
            return {
                ok:
                    true,

                status:
                    reservation.status,

                reservationId:
                    reservation.id,

                reference:
                    reservation.reference
            };
        }

        throw error;
    }

    return {
        ok:
            transaction.status ===
            STATUS_SUCCESSFUL,

        status:
            transaction.status,

        transactionId,

        reservationId:
            reservation.id,

        reference:
            transaction.reference,

        providerReference:
            transaction.providerReference ||
            null,

        plan: {
            planId:
                transaction.planId,

            planName:
                transaction.planName,

            networkId:
                transaction.networkId,

            networkName:
                transaction.networkName,

            validity:
                transaction.validity
        },

        amountKobo:
            transaction.customerPriceKobo
    };
}

module.exports = {
    purchaseData,
    getPurchaseStatus,
    calculateCustomerPriceKobo
};