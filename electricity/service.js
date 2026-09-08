"use strict";

const crypto = require("crypto");

const { db } =
    require("../firebase-admin");

const {
    reserveFunds,
    commitReservation,
    releaseReservation,
    getReservation
} =
    require("../wallet/reservation");

const {
    METER_TYPES,
    isSupportedElectricityServiceId,
    isSupportedMeterType,
    ELECTRICITY_STATUS,
    RECONCILIATION_STATUS,
    RECONCILIATION_CONFIG,
    ELECTRICITY_MAX_AMOUNT_KOBO
} =
    require("./constants");


// =====================================================
// NOVAPAY — ELECTRICITY SERVICE
// =====================================================
//
// RESPONSIBILITY
//
// This module orchestrates electricity purchases.
//
// Flow:
//
// authenticated route
//        ↓
// validate request
//        ↓
// verify electricity customer
//        ↓
// create transaction
//        ↓
// reserve wallet funds
//        ↓
// link reservation
//        ↓
// purchase electricity
//        ↓
// ┌───────────────┬────────────────┬──────────────────┐
// ↓               ↓                ↓
// SUCCESS       FAILURE          UNKNOWN
// ↓               ↓                ↓
// COMMIT        RELEASE          LOCK FUNDS
// ↓               ↓                ↓
// successful     failed       reconciliation
//
// FINANCIAL RULES:
//
// SUCCESS
//     → commit reservation
//
// DEFINITE FAILURE
//     → release reservation
//
// UNKNOWN / TIMEOUT / NETWORK ERROR
//     → NEVER release
//     → keep reservation locked
//     → reconciliation required
//
// Reconciliation never retries the purchase.
//
// =====================================================


// =====================================================
// COLLECTION
// =====================================================

const TRANSACTIONS_COLLECTION =
    "electricityTransactions";


// =====================================================
// SERVICE CONSTANTS
// =====================================================

const SERVICE =
    "electricity";

const CURRENCY =
    "NGN";

const STATUS_PENDING =
    ELECTRICITY_STATUS.PENDING;

const STATUS_SUCCESS =
    ELECTRICITY_STATUS.SUCCESS;

const STATUS_FAILED =
    ELECTRICITY_STATUS.FAILED;

const STATUS_UNKNOWN =
    ELECTRICITY_STATUS.UNKNOWN;

const STATUS_MANUAL_REVIEW =
    ELECTRICITY_STATUS.MANUAL_REVIEW;

const RECON_NOT_REQUIRED =
    RECONCILIATION_STATUS.NOT_REQUIRED;

const RECON_REQUIRED =
    RECONCILIATION_STATUS.REQUIRED;

const RECON_IN_PROGRESS =
    RECONCILIATION_STATUS.IN_PROGRESS;

const RECON_WAITING =
    RECONCILIATION_STATUS.WAITING;

const RECON_RESOLVED =
    RECONCILIATION_STATUS.RESOLVED;

const RECON_ESCALATED =
    RECONCILIATION_STATUS.ESCALATED;

const PROVIDER =
    "vtu.ng";


// =====================================================
// ERROR FACTORY
// =====================================================

function createError(
    message,
    statusCode = 500
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
            401
        );

    }

    return uid.trim();

}


// =====================================================
// TRANSACTION ID
// =====================================================

function requireTransactionId(
    transactionId
) {

    const normalized =
        String(
            transactionId || ""
        ).trim();

    if (!normalized) {

        throw createError(
            "Electricity transaction ID is required.",
            400
        );

    }

    if (
        normalized.length > 200
    ) {

        throw createError(
            "Electricity transaction ID is too long.",
            400
        );

    }

    return normalized;

}


// =====================================================
// SERVICE ID
// =====================================================

function requireServiceId(
    serviceId
) {

    const normalized =
        String(
            serviceId || ""
        )
            .trim()
            .toLowerCase();

    if (!normalized) {

        throw createError(
            "Electricity distribution service is required.",
            400
        );

    }

    if (
        !isSupportedElectricityServiceId(
            normalized
        )
    ) {

        throw createError(
            "Unsupported electricity distribution service.",
            400
        );

    }

    return normalized;

}


