"use strict";

/**
 * NovaPay Data Service
 *
 * Responsibility:
 * - Validate Data purchase requests.
 * - Resolve the authoritative Data plan from the backend catalog.
 * - Create and manage NovaPay Data transaction records.
 * - Reserve customer wallet funds before provider fulfillment.
 * - Call the provider through an adapter.
 * - Commit only after confirmed provider success.
 * - Release only after confirmed provider failure.
 * - Preserve pending state when provider outcome is unknown.
 * - Prevent duplicate logical purchases where a client reference
 *   is supplied.
 *
 * IMPORTANT:
 * - The client never controls wallet balance.
 * - The client never controls the authoritative plan price.
 * - The client never controls transaction status.
 * - The client never controls provider cost or profit.
 */

const crypto = require("crypto");

const { db } =
    require("../firebase-admin");

const {
    validatePurchaseInput
} = require("./validation");

const {
    findDataPlan
} = require("./catalog");

const {
    reserveFunds,
    commitReservation,
    releaseReservation
} = require("../wallet/reservation");


// =====================================================
// COLLECTIONS
// =====================================================

const TRANSACTIONS_COLLECTION =
    "dataTransactions";


// =====================================================
// CONSTANTS
// =====================================================

const SERVICE =
    "data";

const CURRENCY =
    "NGN";

const STATUS_PENDING =
    "pending";

const STATUS_SUCCESSFUL =
    "successful";

const STATUS_FAILED =
    "failed";

const STATUS_UNKNOWN =
    "unknown";

const MAX_REFERENCE_LENGTH =
    150;

const PROVIDER_NAME =
    "vtu.ng";


// =====================================================
// ERROR HELPER
// =====================================================

function createError(
    message,
    statusCode = 500,
    code = "DATA_SERVICE_ERROR"
) {
    const error =
        new Error(
            message
        );

    error.statusCode =
        statusCode;

    error.code =
        code;

    return error;
}


// =====================================================
// UID
// =====================================================

function requireUid(
    uid
) {
    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {
        throw createError(
            "Authenticated user ID is required.",
            401,
            "AUTHENTICATION_REQUIRED"
        );
    }

    return uid.trim();
}


// =====================================================
// TEXT
// =====================================================

function normalizeText(
    value
) {
    if (
        typeof value !== "string"
    ) {
        return "";
    }

    return value.trim();
}


// =====================================================
// TRANSACTION ID
// =====================================================

function createTransactionId() {

    return (
        "NPDATA_" +
        Date.now() +
        "_" +
        crypto
            .randomBytes(16)
            .toString("hex")
    );

}


// =====================================================
// PROVIDER REQUEST ID
// =====================================================
//
// VTU.ng request_id must remain within the provider's
// maximum allowed length.
//
// The ID is deterministic from the NovaPay transaction.
//
// Same NovaPay transaction:
//
//     transactionId
//          ↓
//     same provider request ID
//
// This allows the provider order to be requeried without
// generating a second provider request ID.
//
// Output:
//
//     ND + 46 hexadecimal characters
//
// Total:
//
//     48 characters
//
// =====================================================

function createProviderRequestId(
    transactionId
) {

    const normalized =
        normalizeText(
            transactionId
        );

    if (
        !normalized
    ) {
        throw createError(
            "Transaction ID is required.",
            500,
            "MISSING_TRANSACTION_ID"
        );
    }

    return (
        "ND" +
        crypto
            .createHash(
                "sha256"
            )
            .update(
                normalized,
                "utf8"
            )
            .digest(
                "hex"
            )
            .slice(
                0,
                46
            )
    );

}


// =====================================================
// REFERENCE
// =====================================================

function normalizeReference(
    value
) {

    const reference =
        normalizeText(
            value
        );

    if (
        !reference
    ) {
        return null;
    }

    if (
        reference.length >
        MAX_REFERENCE_LENGTH
    ) {
        throw createError(
            "Data purchase reference is too long.",
            400,
            "INVALID_REFERENCE"
        );
    }

    if (
        !/^[A-Za-z0-9._:-]+$/.test(
            reference
        )
    ) {
        throw createError(
            "Invalid Data purchase reference.",
            400,
            "INVALID_REFERENCE"
        );
    }

    return reference;

}


