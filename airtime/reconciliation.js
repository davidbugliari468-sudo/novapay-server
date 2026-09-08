// airtime/reconciliation.js

"use strict";

const {
    db
} = require("../firebase-admin");

const {
    commitReservation,
    releaseReservation,
    getReservation
} = require("../wallet/reservation");

const {
    getAirtimeTransaction
} = require("./service");


// =====================================================
// NOVAPAY — AIRTIME RECONCILIATION SERVICE
// =====================================================
//
// RESPONSIBILITY
//
// This module resolves Airtime transactions whose provider
// result was UNKNOWN.
//
// FINANCIAL RULE:
//
// UNKNOWN NEVER means FAILURE.
//
// Only an explicit provider success may commit funds.
//
// Only an explicit provider failure may release funds.
//
// Reconciliation NEVER retries the original purchase.
//
// =====================================================


// =====================================================
// COLLECTION
// =====================================================

const TRANSACTIONS_COLLECTION =
    "airtimeTransactions";


// =====================================================
// CONSTANTS
// =====================================================

const SERVICE =
    "airtime";

const STATUS_PENDING =
    "pending";

const STATUS_SUCCESSFUL =
    "successful";

const STATUS_FAILED =
    "failed";

const RESERVATION_PENDING =
    "pending";

const RESERVATION_COMMITTED =
    "committed";

const RESERVATION_RELEASED =
    "released";


// =====================================================
// RECONCILIATION STATES
// =====================================================
//
// These describe the reconciliation process.
//
// They do NOT replace the financial transaction status.
//
// =====================================================

const RECONCILIATION_REQUIRED =
    "required";

const RECONCILIATION_IN_PROGRESS =
    "in_progress";

const RECONCILIATION_ESCALATED =
    "escalated";


// =====================================================
// RETRY POLICY
// =====================================================
//
// Unknown transactions remain financially locked.
//
// These values control how frequently the provider is
// rechecked.
//
// The delay increases gradually and is capped.
//
// Example:
//
// attempt 1 -> 1 minute
// attempt 2 -> 2 minutes
// attempt 3 -> 5 minutes
// attempt 4 -> 10 minutes
// attempt 5 -> 20 minutes
// later     -> maximum 60 minutes
//
// =====================================================

const RECONCILIATION_BASE_DELAY_MS =
    60 * 1000;

const RECONCILIATION_MAX_DELAY_MS =
    60 * 60 * 1000;


// =====================================================
// ESCALATION POLICY
// =====================================================
//
// Escalation is NOT a refund.
//
// Escalation means automatic reconciliation pauses and
// the transaction requires controlled/manual investigation.
//
// THE RESERVATION REMAINS LOCKED.
//
// =====================================================

const RECONCILIATION_MAX_ATTEMPTS =
    20;

const RECONCILIATION_MAX_AGE_MS =
    24 * 60 * 60 * 1000;


// =====================================================
// RECONCILIATION LEASE
// =====================================================
//
// Prevents two worker instances from querying the same
// transaction simultaneously.
//
// The lease is only a processing lock.
//
// It has NO financial effect.
//
// =====================================================

const RECONCILIATION_LEASE_MS =
    2 * 60 * 1000;


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
// VALIDATE UID
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
// VALIDATE TRANSACTION ID
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
            "Airtime transaction ID is required.",
            400
        );

    }


    if (
        normalized.length >
        200
    ) {

        throw createError(
            "Airtime transaction ID is too long.",
            400
        );

    }


    return normalized;

}


// =====================================================
// GET TRANSACTION REFERENCE
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
// NORMALIZE PROVIDER OUTCOME
// =====================================================
//
// Only three internal outcomes are accepted:
//
// success
// failure
// unknown
//
// Anything else becomes unknown.
//
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
// NORMALIZE PROVIDER MESSAGE
// =====================================================

function normalizeProviderMessage(
    result,
    fallback
) {

    return String(
        result?.message ||
        fallback
    )
        .trim()
        .slice(
            0,
            300
        );

}


// =====================================================
// NORMALIZE PROVIDER STRING
// =====================================================

function normalizeProviderString(
    value
) {

    if (
        value ===
        undefined ||
        value ===
        null
    ) {

        return null;

    }


    const normalized =
        String(
            value
        )
            .trim()
            .slice(
                0,
                200
            );


    return normalized ||
        null;

}


// =====================================================
// DATE -> MILLISECONDS
// =====================================================
//
// Supports:
//
// Date
// Firestore Timestamp
// ISO string
// numeric timestamp
//
// =====================================================

