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
// Example:
//
//     VTU request
//          ↓
//     network timeout
//          ↓
//     transaction = pending
//          ↓
//     reservation remains locked
//          ↓
//     reconciliation checks VTU
//          ↓
//     ┌──────────────┬───────────────┬──────────────┐
//     ↓              ↓               ↓
//   SUCCESS        FAILURE         UNKNOWN
//     ↓              ↓               ↓
//   COMMIT        RELEASE          KEEP LOCKED
//
// FINANCIAL RULE:
//
// UNKNOWN NEVER means FAILURE.
//
// Only an explicit provider success may commit funds.
//
// Only an explicit provider failure may release funds.
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
// This is intentional.
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
// This prevents reconciliation from operating on a different
// reservation accidentally or through corrupted data.
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
        ).trim() !==
        String(
            transaction.id ||
            ""
        ).trim()
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
// IMPORTANT:
//
// The provider has explicitly confirmed success.
//
// Therefore the reservation may now be committed.
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
     * Already finalized successfully.
     *
     * Do not perform another financial operation.
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
            "Airtime transaction is in an invalid state.",
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
     * A released reservation cannot fund a successful
     * Airtime transaction.
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
     * If it is already committed, the financial operation
     * has already happened. We only need to finalize the
     * Airtime business record.
     */

    if (
        reservation.status !==
        RESERVATION_PENDING &&
        reservation.status !==
        RESERVATION_COMMITTED
    ) {

        throw createError(
            "Airtime reservation is in an invalid state.",
            409
        );

    }


    if (
        reservation.status ===
        RESERVATION_PENDING
    ) {

        await commitReservation({

            uid:
                authenticatedUid,

            reservationId,

            provider:
                "vtu.ng"

        });

    }


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
// IMPORTANT:
//
// Funds are released ONLY after the provider explicitly
// confirms that the Airtime order failed.
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
     * No second release should occur.
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
     * A successful transaction is terminal.
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
            "Airtime transaction is in an invalid state.",
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
     * Never release it through the failure path.
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


    if (
        reservation.status ===
        RESERVATION_RELEASED
    ) {

        return buildFailedResponse(
            transaction
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

                gainKobo:
                    null,

                providerOutcome:
                    "failure",

                reconciliationRequired:
                    false,

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
// UNKNOWN means we still do not know.
//
// The reservation stays locked.
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
     * Never move a terminal transaction backwards.
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
            "Airtime transaction is in an invalid state.",
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
     * If another process already committed the reservation,
     * the transaction should be treated as successful rather
     * than being returned to pending.
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
                        false

                }
            );


        return buildSuccessfulResponse(
            updated
        );

    }


    /*
     * A released reservation cannot remain financially
     * pending.
     */

    if (
        reservation.status ===
        RESERVATION_RELEASED
    ) {

        throw createError(
            "Airtime reservation was released while transaction remained pending.",
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

                failureReason:
                    ""

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
                "The Airtime transaction is still being processed. The wallet funds remain reserved."
            )

    };

}


// =====================================================
// RECONCILE AIRTIME TRANSACTION
// =====================================================
//
// providerClient MUST provide:
//
//     checkAirtimeStatus()
//
// The provider adapter is responsible for translating
// VTU.ng's actual status response into:
//
//     {
//         outcome: "success"
//     }
//
// or:
//
//     {
//         outcome: "failure",
//         message: "..."
//     }
//
// or:
//
//     {
//         outcome: "unknown"
//     }
//
// The reconciliation layer never interprets raw VTU
// response codes itself.
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
     * Terminal transactions do not need reconciliation.
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
     * Confirm that the reservation still belongs to the
     * authenticated user and this exact Airtime transaction.
     */

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
     * If already committed, finalize the business record.
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
                        false

                }
            );


        return buildSuccessfulResponse(
            updated
        );

    }


    /*
     * A released reservation means the financial state is
     * terminal and must not be reused.
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
     * PROVIDER STATUS CHECK
     * -----------------------------------------------------
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
                    null,

                network:
                    transaction.network,

                phoneNumber:
                    transaction.phoneNumber,

                amountKobo:
                    transaction.amountKobo

            });

    }

    catch (error) {

        /*
         * Provider status could not be confirmed.
         *
         * This is UNKNOWN.
         *
         * NEVER release the customer's money here.
         */

        await updateTransaction(
            normalizedTransactionId,
            {

                status:
                    STATUS_PENDING,

                providerStatus:
                    normalizeProviderString(
                        error?.providerStatus
                    ) ||
                    transaction.providerStatus ||
                    null,

                providerCode:
                    normalizeProviderString(
                        error?.providerCode
                    ) ||
                    transaction.providerCode ||
                    null,

                providerReference:
                    normalizeProviderString(
                        error?.providerReference
                    ) ||
                    transaction.providerReference ||
                    null,

                providerOutcome:
                    "unknown",

                reconciliationRequired:
                    true,

                failureReason:
                    ""

            }
        );


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
                "The Airtime provider status could not be confirmed. Your funds remain reserved and will be checked again."

        };

    }


    const outcome =
        normalizeProviderOutcome(
            providerResult
        );


    /*
     * -----------------------------------------------------
     * CONFIRMED SUCCESS
     * -----------------------------------------------------
     */

    if (
        outcome ===
        "success"
    ) {

        return handleConfirmedSuccess({

            uid:
                authenticatedUid,

            transaction,

            providerResult

        });

    }


    /*
     * -----------------------------------------------------
     * CONFIRMED FAILURE
     * -----------------------------------------------------
     */

    if (
        outcome ===
        "failure"
    ) {

        return handleConfirmedFailure({

            uid:
                authenticatedUid,

            transaction,

            providerResult

        });

    }


    /*
     * -----------------------------------------------------
     * STILL UNKNOWN
     * -----------------------------------------------------
     */

    return handleUnknownResult({

        uid:
            authenticatedUid,

        transaction,

        providerResult

    });

}


// =====================================================
// FIND TRANSACTIONS REQUIRING RECONCILIATION
// =====================================================
//
// Internal worker helper.
//
// This does NOT modify transactions.
//
// A separate worker can use the returned transactions and
// call reconcileAirtimeTransaction().
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
                safeLimit
            )
            .get();


    return snapshot.docs.map(
        document => ({

            id:
                document.id,

            ...document.data()

        })
    );

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    reconcileAirtimeTransaction,

    findTransactionsRequiringReconciliation

};