// =====================================================
// TRANSACTION REFERENCE
// =====================================================
//
// The NovaPay transaction ID is the internal transaction
// identity.
//
// A client reference is stored separately as a correlation
// / idempotency value.
//
// It is never treated as proof of payment.
// =====================================================

function buildTransactionReference(
    transactionId
) {
    return transactionId;
}


// =====================================================
// INTEGER
// =====================================================

function readSafeInteger(
    value,
    fieldName
) {

    const number =
        Number(
            value
        );

    if (
        !Number.isSafeInteger(
            number
        )
    ) {
        throw new Error(
            `Data transaction field ${fieldName} is invalid.`
        );
    }

    return number;

}


// =====================================================
// TRANSACTION REFERENCE
// =====================================================

function getTransactionRef(
    transactionId
) {

    return db
        .collection(
            TRANSACTIONS_COLLECTION
        )
        .doc(
            transactionId
        );

}


// =====================================================
// FIND TRANSACTION BY CLIENT REFERENCE
// =====================================================
//
// Additional duplicate protection.
//
// If a client deliberately supplies the same reference
// for a retry, the existing Data transaction is returned
// instead of starting another logical purchase.
//
// =====================================================

async function findTransactionByReference({
    uid,
    reference
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    const normalizedReference =
        normalizeReference(
            reference
        );

    if (
        !normalizedReference
    ) {
        return null;
    }

    const snapshot =
        await db
            .collection(
                TRANSACTIONS_COLLECTION
            )
            .where(
                "uid",
                "==",
                authenticatedUid
            )
            .where(
                "clientReference",
                "==",
                normalizedReference
            )
            .limit(
                2
            )
            .get();

    if (
        snapshot.empty
    ) {
        return null;
    }

    if (
        snapshot.size > 1
    ) {
        throw createError(
            "Multiple Data transactions exist for the same reference.",
            409,
            "DUPLICATE_REFERENCE"
        );
    }

    const document =
        snapshot.docs[0];

    return {
        id:
            document.id,

        ...document.data()
    };

}


// =====================================================
// PROVIDER RESULT CLASSIFICATION
// =====================================================
//
// Provider adapters must return:
//
//     success
//     failure
//     unknown
//
// We never infer success merely from HTTP 200.
// =====================================================

function classifyProviderResult(
    providerResult
) {

    if (
        !providerResult ||
        typeof providerResult !==
            "object"
    ) {
        return {
            outcome:
                STATUS_UNKNOWN,

            providerResult:
                null
        };
    }

    const rawOutcome =
        normalizeText(
            providerResult.outcome
        )
            .toLowerCase();

    if (
        rawOutcome ===
            STATUS_SUCCESSFUL ||
        rawOutcome ===
            "success"
    ) {
        return {
            outcome:
                STATUS_SUCCESSFUL,

            providerResult
        };
    }

    if (
        rawOutcome ===
            STATUS_FAILED ||
        rawOutcome ===
            "failure" ||
        rawOutcome ===
            "fail"
    ) {
        return {
            outcome:
                STATUS_FAILED,

            providerResult
        };
    }

    if (
        rawOutcome ===
            STATUS_UNKNOWN ||
        rawOutcome ===
            "pending"
    ) {
        return {
            outcome:
                STATUS_UNKNOWN,

            providerResult
        };
    }

    return {
        outcome:
            STATUS_UNKNOWN,

        providerResult
    };

}


// =====================================================
// PROVIDER COST
// =====================================================
//
// Provider cost must come from the trusted provider
// adapter.
//
// The client can NEVER submit provider cost.
// =====================================================

function normalizeProviderCostKobo(
    providerCostKobo
) {

    if (
        providerCostKobo ===
            null ||
        providerCostKobo ===
            undefined
    ) {
        return null;
    }

    const cost =
        Number(
            providerCostKobo
        );

    if (
        !Number.isSafeInteger(
            cost
        ) ||
        cost < 0
    ) {
        throw createError(
            "Provider returned an invalid Data cost.",
            502,
            "INVALID_PROVIDER_COST"
        );
    }

    return cost;

}


// =====================================================
// GAIN
// =====================================================
//
// Gross provider margin:
//
// customer amount - provider cost
//
// This is NOT net profit.
//
// Paystack fees, operating expenses, refunds, losses,
// taxes, and other costs are separate accounting items.
// =====================================================

function calculateGainKobo(
    amountKobo,
    providerCostKobo
) {

    const amount =
        Number(
            amountKobo
        );

    const providerCost =
        normalizeProviderCostKobo(
            providerCostKobo
        );

    if (
        providerCost ===
            null
    ) {
        return null;
    }

    if (
        !Number.isSafeInteger(
            amount
        ) ||
        amount < 0
    ) {
        return null;
    }

    if (
        providerCost >
        amount
    ) {
        return null;
    }

    return (
        amount -
        providerCost
    );

}


// =====================================================
// TRANSACTION CREATION
// =====================================================
//
// Durable NovaPay transaction is created BEFORE provider
// fulfillment.
//
// This gives us a record of the purchase attempt.
// =====================================================

async function createDataTransaction({
    uid,
    transactionId,
    clientReference,
    plan,
    phoneNumber
}) {

    const now =
        new Date();

    const transactionRef =
        getTransactionRef(
            transactionId
        );

    const existingSnapshot =
        await transactionRef.get();

    if (
        existingSnapshot.exists
    ) {

        const existing =
            existingSnapshot.data();

        if (
            existing.uid !==
            uid
        ) {
            throw createError(
                "Data transaction ownership mismatch.",
                403,
                "TRANSACTION_OWNERSHIP_MISMATCH"
            );
        }

        return {
            id:
                existingSnapshot.id,

            ...existing,

            alreadyExists:
                true
        };

    }

    const providerRequestId =
        createProviderRequestId(
            transactionId
        );

    const transactionData = {

        id:
            transactionId,

        uid,

        service:
            SERVICE,

        type:
            SERVICE,

        status:
            STATUS_PENDING,

        direction:
            "debit",

        currency:
            CURRENCY,

        amountKobo:
            plan.priceKobo,

        clientReference:
            clientReference ||
            null,

        reference:
            buildTransactionReference(
                transactionId
            ),

        network:
            plan.network,

        phoneNumber,

        planId:
            plan.variationId,

        variationId:
            plan.variationId,

        serviceName:
            plan.serviceName,

        dataPlan:
            plan.dataPlan,

        provider:
            PROVIDER_NAME,

        providerRequestId,

        providerReference:
            null,

        providerStatus:
            null,

        providerCode:
            null,

        providerMessage:
            null,

        providerCostKobo:
            null,

        gainKobo:
            null,

        providerOutcome:
            null,

        reconciliationRequired:
            false,

        reservationId:
            null,

        createdAt:
            now,

        updatedAt:
            now,

        completedAt:
            null

    };

    await transactionRef.create(
        transactionData
    );

    return {

        ...transactionData,

        alreadyExists:
            false

    };

}


// =====================================================
// UPDATE TRANSACTION
// =====================================================

async function updateDataTransaction(
    transactionId,
    update
) {

    const transactionRef =
        getTransactionRef(
            transactionId
        );

    await transactionRef.update({

        ...update,

        updatedAt:
            new Date()

    });

}


// =====================================================
// HANDLE PROVIDER SUCCESS
// =====================================================
//
// Only confirmed provider success reaches this function.
//
// Order:
//
//     provider success
//          ↓
//     commit reservation
//          ↓
//     calculate gross margin
//          ↓
//     mark Data transaction successful
//
// =====================================================

async function handleProviderSuccess({
    uid,
    transaction,
    providerResult
}) {

    const providerCostKobo =
        normalizeProviderCostKobo(
            providerResult.providerCostKobo
        );

    if (
        !transaction.reservationId
    ) {
        throw createError(
            "Data transaction has no wallet reservation.",
            500,
            "MISSING_RESERVATION"
        );
    }

    const commitResult =
        await commitReservation({

            uid,

            reservationId:
                transaction.reservationId,

            provider:
                PROVIDER_NAME

        });

    const gainKobo =
        calculateGainKobo(

            transaction.amountKobo,

            providerCostKobo

        );

    const providerMessage =
        normalizeText(
            providerResult.providerMessage
        ) ||
        normalizeText(
            providerResult.message
        ) ||
        null;

    const now =
        new Date();

    await updateDataTransaction(

        transaction.id,

        {

            status:
                STATUS_SUCCESSFUL,

            providerReference:
                normalizeText(
                    providerResult.providerReference
                ) ||
                null,

            providerRequestId:
                normalizeText(
                    providerResult.providerRequestId
                ) ||
                transaction.providerRequestId,

            providerStatus:
                normalizeText(
                    providerResult.providerStatus
                ) ||
                "completed-api",

            providerCode:
                normalizeText(
                    providerResult.providerCode
                ) ||
                null,

            providerMessage,

            providerCostKobo,

            gainKobo,

            providerOutcome:
                STATUS_SUCCESSFUL,

            reconciliationRequired:
                false,

            completedAt:
                now

        }

    );

    return {

        status:
            STATUS_SUCCESSFUL,

        transactionId:
            transaction.id,

        reservationId:
            transaction.reservationId,

        alreadyCommitted:
            commitResult.alreadyCommitted,

        providerReference:
            normalizeText(
                providerResult.providerReference
            ) ||
            null,

        providerCostKobo,

        gainKobo

    };

}


// =====================================================
// HANDLE PROVIDER FAILURE
// =====================================================
//
// Only confirmed provider failure may release customer
// funds.
//
// =====================================================

async function handleProviderFailure({
    uid,
    transaction,
    providerResult
}) {

    if (
        !transaction.reservationId
    ) {
        throw createError(
            "Data transaction has no wallet reservation.",
            500,
            "MISSING_RESERVATION"
        );
    }

    const providerCostKobo =
        normalizeProviderCostKobo(
            providerResult.providerCostKobo
        );

    const releaseResult =
        await releaseReservation({

            uid,

            reservationId:
                transaction.reservationId,

            reason:
                "data_provider_failure"

        });

    const providerMessage =
        normalizeText(
            providerResult.providerMessage
        ) ||
        normalizeText(
            providerResult.message
        ) ||
        null;

    const now =
        new Date();

    await updateDataTransaction(

        transaction.id,

        {

            status:
                STATUS_FAILED,

            providerReference:
                normalizeText(
                    providerResult.providerReference
                ) ||
                null,

            providerRequestId:
                normalizeText(
                    providerResult.providerRequestId
                ) ||
                transaction.providerRequestId,

            providerStatus:
                normalizeText(
                    providerResult.providerStatus
                ) ||
                "failed",

            providerCode:
                normalizeText(
                    providerResult.providerCode
                ) ||
                null,

            providerMessage,

            providerCostKobo,

            gainKobo:
                null,

            providerOutcome:
                STATUS_FAILED,

            reconciliationRequired:
                false,

            completedAt:
                now

        }

    );

    return {

        status:
            STATUS_FAILED,

        transactionId:
            transaction.id,

        reservationId:
            transaction.reservationId,

        alreadyReleased:
            releaseResult.alreadyReleased,

        providerReference:
            normalizeText(
                providerResult.providerReference
            ) ||
            null

    };

}


// =====================================================
// HANDLE UNKNOWN PROVIDER RESULT
// =====================================================
//
// NEVER release the reservation when provider outcome
// is uncertain.
//
// The provider may have fulfilled the Data order even
// though NovaPay did not receive a definitive response.
//
// =====================================================

async function handleUnknownProviderResult({
    transaction,
    providerResult
}) {

    const providerCostKobo =
        normalizeProviderCostKobo(
            providerResult.providerCostKobo
        );

    const providerMessage =
        normalizeText(
            providerResult.providerMessage
        ) ||
        normalizeText(
            providerResult.message
        ) ||
        null;

    await updateDataTransaction(

        transaction.id,

        {

            status:
                STATUS_UNKNOWN,

            providerReference:
                normalizeText(
                    providerResult.providerReference
                ) ||
                null,

            providerRequestId:
                normalizeText(
                    providerResult.providerRequestId
                ) ||
                transaction.providerRequestId,

            providerStatus:
                normalizeText(
                    providerResult.providerStatus
                ) ||
                "unknown",

            providerCode:
                normalizeText(
                    providerResult.providerCode
                ) ||
                null,

            providerMessage,

            providerCostKobo,

            gainKobo:
                null,

            providerOutcome:
                STATUS_UNKNOWN,

            reconciliationRequired:
                true

        }

    );

    return {

        status:
            STATUS_UNKNOWN,

        transactionId:
            transaction.id,

        reservationId:
            transaction.reservationId,

        reconciliationRequired:
            true

    };

}


// =====================================================
// GET EXISTING TRANSACTION
// =====================================================

async function getDataTransaction({
    uid,
    transactionId
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    const normalizedTransactionId =
        normalizeText(
            transactionId
        );

    if (
        !normalizedTransactionId
    ) {
        throw createError(
            "Data transaction ID is required.",
            400,
            "INVALID_TRANSACTION_ID"
        );
    }

    const snapshot =
        await getTransactionRef(
            normalizedTransactionId
        ).get();

    if (
        !snapshot.exists
    ) {
        return null;
    }

    const transaction =
        snapshot.data();

    if (
        transaction.uid !==
        authenticatedUid
    ) {
        throw createError(
            "Data transaction not found.",
            404,
            "TRANSACTION_NOT_FOUND"
        );
    }

    return {

        id:
            snapshot.id,

        ...transaction

    };

}


// =====================================================
// PURCHASE DATA
// =====================================================
//
// Main Data purchase entry point.
//
// The UID must come from verified authentication in the
// route layer.
//
// =====================================================

async function purchaseData({
    uid,
    network,
    phoneNumber,
    planId,
    amountKobo,
    currency,
    reference,
    providerClient
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    /*
     * The provider adapter is injected.
     *
     * This keeps financial logic independent from the
     * provider HTTP implementation.
     */

    if (
        !providerClient ||
        typeof providerClient.purchaseData !==
            "function"
    ) {
        throw createError(
            "Data provider is not configured.",
            500,
            "PROVIDER_NOT_CONFIGURED"
        );
    }

    /*
     * Validate request.
     *
     * The backend catalog remains authoritative for price.
     */

    const input =
        validatePurchaseInput({

            network,

            phoneNumber,

            planId,

            amountKobo,

            currency,

            reference

        });

    /*
     * Check a supplied client reference for an existing
     * logical transaction.
     */

    const existingByReference =
        await findTransactionByReference({

            uid:
                authenticatedUid,

            reference:
                input.reference

        });

    if (
        existingByReference
    ) {

        return {

            success:
                existingByReference.status ===
                STATUS_SUCCESSFUL,

            alreadyExists:
                true,

            transaction:
                existingByReference

        };

    }

    /*
     * Resolve the authoritative Data plan from the
     * backend catalog.
     */

    const plan =
        await findDataPlan(
            input.planId
        );

    if (
        !plan
    ) {
        throw createError(
            "Data plan is no longer available.",
            400,
            "DATA_PLAN_NOT_FOUND"
        );
    }

    /*
     * Network must match the authoritative provider plan.
     */

    if (
        plan.network !==
        input.network
    ) {
        throw createError(
            "Data plan does not belong to the selected network.",
            400,
            "DATA_PLAN_NETWORK_MISMATCH"
        );
    }

    /*
     * Provider catalog must currently mark the plan as
     * available.
     */

    if (
        plan.availability !==
        "available"
    ) {
        throw createError(
            "The selected Data plan is currently unavailable.",
            400,
            "DATA_PLAN_UNAVAILABLE"
        );
    }

    /*
     * CRITICAL PRICE INTEGRITY CHECK.
     *
     * Client amount must exactly match the authoritative
     * backend plan price.
     */

    if (
        input.amountKobo !==
        plan.priceKobo
    ) {
        throw createError(
            "Data plan price has changed. Refresh the Data plans and try again.",
            409,
            "DATA_PRICE_CHANGED"
        );
    }

    /*
     * Create one NovaPay transaction ID.
     */

    const transactionId =
        createTransactionId();

    const transaction =
        await createDataTransaction({

            uid:
                authenticatedUid,

            transactionId,

            clientReference:
                input.reference,

            plan,

            phoneNumber:
                input.phoneNumber

        });

    /*
     * Never start another provider purchase if this
     * transaction already exists.
     */

    if (
        transaction.alreadyExists
    ) {

        return {

            success:
                transaction.status ===
                STATUS_SUCCESSFUL,

            alreadyExists:
                true,

            transaction

        };

    }

    /*
     * Reserve the authoritative plan amount.
     *
     * Wallet reservation performs the actual balance and
     * available-funds check.
     */

    let reservation;

    try {

        reservation =
            await reserveFunds({

                uid:
                    authenticatedUid,

                reference:
                    transaction.reference,

                amountKobo:
                    plan.priceKobo,

                currency:
                    CURRENCY,

                service:
                    SERVICE,

                metadata: {

                    transactionId,

                    network:
                        plan.network,

                    planId:
                        plan.variationId,

                    variationId:
                        plan.variationId

                }

            });

    }

    catch (error) {

        /*
         * No provider request was made because reservation
         * failed.
         */

        await updateDataTransaction(

            transaction.id,

            {

                status:
                    STATUS_FAILED,

                providerOutcome:
                    null,

                providerMessage:
                    "Wallet reservation failed.",

                reconciliationRequired:
                    false,

                completedAt:
                    new Date()

            }

        );

        throw error;

    }

    /*
     * Save reservation ID before contacting VTU.ng.
     */

    await updateDataTransaction(

        transaction.id,

        {

            reservationId:
                reservation.reservationId

        }

    );

    /*
     * Re-read our authoritative transaction state before
     * provider fulfillment.
     */

    const currentTransaction =
        await getDataTransaction({

            uid:
                authenticatedUid,

            transactionId:
                transaction.id

        });

    if (
        !currentTransaction
    ) {
        throw createError(
            "Data transaction disappeared before provider processing.",
            500,
            "TRANSACTION_STATE_ERROR"
        );
    }

    /*
     * Provider request.
     *
     * The adapter communicates with VTU.ng and returns
     * the normalized provider result.
     */

    let providerResult;

    try {

        providerResult =
            await providerClient.purchaseData({

                transactionId:
                    currentTransaction.id,

                providerRequestId:
                    currentTransaction.providerRequestId,

                network:
                    plan.network,

                phoneNumber:
                    currentTransaction.phoneNumber,

                planId:
                    plan.variationId,

                variationId:
                    plan.variationId,

                amountKobo:
                    plan.priceKobo,

                currency:
                    CURRENCY

            });

    }

    catch (error) {

        /*
         * A thrown provider error does NOT automatically
         * mean the provider failed.
         *
         * The request could have reached VTU.ng before the
         * connection failed.
         *
         * Therefore keep the reservation protected.
         */

        const unknownResult = {

            outcome:
                STATUS_UNKNOWN,

            providerReference:
                error?.providerReference ||
                null,

            providerRequestId:
                currentTransaction.providerRequestId,

            providerStatus:
                error?.providerStatus ||
                "unknown",

            providerCode:
                error?.providerCode ||
                "PROVIDER_REQUEST_ERROR",

            providerMessage:
                "Provider outcome could not be confirmed.",

            providerCostKobo:
                null

        };

        return handleUnknownProviderResult({

            transaction:
                currentTransaction,

            providerResult:
                unknownResult

        });

    }

    const classification =
        classifyProviderResult(
            providerResult
        );

    /*
     * Explicit provider success.
     */

    if (
        classification.outcome ===
        STATUS_SUCCESSFUL
    ) {

        return handleProviderSuccess({

            uid:
                authenticatedUid,

            transaction:
                currentTransaction,

            providerResult:
                classification.providerResult

        });

    }

    /*
     * Explicit provider failure.
     */

    if (
        classification.outcome ===
        STATUS_FAILED
    ) {

        return handleProviderFailure({

            uid:
                authenticatedUid,

            transaction:
                currentTransaction,

            providerResult:
                classification.providerResult

        });

    }

    /*
     * Everything else is UNKNOWN.
     *
     * Never guess.
     */

    return handleUnknownProviderResult({

        transaction:
            currentTransaction,

        providerResult:
            classification.providerResult

    });

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = Object.freeze({

    purchaseData,

    getDataTransaction,

    calculateGainKobo

});