function toMillis(
    value
) {

    if (!value) {

        return 0;

    }


    if (
        typeof value ===
        "number" &&
        Number.isFinite(
            value
        )
    ) {

        return value;

    }


    if (
        value instanceof Date
    ) {

        const milliseconds =
            value.getTime();


        return Number.isFinite(
            milliseconds
        )
            ? milliseconds
            : 0;

    }


    if (
        typeof value.toMillis ===
        "function"
    ) {

        const milliseconds =
            value.toMillis();


        return Number.isFinite(
            milliseconds
        )
            ? milliseconds
            : 0;

    }


    if (
        typeof value ===
        "string"
    ) {

        const milliseconds =
            Date.parse(
                value
            );


        return Number.isFinite(
            milliseconds
        )
            ? milliseconds
            : 0;

    }


    return 0;

}


// =====================================================
// CALCULATE RETRY DELAY
// =====================================================

function calculateReconciliationDelay(
    attempt
) {

    const normalizedAttempt =
        Number.isInteger(
            attempt
        ) &&
        attempt > 0
            ? attempt
            : 1;


    const multiplier =
        Math.pow(
            2,
            Math.min(
                normalizedAttempt - 1,
                6
            )
        );


    return Math.min(
        RECONCILIATION_BASE_DELAY_MS *
            multiplier,
        RECONCILIATION_MAX_DELAY_MS
    );

}


// =====================================================
// CALCULATE NEXT RECONCILIATION TIME
// =====================================================

function calculateNextReconciliationAt(
    attempt
) {

    return new Date(
        Date.now() +
        calculateReconciliationDelay(
            attempt
        )
    );

}


// =====================================================
// DETERMINE WHETHER TRANSACTION IS TOO OLD
// =====================================================

function isOlderThanMaximumAge(
    transaction
) {

    const createdAtMillis =
        toMillis(
            transaction?.createdAt
        );


    if (
        createdAtMillis <= 0
    ) {

        return false;

    }


    return (
        Date.now() -
        createdAtMillis
    ) >
    RECONCILIATION_MAX_AGE_MS;

}


// =====================================================
// GET CURRENT RECONCILIATION ATTEMPT
// =====================================================

function getReconciliationAttempts(
    transaction
) {

    const attempts =
        Number(
            transaction?.reconciliationAttempts
        );


    if (
        !Number.isSafeInteger(
            attempts
        ) ||
        attempts < 0
    ) {

        return 0;

    }


    return attempts;

}


// =====================================================
// DETERMINE WHETHER RECONCILIATION IS DUE
// =====================================================

function isReconciliationDue(
    transaction
) {

    /*
     * Existing transactions may not have
     * nextReconciliationAt.
     *
     * Such transactions are immediately eligible.
     */

    if (
        !transaction?.nextReconciliationAt
    ) {

        return true;

    }


    const nextAt =
        toMillis(
            transaction.nextReconciliationAt
        );


    if (
        nextAt <= 0
    ) {

        return true;

    }


    return Date.now() >=
        nextAt;

}


// =====================================================
// UPDATE TRANSACTION
// =====================================================
//
// This function changes only the Airtime business record.
//
// Wallet accounting remains inside reservation.js.
//
// =====================================================

async function updateTransaction(
    transactionId,
    updates
) {

    const ref =
        getTransactionRef(
            transactionId
        );


    await ref.update({

        ...updates,

        updatedAt:
            new Date()

    });


    return getAirtimeTransaction(
        transactionId
    );

}


// =====================================================
// CLAIM RECONCILIATION LEASE
// =====================================================
//
// This is atomic.
//
// Only one worker can successfully claim the current
// reconciliation lease.
//
// If another worker already holds a valid lease, this
// function returns null.
//
// No wallet operation happens here.
//
// =====================================================

async function claimReconciliationLease(
    transactionId
) {

    const ref =
        getTransactionRef(
            transactionId
        );


    const leaseUntil =
        new Date(
            Date.now() +
            RECONCILIATION_LEASE_MS
        );


    return db.runTransaction(
        async firestoreTransaction => {

            const snapshot =
                await firestoreTransaction.get(
                    ref
                );


            if (
                !snapshot.exists
            ) {

                throw createError(
                    "Airtime transaction not found.",
                    404
                );

            }


            const transaction =
                {
                    id:
                        snapshot.id,

                    ...snapshot.data()

                };


            if (
                transaction.status !==
                STATUS_PENDING
            ) {

                return null;

            }


            if (
                transaction.reconciliationRequired !==
                true
            ) {

                return null;

            }


            const existingLease =
                toMillis(
                    transaction.reconciliationLeaseUntil
                );


            if (
                existingLease >
                Date.now()
            ) {

                return null;

            }


            firestoreTransaction.update(
                ref,
                {

                    reconciliationStatus:
                        RECONCILIATION_IN_PROGRESS,

                    reconciliationLeaseUntil:
                        leaseUntil,

                    reconciliationStartedAt:
                        new Date(),

                    updatedAt:
                        new Date()

                }
            );


            return {

                ...transaction,

                reconciliationStatus:
                    RECONCILIATION_IN_PROGRESS,

                reconciliationLeaseUntil:
                    leaseUntil

            };

        }
    );

}