// =====================================================
// METER TYPE
// =====================================================

function requireMeterType(
    meterType
) {

    const normalized =
        String(
            meterType || ""
        )
            .trim()
            .toLowerCase();

    if (!normalized) {

        throw createError(
            "Electricity meter type is required.",
            400
        );

    }

    if (
        !isSupportedMeterType(
            normalized
        )
    ) {

        throw createError(
            "Unsupported electricity meter type.",
            400
        );

    }

    return normalized;

}


// =====================================================
// CUSTOMER / METER NUMBER
// =====================================================

function requireCustomerId(
    customerId
) {

    const normalized =
        String(
            customerId || ""
        ).trim();

    if (!normalized) {

        throw createError(
            "Electricity meter number is required.",
            400
        );

    }

    if (
        normalized.length < 3 ||
        normalized.length > 50
    ) {

        throw createError(
            "Invalid electricity meter number.",
            400
        );

    }

    return normalized;

}


// =====================================================
// AMOUNT
// =====================================================

function validateAmountKobo(
    amountKobo
) {

    const amount =
        Number(
            amountKobo
        );

    if (
        !Number.isSafeInteger(
            amount
        ) ||
        amount <= 0
    ) {

        throw createError(
            "Electricity amount must be a positive integer in kobo.",
            400
        );

    }

    if (
        amount >
        ELECTRICITY_MAX_AMOUNT_KOBO
    ) {

        throw createError(
            "Electricity amount exceeds the maximum allowed amount.",
            400
        );

    }

    return amount;

}


// =====================================================
// CREATE TRANSACTION ID
// =====================================================

function createTransactionId() {

    return (
        "NPELEC_" +
        Date.now() +
        "_" +
        crypto
            .randomBytes(16)
            .toString("hex")
    );

}


// =====================================================
// RESERVATION REFERENCE
// =====================================================

function getReservationReference(
    transactionId
) {

    return requireTransactionId(
        transactionId
    );

}


// =====================================================
// TRANSACTION REF
// =====================================================

function getTransactionRef(
    transactionId
) {

    return db
        .collection(
            TRANSACTIONS_COLLECTION
        )
        .doc(
            requireTransactionId(
                transactionId
            )
        );

}


// =====================================================
// GET TRANSACTION
// =====================================================

async function getElectricityTransaction(
    transactionId
) {

    const ref =
        getTransactionRef(
            transactionId
        );

    const snapshot =
        await ref.get();

    if (
        !snapshot.exists
    ) {

        return null;

    }

    return {

        id:
            snapshot.id,

        ...snapshot.data()

    };

}


// =====================================================
// CREATE INITIAL TRANSACTION
// =====================================================