// =====================================================
// CLEAR RECONCILIATION LEASE
// =====================================================
//
// This never changes wallet state.
//
// =====================================================

async function clearReconciliationLease(
    transactionId,
    extraUpdates = {}
) {

    await updateTransaction(
        transactionId,
        {

            reconciliationLeaseUntil:
                null,

            reconciliationStatus:
                RECONCILIATION_REQUIRED,

            ...extraUpdates

        }
    );

}


// =====================================================
// VERIFY TRANSACTION OWNERSHIP
// =====================================================

function verifyOwnership(
    transaction,
    uid
) {

    const authenticatedUid =
        requireUid(
            uid
        );


    if (
        !transaction
    ) {

        throw createError(
            "Airtime transaction not found.",
            404
        );

    }


    if (
        transaction.uid !==
        authenticatedUid
    ) {

        throw createError(
            "Airtime transaction ownership mismatch.",
            403
        );

    }


    if (
        transaction.service !==
        SERVICE
    ) {

        throw createError(
            "Invalid Airtime transaction service.",
            409
        );

    }


    return authenticatedUid;

}


// =====================================================
// VERIFY RESERVATION BINDING
// =====================================================
//
// A reservation used by Airtime reconciliation must belong
// to the same:
//
//     user
//     service
//     transaction reference
//     amount
//
// =====================================================

function verifyReservationBinding(
    reservation,
    transaction,
    uid
) {

    const authenticatedUid =
        requireUid(
            uid
        );


    if (
        !reservation
    ) {

        throw createError(
            "Airtime wallet reservation not found.",
            500
        );

    }


    if (
        reservation.uid !==
        authenticatedUid
    ) {

        throw createError(
            "Airtime reservation ownership mismatch.",
            403
        );

    }


    if (
        String(
            reservation.service ||
            ""
        )
            .trim()
            .toLowerCase() !==
        SERVICE
    ) {

        throw createError(
            "Airtime reservation service does not match the transaction.",
            409
        );

    }


    if (
        String(
            reservation.reference ||
            ""
        )
            .trim() !==
        String(
            transaction.id ||
            ""
        )
            .trim()
    ) {

        throw createError(
            "Airtime reservation reference does not match the transaction.",
            409
        );

    }


    if (
        Number(
            reservation.amountKobo
        ) !==
        Number(
            transaction.amountKobo
        )
    ) {

        throw createError(
            "Airtime reservation amount does not match the transaction.",
            409
        );

    }


    return true;

}


// =====================================================
// GET AND VERIFY RESERVATION
// =====================================================
//
// getReservation() accepts the reservation ID directly.
//
// =====================================================

async function getVerifiedReservation({
    uid,
    transaction
}) {

    const authenticatedUid =
        verifyOwnership(
            transaction,
            uid
        );


    const reservationId =
        String(
            transaction.reservationId ||
            ""
        ).trim();


    if (!reservationId) {

        throw createError(
            "Airtime transaction has no wallet reservation.",
            500
        );

    }


    const reservation =
        await getReservation(
            reservationId
        );


    verifyReservationBinding(
        reservation,
        transaction,
        authenticatedUid
    );


    return {

        reservationId,

        reservation

    };

}


// =====================================================
// FINAL SUCCESS RESPONSE
// =====================================================

function buildSuccessfulResponse(
    transaction
) {

    return {

        status:
            STATUS_SUCCESSFUL,

        transactionId:
            transaction.id,

        amountKobo:
            transaction.amountKobo,

        network:
            transaction.network,

        phoneNumber:
            transaction.phoneNumber,

        rewardPoints:
            transaction.rewardPoints ||
            0,

        gainKobo:
            transaction.gainKobo ??
            null

    };

}


// =====================================================
// FINAL FAILURE RESPONSE
// =====================================================

function buildFailedResponse(
    transaction
) {

    return {

        status:
            STATUS_FAILED,

        transactionId:
            transaction.id,

        amountKobo:
            transaction.amountKobo,

        network:
            transaction.network,

        phoneNumber:
            transaction.phoneNumber,

        rewardPoints:
            transaction.rewardPoints ||
            0,

        gainKobo:
            null,

        message:
            transaction.failureReason ||
            "The Airtime request failed."

    };

}
// =====================================================
// HANDLE CONFIRMED SUCCESS
// =====================================================
//
// Provider explicitly confirmed success.
//
// Financial action:
//
//     reservation pending
//             ↓
//          COMMIT
//
// The reservation service remains the only component
// allowed to change wallet financial state.
//
// =====================================================

async function handleConfirmedSuccess({
    uid,
    transaction,
    providerResult
}) {

    const authenticatedUid =
        verifyOwnership(
            transaction,
            uid
        );


    /*
     * A successful transaction is already terminal.
     *
     * Never perform another financial operation.
     */

    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        return buildSuccessfulResponse(
            transaction
        );

    }


    /*
     * A failed transaction is terminal.
     *
     * Never convert failure into success automatically.
     */

    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        throw createError(
            "A failed Airtime transaction cannot be converted to successful.",
            409
        );

    }


    if (
        transaction.status !==
        STATUS_PENDING
    ) {

        throw createError(
            "Airtime transaction is in an invalid reconciliation state.",
            409
        );

    }


    const {
        reservationId,
        reservation
    } =
        await getVerifiedReservation({

            uid:
                authenticatedUid,

            transaction

        });


    /*
     * A released reservation can never fund a successful
     * transaction.
     */

    if (
        reservation.status ===
        RESERVATION_RELEASED
    ) {

        throw createError(
            "Airtime reservation was already released.",
            409
        );

    }


    /*
     * If another reconciliation attempt already committed
     * the reservation, do not commit again.
     *
     * Just finalize the transaction record.
     */

    if (
        reservation.status ===
        RESERVATION_COMMITTED
    ) {

        const updated =
            await updateTransaction(
                transaction.id,
                {

                    status:
                        STATUS_SUCCESSFUL,

                    providerReference:
                        normalizeProviderString(
                            providerResult?.providerReference
                        ) ||
                        transaction.providerReference ||
                        null,

                    providerRequestId:
                        normalizeProviderString(
                            providerResult?.providerRequestId
                        ) ||
                        transaction.providerRequestId ||
                        null,

                    providerStatus:
                        normalizeProviderString(
                            providerResult?.providerStatus
                        ) ||
                        transaction.providerStatus ||
                        null,

                    providerCode:
                        normalizeProviderString(
                            providerResult?.providerCode
                        ) ||
                        transaction.providerCode ||
                        null,

                    providerCostKobo:
                        providerResult?.providerCostKobo ??
                        transaction.providerCostKobo ??
                        null,

                    providerOutcome:
                        "success",

                    reconciliationRequired:
                        false,

                    reconciliationStatus:
                        "resolved",

                    failureReason:
                        "",

                    reconciliationError:
                        null,

                    reconciliationLeaseUntil:
                        null,

                    reconciliationLeaseId:
                        null

                }
            );


        return buildSuccessfulResponse(
            updated
        );

    }


    if (
        reservation.status !==
        RESERVATION_PENDING
    ) {

        throw createError(
            "Airtime reservation is in an invalid state.",
            409
        );

    }


    /*
     * -----------------------------------------------------
     * COMMIT RESERVED FUNDS
     * -----------------------------------------------------
     *
     * This operation is idempotent inside reservation.js.
     *
     * If the process crashes and reconciliation runs again,
     * the reservation will already be committed and the
     * branch above will safely finalize the transaction.
     */

    await commitReservation({

        uid:
            authenticatedUid,

        reservationId,

    });


    /*
     * -----------------------------------------------------
     * FINALIZE BUSINESS TRANSACTION
     * -----------------------------------------------------
     */

    const updated =
        await updateTransaction(
            transaction.id,
            {

                status:
                    STATUS_SUCCESSFUL,

                providerReference:
                    normalizeProviderString(
                        providerResult?.providerReference
                    ) ||
                    transaction.providerReference ||
                    null,

                providerRequestId:
                    normalizeProviderString(
                        providerResult?.providerRequestId
                    ) ||
                    transaction.providerRequestId ||
                    null,

                providerStatus:
                    normalizeProviderString(
                        providerResult?.providerStatus
                    ) ||
                    transaction.providerStatus ||
                    null,

                providerCode:
                    normalizeProviderString(
                        providerResult?.providerCode
                    ) ||
                    transaction.providerCode ||
                    null,

                providerCostKobo:
                    providerResult?.providerCostKobo ??
                    transaction.providerCostKobo ??
                    null,

                providerOutcome:
                    "success",

                reconciliationRequired:
                    false,

                reconciliationStatus:
                    "resolved",

                reconciliationError:
                    null,

                reconciliationLeaseUntil:
                    null,

                reconciliationLeaseId:
                    null,

                failureReason:
                    ""

            }
        );


    return buildSuccessfulResponse(
        updated
    );

}


// =====================================================
// HANDLE CONFIRMED FAILURE
// =====================================================
//
// Provider explicitly confirmed failure.
//
// Financial action:
//
//     reservation pending
//             ↓
//          RELEASE
//
// NEVER release an already committed reservation.
//
// =====================================================