async function createInitialTransaction({
    uid,
    transactionId,
    serviceId,
    meterType,
    customerId,
    amountKobo,
    verification
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const normalizedServiceId =
        requireServiceId(
            serviceId
        );

    const normalizedMeterType =
        requireMeterType(
            meterType
        );

    const normalizedCustomerId =
        requireCustomerId(
            customerId
        );

    const amount =
        validateAmountKobo(
            amountKobo
        );

    const ref =
        getTransactionRef(
            normalizedTransactionId
        );

    const now =
        new Date();

    const transactionData = {

        id:
            normalizedTransactionId,

        uid:
            authenticatedUid,

        service:
            SERVICE,

        serviceId:
            normalizedServiceId,

        meterType:
            normalizedMeterType,

        customerId:
            normalizedCustomerId,

        amountKobo:
            amount,

        currency:
            CURRENCY,

        status:
            STATUS_PENDING,

        provider:
            PROVIDER,

        providerReference:
            null,

        providerRequestId:
            null,

        providerStatus:
            null,

        providerCode:
            null,

        providerCostKobo:
            null,

        providerOutcome:
            null,

        reservationId:
            null,

        failureReason:
            "",

        reconciliationRequired:
            false,

        reconciliationStatus:
            RECON_NOT_REQUIRED,

        reconciliationAttempts:
            0,

        nextReconciliationAt:
            null,

        lastReconciliationAt:
            null,

        escalatedAt:
            null,

        verification: {

            verified:
                true,

            customerName:
                verification?.customerName ||
                null,

            customerAddress:
                verification?.customerAddress ||
                null,

            accountNumber:
                verification?.accountNumber ||
                null,

            meterNumber:
                verification?.meterNumber ||
                null,

            outstanding:
                verification?.outstanding ??
                null,

            minPurchaseAmount:
                verification?.minPurchaseAmount ??
                null,

            maxPurchaseAmount:
                verification?.maxPurchaseAmount ??
                null

        },

        createdAt:
            now,

        updatedAt:
            now

    };

    await db.runTransaction(
        async firestoreTransaction => {

            const snapshot =
                await firestoreTransaction.get(
                    ref
                );

            if (
                snapshot.exists
            ) {

                const existing =
                    snapshot.data();

                if (
                    existing.uid !==
                    authenticatedUid
                ) {

                    throw createError(
                        "Electricity transaction ownership mismatch.",
                        403
                    );

                }

                if (
                    Number(
                        existing.amountKobo
                    ) !== amount ||
                    String(
                        existing.serviceId ||
                        ""
                    ).toLowerCase() !==
                    normalizedServiceId ||
                    String(
                        existing.meterType ||
                        ""
                    ).toLowerCase() !==
                    normalizedMeterType ||
                    String(
                        existing.customerId ||
                        ""
                    ) !==
                    normalizedCustomerId
                ) {

                    throw createError(
                        "Electricity transaction details do not match the existing transaction.",
                        409
                    );

                }

                return;

            }

            firestoreTransaction.create(
                ref,
                transactionData
            );

        }
    );

    const created =
        await getElectricityTransaction(
            normalizedTransactionId
        );

    if (!created) {

        throw new Error(
            "Electricity transaction could not be created."
        );

    }

    return created;

}


// =====================================================
// UPDATE TRANSACTION
// =====================================================
//
// IMPORTANT:
//
// When a transaction becomes FAILED, this safety layer
// attempts to release its reservation.
//
// releaseReservation() is idempotent and will not release
// a committed reservation.
//
// UNKNOWN transactions are NOT released.
//
// =====================================================

async function updateTransaction(
    transactionId,
    updates
) {

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const ref =
        getTransactionRef(
            normalizedTransactionId
        );

    const existing =
        await getElectricityTransaction(
            normalizedTransactionId
        );

    if (!existing) {

        throw new Error(
            "Electricity transaction not found."
        );

    }

    if (
        updates &&
        updates.status === STATUS_FAILED
    ) {

        if (
            existing.reservationId
        ) {

            await releaseReservation({

                uid:
                    existing.uid,

                reservationId:
                    existing.reservationId,

                reason:
                    "electricity_confirmed_failure"

            });

        }

    }

    const safeUpdates = {

        ...updates,

        updatedAt:
            new Date()

    };

    await ref.update(
        safeUpdates
    );

    return getElectricityTransaction(
        normalizedTransactionId
    );

}


// =====================================================
// CALCULATE NEXT RECONCILIATION
// =====================================================

function calculateNextReconciliationAt(
    attempt
) {

    const normalizedAttempt =
        Number(
            attempt
        );

    const backoffMinutes =
        Array.isArray(
            RECONCILIATION_CONFIG?.BACKOFF_MINUTES
        )
            ? RECONCILIATION_CONFIG.BACKOFF_MINUTES
            : [1, 5, 15, 30, 60];

    const index =
        Math.max(
            0,
            Math.min(
                normalizedAttempt - 1,
                backoffMinutes.length - 1
            )
        );

    const minutes =
        Number(
            backoffMinutes[index]
        );

    const safeMinutes =
        Number.isFinite(
            minutes
        ) && minutes >= 0
            ? minutes
            : 5;

    return new Date(
        Date.now() +
        safeMinutes *
        60 *
        1000
    );

}


// =====================================================
// HANDLE SUCCESS
// =====================================================

async function handleProviderSuccess({
    uid,
    transactionId,
    providerResult
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const transaction =
        await getElectricityTransaction(
            normalizedTransactionId
        );

    if (!transaction) {

        throw new Error(
            "Electricity transaction not found while processing provider success."
        );

    }

    if (
        transaction.uid !==
        authenticatedUid
    ) {

        throw createError(
            "Electricity transaction ownership mismatch.",
            403
        );

    }

    if (
        transaction.status ===
        STATUS_SUCCESS
    ) {

        return {

            status:
                STATUS_SUCCESS,

            transactionId:
                normalizedTransactionId,

            amountKobo:
                transaction.amountKobo,

            serviceId:
                transaction.serviceId,

            meterType:
                transaction.meterType,

            customerId:
                transaction.customerId,

            providerReference:
                transaction.providerReference ||
                null

        };

    }

    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        throw createError(
            "A failed electricity transaction cannot be marked as successful.",
            409
        );

    }

    const reservationId =
        transaction.reservationId;

    if (!reservationId) {

        throw new Error(
            "Electricity transaction has no wallet reservation."
        );

    }

    await commitReservation({

        uid:
            authenticatedUid,

        reservationId,

        provider:
            PROVIDER

    });

    const updated =
        await updateTransaction(
            normalizedTransactionId,
            {

                status:
                    STATUS_SUCCESS,

                providerReference:
                    providerResult?.providerReference ||
                    null,

                providerRequestId:
                    providerResult?.providerRequestId ||
                    null,

                providerStatus:
                    providerResult?.providerStatus ||
                    null,

                providerCode:
                    providerResult?.providerCode ||
                    null,

                providerCostKobo:
                    providerResult?.providerCostKobo ??
                    null,

                providerOutcome:
                    "success",

                reconciliationRequired:
                    false,

                reconciliationStatus:
                    RECON_RESOLVED,

                nextReconciliationAt:
                    null,

                failureReason:
                    ""

            }
        );

    return {

        status:
            STATUS_SUCCESS,

        transactionId:
            normalizedTransactionId,

        amountKobo:
            updated.amountKobo,

        serviceId:
            updated.serviceId,

        meterType:
            updated.meterType,

        customerId:
            updated.customerId,

        providerReference:
            updated.providerReference ||
            null

    };

}


// =====================================================
// HANDLE DEFINITE FAILURE
// =====================================================

async function handleProviderFailure({
    uid,
    transactionId,
    providerResult
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const transaction =
        await getElectricityTransaction(
            normalizedTransactionId
        );

    if (!transaction) {

        throw new Error(
            "Electricity transaction not found while processing provider failure."
        );

    }

    if (
        transaction.uid !==
        authenticatedUid
    ) {

        throw createError(
            "Electricity transaction ownership mismatch.",
            403
        );

    }

    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        return {

            status:
                STATUS_FAILED,

            transactionId:
                normalizedTransactionId,

            amountKobo:
                transaction.amountKobo,

            serviceId:
                transaction.serviceId,

            meterType:
                transaction.meterType,

            customerId:
                transaction.customerId

        };

    }

    if (
        transaction.status ===
        STATUS_SUCCESS
    ) {

        throw createError(
            "A successful electricity transaction cannot be marked as failed.",
            409
        );

    }

    const reservationId =
        transaction.reservationId;

    if (!reservationId) {

        throw new Error(
            "Electricity transaction has no wallet reservation."
        );

    }

    const failureReason =
        String(
            providerResult?.message ||
            "VTU.ng confirmed that the electricity order failed."
        )
            .trim()
            .slice(
                0,
                300
            );

    /*
     * Release first.
     *
     * The transaction is only marked failed after the
     * wallet reservation has successfully been released.
     */

    await releaseReservation({

        uid:
            authenticatedUid,

        reservationId,

        reason:
            "vtu_provider_confirmed_failure"

    });

    const updated =
        await updateTransaction(
            normalizedTransactionId,
            {

                status:
                    STATUS_FAILED,

                providerReference:
                    providerResult?.providerReference ||
                    null,

                providerRequestId:
                    providerResult?.providerRequestId ||
                    null,

                providerStatus:
                    providerResult?.providerStatus ||
                    null,

                providerCode:
                    providerResult?.providerCode ||
                    null,

                providerCostKobo:
                    providerResult?.providerCostKobo ??
                    null,

                providerOutcome:
                    "failure",

                reconciliationRequired:
                    false,

                reconciliationStatus:
                    RECON_RESOLVED,

                nextReconciliationAt:
                    null,

                failureReason

            }
        );

    return {

        status:
            STATUS_FAILED,

        transactionId:
            normalizedTransactionId,

        amountKobo:
            updated.amountKobo,

        serviceId:
            updated.serviceId,

        meterType:
            updated.meterType,

        customerId:
            updated.customerId,

        message:
            failureReason

    };

}


// =====================================================
// HANDLE UNKNOWN
// =====================================================
//
// UNKNOWN means:
//
// - timeout
// - network failure
// - provider unavailable
// - processing-api
// - queued-api
// - initiated-api
// - pending
// - on-hold
// - any other state that cannot safely establish
//   success or failure
//
// NEVER release the reservation here.
//
// =====================================================

async function handleUnknownProviderResult({
    uid,
    transactionId,
    providerResult
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const transaction =
        await getElectricityTransaction(
            normalizedTransactionId
        );

    if (!transaction) {

        throw new Error(
            "Electricity transaction not found while processing provider pending state."
        );

    }

    if (
        transaction.uid !==
        authenticatedUid
    ) {

        throw createError(
            "Electricity transaction ownership mismatch.",
            403
        );

    }

    if (
        transaction.status ===
        STATUS_SUCCESS
    ) {

        return {

            status:
                STATUS_SUCCESS,

            transactionId:
                normalizedTransactionId,

            amountKobo:
                transaction.amountKobo,

            serviceId:
                transaction.serviceId,

            meterType:
                transaction.meterType,

            customerId:
                transaction.customerId

        };

    }

    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        return {

            status:
                STATUS_FAILED,

            transactionId:
                normalizedTransactionId,

            amountKobo:
                transaction.amountKobo,

            serviceId:
                transaction.serviceId,

            meterType:
                transaction.meterType,

            customerId:
                transaction.customerId

        };

    }

    const reservationId =
        transaction.reservationId;

    if (!reservationId) {

        throw new Error(
            "Electricity transaction has no wallet reservation."
        );

    }

    const reservation =
        await getReservation(
            reservationId
        );

    if (
        !reservation
    ) {

        throw new Error(
            "Electricity wallet reservation could not be found."
        );

    }

    if (
        reservation.uid !==
        authenticatedUid
    ) {

        throw createError(
            "Electricity reservation ownership mismatch.",
            403
        );

    }

    /*
     * If the reservation has already been committed,
     * the provider must be considered successful from
     * the wallet's financial perspective.
     */

    if (
        reservation.status ===
        "committed"
    ) {

        return {

            status:
                STATUS_SUCCESS,

            transactionId:
                normalizedTransactionId,

            amountKobo:
                transaction.amountKobo,

            serviceId:
                transaction.serviceId,

            meterType:
                transaction.meterType,

            customerId:
                transaction.customerId

        };

    }

    if (
        reservation.status !==
        "pending"
    ) {

        throw new Error(
            "Electricity reservation is no longer pending."
        );

    }

    const previousAttempts =
        Number(
            transaction.reconciliationAttempts
        );

    const reconciliationAttempts =
        Number.isSafeInteger(
            previousAttempts
        ) &&
        previousAttempts >= 0
            ? previousAttempts
            : 0;

    const nextAttempt =
        reconciliationAttempts + 1;

    const nextReconciliationAt =
        calculateNextReconciliationAt(
            nextAttempt
        );

    const updated =
        await updateTransaction(
            normalizedTransactionId,
            {

                status:
                    STATUS_UNKNOWN,

                providerReference:
                    providerResult?.providerReference ||
                    transaction.providerReference ||
                    null,

                providerRequestId:
                    providerResult?.providerRequestId ||
                    transaction.providerRequestId ||
                    null,

                providerStatus:
                    providerResult?.providerStatus ||
                    transaction.providerStatus ||
                    null,

                providerCode:
                    providerResult?.providerCode ||
                    transaction.providerCode ||
                    null,

                providerCostKobo:
                    providerResult?.providerCostKobo ??
                    transaction.providerCostKobo ??
                    null,

                providerOutcome:
                    "unknown",

                reconciliationRequired:
                    true,

                reconciliationStatus:
                    RECON_REQUIRED,

                reconciliationAttempts:
                    nextAttempt,

                nextReconciliationAt,

                failureReason:
                    ""

            }
        );

    return {

        status:
            STATUS_UNKNOWN,

        transactionId:
            normalizedTransactionId,

        amountKobo:
            updated.amountKobo,

        serviceId:
            updated.serviceId,

        meterType:
            updated.meterType,

        customerId:
            updated.customerId,

        message:
            providerResult?.message ||
            "Your electricity request is being verified. Please do not retry yet."

    };

}


// =====================================================
// NORMALIZE PROVIDER OUTCOME
// =====================================================

function normalizeProviderOutcome(
    result
) {

    const outcome =
        String(
            result?.outcome ||
            ""
        )
            .trim()
            .toLowerCase();

    if (
        outcome ===
        "success"
    ) {

        return "success";

    }

    if (
        outcome ===
        "failure"
    ) {

        return "failure";

    }

    return "unknown";

}


// =====================================================
// PURCHASE ELECTRICITY
// =====================================================

async function purchaseElectricity({
    uid,
    serviceId,
    meterType,
    customerId,
    amountKobo,
    providerClient
}) {

    const authenticatedUid =
        requireUid(
            uid
        );

    const normalizedServiceId =
        requireServiceId(
            serviceId
        );

    const normalizedMeterType =
        requireMeterType(
            meterType
        );

    const normalizedCustomerId =
        requireCustomerId(
            customerId
        );

    const amount =
        validateAmountKobo(
            amountKobo
        );

    if (
        !providerClient ||
        typeof providerClient.verifyElectricityCustomer !==
            "function" ||
        typeof providerClient.purchaseElectricity !==
            "function"
    ) {

        throw new Error(
            "Electricity provider client is not available."
        );

    }


    // =================================================
    // VERIFY CUSTOMER FIRST
    // =================================================

    let verification;

    try {

        verification =
            await providerClient.verifyElectricityCustomer({

                customerId:
                    normalizedCustomerId,

                serviceId:
                    normalizedServiceId,

                meterType:
                    normalizedMeterType

            });

    }

    catch (error) {

        /*
         * Verification failure is not a wallet charge.
         *
         * No reservation exists yet, therefore no money
         * is touched.
         */

        throw error;

    }


    // =================================================
    // CREATE TRANSACTION
    // =================================================

    const transactionId =
        createTransactionId();

    let transaction =
        await createInitialTransaction({

            uid:
                authenticatedUid,

            transactionId,

            serviceId:
                normalizedServiceId,

            meterType:
                normalizedMeterType,

            customerId:
                normalizedCustomerId,

            amountKobo:
                amount,

            verification

        });


    // =================================================
    // RESERVE WALLET FUNDS
    // =================================================

    let reservation;

    try {

        reservation =
            await reserveFunds({

                uid:
                    authenticatedUid,

                reference:
                    getReservationReference(
                        transactionId
                    ),

                amountKobo:
                    amount,

                currency:
                    CURRENCY,

                service:
                    SERVICE,

                metadata: {

                    transactionId,

                    serviceId:
                        normalizedServiceId,

                    meterType:
                        normalizedMeterType,

                    customerId:
                        normalizedCustomerId

                }

            });

    }

    catch (error) {

        const message =
            String(
                error?.message ||
                "Unable to reserve wallet funds."
            )
                .trim()
                .slice(
                    0,
                    300
                );

        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_FAILED,

                providerOutcome:
                    null,

                reconciliationRequired:
                    false,

                reconciliationStatus:
                    RECON_RESOLVED,

                failureReason:
                    message

            }
        );

        throw error;

    }


    // =================================================
    // LINK RESERVATION
    // =================================================

    const reservationId =
        reservation?.id;

    if (!reservationId) {

        throw new Error(
            "Wallet reservation was created without a reservation ID."
        );

    }

    transaction =
        await updateTransaction(
            transactionId,
            {

                reservationId,

                status:
                    STATUS_PENDING

            }
        );


    // =================================================
    // PROVIDER PURCHASE
    // =================================================

    let providerResult;

    try {

        providerResult =
            await providerClient.purchaseElectricity({

                transactionId,

                serviceId:
                    normalizedServiceId,

                meterType:
                    normalizedMeterType,

                customerId:
                    normalizedCustomerId,

                amountKobo:
                    amount

            });

    }

    catch (error) {

        /*
         * PROVIDER OUTCOME IS UNKNOWN.
         *
         * DO NOT RELEASE FUNDS.
         *
         * The request may have reached VTU.ng and the
         * electricity may have been issued even though
         * NovaPay did not receive the response.
         */

        const providerStatus =
            String(
                error?.providerStatus ||
                ""
            )
                .trim()
                .toLowerCase() ||
                null;

        const providerReference =
            error?.providerReference ||
            null;

        const providerCode =
            error?.providerCode ||
            null;

        const nextAttempt =
            Number(
                transaction.reconciliationAttempts || 0
            ) + 1;

        const nextReconciliationAt =
            calculateNextReconciliationAt(
                nextAttempt
            );

        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_UNKNOWN,

                providerReference,

                providerRequestId:
                    error?.providerRequestId ||
                    null,

                providerStatus,

                providerCode,

                providerOutcome:
                    "unknown",

                reconciliationRequired:
                    true,

                reconciliationStatus:
                    RECON_REQUIRED,

                reconciliationAttempts:
                    nextAttempt,

                nextReconciliationAt,

                failureReason:
                    ""

            }
        );

        return {

            status:
                STATUS_UNKNOWN,

            transactionId,

            amountKobo:
                amount,

            serviceId:
                normalizedServiceId,

            meterType:
                normalizedMeterType,

            customerId:
                normalizedCustomerId,

            message:
                "Your electricity request is being verified. Please do not retry yet."

        };

    }


    // =================================================
    // NORMALIZE PROVIDER OUTCOME
    // =================================================

    const outcome =
        normalizeProviderOutcome(
            providerResult
        );


    // =================================================
    // CONFIRMED SUCCESS
    // =================================================

    if (
        outcome ===
        "success"
    ) {

        return handleProviderSuccess({

            uid:
                authenticatedUid,

            transactionId,

            providerResult

        });

    }


    // =================================================
    // CONFIRMED FAILURE
    // =================================================

    if (
        outcome ===
        "failure"
    ) {

        return handleProviderFailure({

            uid:
                authenticatedUid,

            transactionId,

            providerResult

        });

    }


    // =================================================
    // UNKNOWN / PROCESSING
    // =================================================

    return handleUnknownProviderResult({

        uid:
            authenticatedUid,

        transactionId,

        providerResult

    });

}


// =====================================================
// MODULE EXPORTS
// =====================================================

module.exports = {

    purchaseElectricity,

    getElectricityTransaction,

    createInitialTransaction,

    updateTransaction,

    handleProviderSuccess,

    handleProviderFailure,

    handleUnknownProviderResult

};