async function handleConfirmedFailure({
    uid,
    transaction,
    providerResult
}) {

    const authenticatedUid =
        verifyOwnership(
            transaction,
            uid
        );


    /*
     * Already failed.
     *
     * Reservation release is idempotent, but there is no
     * reason to perform another financial operation.
     */

    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        return buildFailedResponse(
            transaction
        );

    }


    /*
     * Success is terminal.
     */

    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        throw createError(
            "A successful Airtime transaction cannot be marked as failed.",
            409
        );

    }


    if (
        transaction.status !==
        STATUS_PENDING
    ) {

        throw createError(
            "Airtime transaction is in an invalid reconciliation state.",
            409
        );

    }


    const {
        reservationId,
        reservation
    } =
        await getVerifiedReservation({

            uid:
                authenticatedUid,

            transaction

        });


    /*
     * A committed reservation means the customer's money
     * has already been consumed.
     *
     * NEVER release it because a later status check says
     * failure.
     */

    if (
        reservation.status ===
        RESERVATION_COMMITTED
    ) {

        throw createError(
            "Airtime reservation is already committed.",
            409
        );

    }


    /*
     * Already released means the financial operation has
     * already happened.
     *
     * Finalize the business record only.
     */

    if (
        reservation.status ===
        RESERVATION_RELEASED
    ) {

        const updated =
            await updateTransaction(
                transaction.id,
                {

                    status:
                        STATUS_FAILED,

                    providerReference:
                        normalizeProviderString(
                            providerResult?.providerReference
                        ) ||
                        transaction.providerReference ||
                        null,

                    providerRequestId:
                        normalizeProviderString(
                            providerResult?.providerRequestId
                        ) ||
                        transaction.providerRequestId ||
                        null,

                    providerStatus:
                        normalizeProviderString(
                            providerResult?.providerStatus
                        ) ||
                        transaction.providerStatus ||
                        null,

                    providerCode:
                        normalizeProviderString(
                            providerResult?.providerCode
                        ) ||
                        transaction.providerCode ||
                        null,

                    providerCostKobo:
                        providerResult?.providerCostKobo ??
                        transaction.providerCostKobo ??
                        null,

                    providerOutcome:
                        "failure",

                    reconciliationRequired:
                        false,

                    reconciliationStatus:
                        "resolved",

                    reconciliationError:
                        null,

                    reconciliationLeaseUntil:
                        null,

                    reconciliationLeaseId:
                        null,

                    failureReason:
                        normalizeProviderMessage(
                            providerResult,
                            "VTU.ng confirmed that the Airtime order failed."
                        )

                }
            );


        return buildFailedResponse(
            updated
        );

    }


    if (
        reservation.status !==
        RESERVATION_PENDING
    ) {

        throw createError(
            "Airtime reservation is in an invalid state.",
            409
        );

    }


    /*
     * -----------------------------------------------------
     * RELEASE RESERVED FUNDS
     * -----------------------------------------------------
     *
     * Only explicit provider failure reaches this point.
     */

    await releaseReservation({

        uid:
            authenticatedUid,

        reservationId,

        reason:
            "vtu_reconciliation_confirmed_failure"

    });


    const failureReason =
        normalizeProviderMessage(
            providerResult,
            "VTU.ng confirmed that the Airtime order failed."
        );


    /*
     * -----------------------------------------------------
     * FINALIZE BUSINESS TRANSACTION
     * -----------------------------------------------------
     */

    const updated =
        await updateTransaction(
            transaction.id,
            {

                status:
                    STATUS_FAILED,

                providerReference:
                    normalizeProviderString(
                        providerResult?.providerReference
                    ) ||
                    transaction.providerReference ||
                    null,

                providerRequestId:
                    normalizeProviderString(
                        providerResult?.providerRequestId
                    ) ||
                    transaction.providerRequestId ||
                    null,

                providerStatus:
                    normalizeProviderString(
                        providerResult?.providerStatus
                    ) ||
                    transaction.providerStatus ||
                    null,

                providerCode:
                    normalizeProviderString(
                        providerResult?.providerCode
                    ) ||
                    transaction.providerCode ||
                    null,

                providerCostKobo:
                    providerResult?.providerCostKobo ??
                    transaction.providerCostKobo ??
                    null,

                providerOutcome:
                    "failure",

                reconciliationRequired:
                    false,

                reconciliationStatus:
                    "resolved",

                reconciliationError:
                    null,

                reconciliationLeaseUntil:
                    null,

                reconciliationLeaseId:
                    null,

                failureReason

            }
        );


    return buildFailedResponse(
        updated
    );

}


// =====================================================
// HANDLE UNKNOWN RESULT
// =====================================================
//
// UNKNOWN means:
//
//     WE STILL DO NOT KNOW.
//
// Therefore:
//
//     wallet reservation stays locked
//
// No release.
// No commit.
//
// A future reconciliation attempt is scheduled.
//
// =====================================================

async function handleUnknownResult({
    uid,
    transaction,
    providerResult
}) {

    const authenticatedUid =
        verifyOwnership(
            transaction,
            uid
        );


    /*
     * Never move terminal transactions backwards.
     */

    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        return buildSuccessfulResponse(
            transaction
        );

    }


    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        return buildFailedResponse(
            transaction
        );

    }


    if (
        transaction.status !==
        STATUS_PENDING
    ) {

        throw createError(
            "Airtime transaction is in an invalid reconciliation state.",
            409
        );

    }


    const {
        reservation
    } =
        await getVerifiedReservation({

            uid:
                authenticatedUid,

            transaction

        });


    /*
     * Another process may already have committed the
     * reservation while this process was checking status.
     */

    if (
        reservation.status ===
        RESERVATION_COMMITTED
    ) {

        const updated =
            await updateTransaction(
                transaction.id,
                {

                    status:
                        STATUS_SUCCESSFUL,

                    providerOutcome:
                        "success",

                    reconciliationRequired:
                        false,

                    reconciliationStatus:
                        "resolved",

                    reconciliationError:
                        null,

                    reconciliationLeaseUntil:
                        null,

                    reconciliationLeaseId:
                        null

                }
            );


        return buildSuccessfulResponse(
            updated
        );

    }


    /*
     * A released reservation cannot remain pending.
     *
     * Do not try to recreate or reuse the reservation.
     */

    if (
        reservation.status ===
        RESERVATION_RELEASED
    ) {

        throw createError(
            "Airtime reservation was released while the transaction remained pending.",
            409
        );

    }


    if (
        reservation.status !==
        RESERVATION_PENDING
    ) {

        throw createError(
            "Airtime reservation is in an invalid state.",
            409
        );

    }


    /*
     * Calculate the next controlled reconciliation time.
     *
     * IMPORTANT:
     *
     * This is an operational retry schedule.
     * It is NOT a financial expiry.
     */

    const attempts =
        getReconciliationAttempts(
            transaction
        ) + 1;


    const nextReconciliationAt =
        calculateNextReconciliationAt(
            attempts
        );


    const stale =
        isOlderThanMaximumAge(
            transaction
        );


    /*
     * Old/long-running transactions are escalated,
     * NOT automatically refunded.
     *
     * The funds remain reserved because the provider
     * outcome is still unknown.
     */

    if (
        stale ||
        attempts >=
        RECONCILIATION_MAX_ATTEMPTS
    ) {

        const updated =
            await updateTransaction(
                transaction.id,
                {

                    status:
                        STATUS_PENDING,

                    providerReference:
                        normalizeProviderString(
                            providerResult?.providerReference
                        ) ||
                        transaction.providerReference ||
                        null,

                    providerRequestId:
                        normalizeProviderString(
                            providerResult?.providerRequestId
                        ) ||
                        transaction.providerRequestId ||
                        null,

                    providerStatus:
                        normalizeProviderString(
                            providerResult?.providerStatus
                        ) ||
                        transaction.providerStatus ||
                        null,

                    providerCode:
                        normalizeProviderString(
                            providerResult?.providerCode
                        ) ||
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
                        "escalated",

                    reconciliationAttempts:
                        attempts,

                    lastReconciliationAt:
                        new Date(),

                    nextReconciliationAt:
                        null,

                    escalatedAt:
                        transaction.escalatedAt ||
                        new Date(),

                    reconciliationError:
                        "Provider outcome remains unresolved after controlled reconciliation attempts.",

                    failureReason:
                        ""

                }
            );


        /*
         * CRITICAL:
         *
         * No releaseReservation() here.
         */

        return {

            status:
                STATUS_PENDING,

            transactionId:
                updated.id,

            amountKobo:
                updated.amountKobo,

            network:
                updated.network,

            phoneNumber:
                updated.phoneNumber,

            message:
                "The Airtime transaction is still unresolved. Your funds remain reserved and the transaction has been escalated for review."

        };

    }


    /*
     * -----------------------------------------------------
     * NORMAL UNKNOWN / PROCESSING STATE
     * -----------------------------------------------------
     */

    const updated =
        await updateTransaction(
            transaction.id,
            {

                status:
                    STATUS_PENDING,

                providerReference:
                    normalizeProviderString(
                        providerResult?.providerReference
                    ) ||
                    transaction.providerReference ||
                    null,

                providerRequestId:
                    normalizeProviderString(
                        providerResult?.providerRequestId
                    ) ||
                    transaction.providerRequestId ||
                    null,

                providerStatus:
                    normalizeProviderString(
                        providerResult?.providerStatus
                    ) ||
                    transaction.providerStatus ||
                    null,

                providerCode:
                    normalizeProviderString(
                        providerResult?.providerCode
                    ) ||
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
                    "required",

                reconciliationAttempts:
                    attempts,

                lastReconciliationAt:
                    new Date(),

                nextReconciliationAt,

                reconciliationError:
                    null,

                failureReason:
                    "",

                escalatedAt:
                    null,

                reconciliationLeaseUntil:
                    null,

                reconciliationLeaseId:
                    null

            }
        );


    return {

        status:
            STATUS_PENDING,

        transactionId:
            updated.id,

        amountKobo:
            updated.amountKobo,

        network:
            updated.network,

        phoneNumber:
            updated.phoneNumber,

        message:
            normalizeProviderMessage(
                providerResult,
                "The Airtime provider has not confirmed the final result. Your funds remain reserved and the transaction will be checked again."
            )

    };

}


// =====================================================
// RECONCILE AIRTIME TRANSACTION
// =====================================================
//
// This is the main reconciliation entry point.
//
// It:
//
// 1. authenticates ownership
// 2. verifies transaction state
// 3. verifies reservation binding
// 4. prevents concurrent reconciliation
// 5. asks provider for status
// 6. commits on confirmed success
// 7. releases on confirmed failure
// 8. keeps funds locked on unknown
//
// =====================================================

async function reconcileAirtimeTransaction({
    uid,
    transactionId,
    providerClient
}) {

    const authenticatedUid =
        requireUid(
            uid
        );


    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );


    if (
        !providerClient ||
        typeof providerClient.checkAirtimeStatus !==
        "function"
    ) {

        throw createError(
            "Airtime provider status client is not available.",
            500
        );

    }


    const transaction =
        await getAirtimeTransaction(
            normalizedTransactionId
        );


    verifyOwnership(
        transaction,
        authenticatedUid
    );


    /*
     * Terminal transaction.
     */

    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        return buildSuccessfulResponse(
            transaction
        );

    }


    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        return buildFailedResponse(
            transaction
        );

    }


    if (
        transaction.status !==
        STATUS_PENDING
    ) {

        throw createError(
            "Airtime transaction is in an invalid reconciliation state.",
            409
        );

    }


    if (
        transaction.reconciliationRequired !==
        true
    ) {

        throw createError(
            "Airtime transaction does not require provider reconciliation.",
            409
        );

    }


    /*
     * Verify transaction ↔ reservation binding before
     * asking the provider for a financial decision.
     */

    const {
        reservation
    } =
        await getVerifiedReservation({

            uid:
                authenticatedUid,

            transaction

        });


    /*
     * If another process already committed the reservation,
     * synchronize the transaction without another debit.
     */

    if (
        reservation.status ===
        RESERVATION_COMMITTED
    ) {

        const updated =
            await updateTransaction(
                normalizedTransactionId,
                {

                    status:
                        STATUS_SUCCESSFUL,

                    providerOutcome:
                        "success",

                    reconciliationRequired:
                        false,

                    reconciliationStatus:
                        "resolved",

                    reconciliationLeaseUntil:
                        null,

                    reconciliationLeaseId:
                        null

                }
            );


        return buildSuccessfulResponse(
            updated
        );

    }


    /*
     * Released reservation is terminal and cannot be reused.
     */

    if (
        reservation.status ===
        RESERVATION_RELEASED
    ) {

        throw createError(
            "Airtime reservation has already been released.",
            409
        );

    }


    if (
        reservation.status !==
        RESERVATION_PENDING
    ) {

        throw createError(
            "Airtime reservation is in an invalid state.",
            409
        );

    }


    /*
     * -----------------------------------------------------
     * CLAIM RECONCILIATION LEASE
     * -----------------------------------------------------
     *
     * Prevent two worker instances from querying and
     * settling the same transaction simultaneously.
     */

    const lease =
        await claimReconciliationLease({
            transactionId:
                normalizedTransactionId
        });


    if (
        !lease.claimed
    ) {

        return {

            status:
                STATUS_PENDING,

            transactionId:
                normalizedTransactionId,

            amountKobo:
                transaction.amountKobo,

            network:
                transaction.network,

            phoneNumber:
                transaction.phoneNumber,

            message:
                "This Airtime transaction is already being reconciled. Please wait for the next status update."

        };

    }


    try {

        /*
         * -------------------------------------------------
         * PROVIDER STATUS CHECK
         * -------------------------------------------------
         */

        let providerResult;


        try {

            providerResult =
                await providerClient.checkAirtimeStatus({

                    transactionId:
                        normalizedTransactionId,

                    providerRequestId:
                        transaction.providerRequestId ||
                        null,

                    providerReference:
                        transaction.providerReference ||
                        null

                });

        }

        catch (error) {

            /*
             * Network failure, timeout, provider outage or
             * any other inability to establish final status
             * is UNKNOWN.
             *
             * NEVER release funds here.
             */

            return await handleUnknownResult({

                uid:
                    authenticatedUid,

                transaction,

                providerResult: {

                    outcome:
                        "unknown",

                    providerStatus:
                        error?.providerStatus ||
                        null,

                    providerCode:
                        error?.providerCode ||
                        null,

                    providerReference:
                        error?.providerReference ||
                        null,

                    providerRequestId:
                        error?.providerRequestId ||
                        null,

                    message:
                        "The Airtime provider status could not be confirmed."

                }

            });

        }


        /*
         * -------------------------------------------------
         * NORMALIZE PROVIDER OUTCOME
         * -------------------------------------------------
         */

        const outcome =
            normalizeProviderOutcome(
                providerResult
            );


        /*
         * -------------------------------------------------
         * CONFIRMED SUCCESS
         * -------------------------------------------------
         */

        if (
            outcome ===
            "success"
        ) {

            return await handleConfirmedSuccess({

                uid:
                    authenticatedUid,

                transaction,

                providerResult

            });

        }


        /*
         * -------------------------------------------------
         * CONFIRMED FAILURE
         * -------------------------------------------------
         */

        if (
            outcome ===
            "failure"
        ) {

            return await handleConfirmedFailure({

                uid:
                    authenticatedUid,

                transaction,

                providerResult

            });

        }


        /*
         * -------------------------------------------------
         * UNKNOWN / PROCESSING
         * -------------------------------------------------
         */

        return await handleUnknownResult({

            uid:
                authenticatedUid,

            transaction,

            providerResult

        });

    }

    finally {

        /*
         * Always release the reconciliation lease.
         *
         * This DOES NOT release the wallet reservation.
         *
         * It only allows a future reconciliation attempt
         * to process the transaction.
         */

        await clearReconciliationLease(
            normalizedTransactionId
        );

    }

}


// =====================================================
// FIND TRANSACTIONS REQUIRING RECONCILIATION
// =====================================================
//
// Only pending Airtime transactions with
// reconciliationRequired=true are selected.
//
// The nextReconciliationAt timestamp is respected when
// available.
//
// Transactions that have been escalated are intentionally
// excluded from automatic processing.
//
// They remain financially reserved until an authoritative
// provider outcome or manual resolution is obtained.
//
// =====================================================

async function findTransactionsRequiringReconciliation({
    limit = 25
} = {}) {

    const parsedLimit =
        Number(
            limit
        );


    const safeLimit =
        Number.isInteger(
            parsedLimit
        ) &&
        parsedLimit > 0 &&
        parsedLimit <= 100
            ? parsedLimit
            : 25;


    /*
     * Query the existing Airtime transaction collection.
     *
     * We intentionally preserve the existing service/status/
     * reconciliationRequired query shape.
     */

    const snapshot =
        await db
            .collection(
                TRANSACTIONS_COLLECTION
            )
            .where(
                "service",
                "==",
                SERVICE
            )
            .where(
                "status",
                "==",
                STATUS_PENDING
            )
            .where(
                "reconciliationRequired",
                "==",
                true
            )
            .limit(
                Math.min(
                    safeLimit * 2,
                    100
                )
            )
            .get();


    const now =
        Date.now();


    const eligible = [];


    for (
        const document
        of snapshot.docs
    ) {

        const transaction = {

            id:
                document.id,

            ...document.data()

        };


        /*
         * Escalated transactions require manual/controlled
         * review and should not be hammered by the automatic
         * worker indefinitely.
         */

        if (
            transaction.reconciliationStatus ===
            "escalated"
        ) {

            continue;

        }


        /*
         * Respect the retry schedule.
         *
         * If nextReconciliationAt is absent, the transaction
         * remains eligible for compatibility with existing
         * records.
         */

        if (
            transaction.nextReconciliationAt
        ) {

            const nextAt =
                toMillis(
                    transaction.nextReconciliationAt
                );


            if (
                nextAt > now
            ) {

                continue;

            }

        }


        eligible.push(
            transaction
        );

    }


    /*
     * Oldest due transactions first.
     *
     * This helps prevent a transaction from being
     * perpetually skipped behind newer records.
     */

    eligible.sort(
        (a, b) => {

            const aTime =
                toMillis(
                    a.nextReconciliationAt
                ) ||
                toMillis(
                    a.createdAt
                ) ||
                0;


            const bTime =
                toMillis(
                    b.nextReconciliationAt
                ) ||
                toMillis(
                    b.createdAt
                ) ||
                0;


            return aTime - bTime;

        }
    );


    return eligible.slice(
        0,
        safeLimit
    );

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    reconcileAirtimeTransaction,

    findTransactionsRequiringReconciliation

};