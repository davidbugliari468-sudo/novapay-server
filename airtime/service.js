// airtime/service.js

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


// =====================================================
// NOVAPAY — AIRTIME SERVICE
// =====================================================
//
// RESPONSIBILITY
//
// This module is the business orchestration layer for
// Airtime purchases.
//
// Flow:
//
//     authenticated route
//             ↓
//     validate request
//             ↓
//     create transaction
//             ↓
//     reserve wallet funds
//             ↓
//     link reservation to transaction
//             ↓
//     call VTU.ng adapter
//             ↓
//     ┌───────────────┬────────────────┬───────────────┐
//     ↓               ↓                ↓
//   SUCCESS         FAILURE          UNKNOWN
//     ↓               ↓                ↓
//   COMMIT         RELEASE          PENDING
//     ↓               ↓                ↓
//   completed       failed          reconciliation
//
// IMPORTANT FINANCIAL RULE:
//
// The service NEVER decides that an unknown provider
// response is a failure.
//
// Only an explicit provider failure can release funds.
//
// Only an explicit provider success can commit funds.
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

const CURRENCY =
    "NGN";

const STATUS_PENDING =
    "pending";

const STATUS_SUCCESSFUL =
    "successful";

const STATUS_FAILED =
    "failed";


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
// VALIDATE AMOUNT
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
            "Airtime amount must be a positive integer in kobo.",
            400
        );

    }


    return amount;

}


// =====================================================
// NORMALIZE NETWORK
// =====================================================

function normalizeNetwork(
    network
) {

    const normalized =
        String(
            network || ""
        )
            .trim()
            .toLowerCase();


    if (!normalized) {

        throw createError(
            "Airtime network is required.",
            400
        );

    }


    if (
        normalized.length >
        50
    ) {

        throw createError(
            "Airtime network is too long.",
            400
        );

    }


    return normalized;

}


// =====================================================
// NORMALIZE PHONE
// =====================================================

function normalizePhone(
    phoneNumber
) {

    const normalized =
        String(
            phoneNumber || ""
        ).trim();


    if (!normalized) {

        throw createError(
            "Airtime phone number is required.",
            400
        );

    }


    if (
        normalized.length >
        30
    ) {

        throw createError(
            "Airtime phone number is too long.",
            400
        );

    }


    return normalized;

}


// =====================================================
// CREATE TRANSACTION ID
// =====================================================
//
// This ID is generated by NovaPay.
//
// It is NOT the VTU.ng request_id.
//
// vtu.js derives a provider-safe request ID from this
// transaction ID.
//
// =====================================================

function createTransactionId() {

    return (
        "NPAIR_" +
        Date.now() +
        "_" +
        crypto
            .randomBytes(16)
            .toString("hex")
    );

}


// =====================================================
// TRANSACTION REFERENCE
// =====================================================
//
// The transaction ID itself is used as the wallet
// reservation reference.
//
// This gives us deterministic idempotency.
//
// =====================================================

function getReservationReference(
    transactionId
) {

    return requireTransactionId(
        transactionId
    );

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
            requireTransactionId(
                transactionId
            )
        );

}


// =====================================================
// FIND EXISTING TRANSACTION
// =====================================================
//
// This is the first idempotency barrier.
//
// A repeated purchase request must not create another
// financial transaction when the same transaction ID is
// already being processed.
//
// =====================================================

async function getAirtimeTransaction(
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
//
// This transaction record is created BEFORE wallet
// reservation.
//
// Why?
//
// Because the Airtime operation needs a durable business
// transaction ID before the provider call occurs.
//
// If reservation fails, the transaction is marked failed
// without touching the wallet.
//
// =====================================================

async function createInitialTransaction({
    uid,
    transactionId,
    network,
    phoneNumber,
    amountKobo
}) {

    const authenticatedUid =
        requireUid(
            uid
        );


    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );


    const amount =
        validateAmountKobo(
            amountKobo
        );


    const normalizedNetwork =
        normalizeNetwork(
            network
        );


    const normalizedPhone =
        normalizePhone(
            phoneNumber
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

        network:
            normalizedNetwork,

        phoneNumber:
            normalizedPhone,

        amountKobo:
            amount,

        currency:
            CURRENCY,

        status:
            STATUS_PENDING,

        provider:
            "vtu.ng",

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

        gainKobo:
            null,

        rewardPoints:
            0,

        reservationId:
            null,

        failureReason:
            "",

        providerOutcome:
            null,

        reconciliationRequired:
            false,

        createdAt:
            now,

        updatedAt:
            now

    };


    try {

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


                    /*
                     * Never allow one transaction ID to be
                     * reused for a different user.
                     */

                    if (
                        existing.uid !==
                        authenticatedUid
                    ) {

                        throw createError(
                            "Airtime transaction ownership mismatch.",
                            403
                        );

                    }


                    /*
                     * Never allow the same transaction ID to
                     * represent different financial details.
                     */

                    if (
                        Number(
                            existing.amountKobo
                        ) !==
                        amount ||
                        String(
                            existing.network ||
                            ""
                        ).toLowerCase() !==
                        normalizedNetwork ||
                        String(
                            existing.phoneNumber ||
                            ""
                        ) !==
                        normalizedPhone
                    ) {

                        throw createError(
                            "Airtime transaction details do not match the existing transaction.",
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

    }

    catch (error) {

        throw error;

    }


    const created =
        await getAirtimeTransaction(
            normalizedTransactionId
        );


    if (!created) {

        throw new Error(
            "Airtime transaction could not be created."
        );

    }


    return created;

}


// =====================================================
// UPDATE TRANSACTION
// =====================================================
//
// All financial state transitions are performed through
// wallet/reservation.js.
//
// This function only updates the Airtime business record.
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


    const safeUpdates =
        {
            ...updates,
            updatedAt:
                new Date()
        };


    await ref.update(
        safeUpdates
    );


    return getAirtimeTransaction(
        transactionId
    );

}


// =====================================================
// CALCULATE GAIN
// =====================================================
//
// Customer amount:
//
// amountKobo
//
// Provider cost:
//
// providerCostKobo
//
// Gross gain:
//
// amountKobo - providerCostKobo
//
// The result can never be negative.
//
// If VTU does not provide a valid provider cost,
// gain remains null.
//
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
        Number(
            providerCostKobo
        );


    if (
        !Number.isSafeInteger(
            amount
        ) ||
        amount < 0
    ) {

        return null;

    }


    if (
        !Number.isSafeInteger(
            providerCost
        ) ||
        providerCost < 0
    ) {

        return null;

    }


    if (
        providerCost >
        amount
    ) {

        /*
         * Do not manufacture a negative "gain".
         *
         * A provider cost greater than the customer charge
         * is an accounting anomaly that should be investigated.
         */

        return null;

    }


    return (
        amount -
        providerCost
    );

}


// =====================================================
// NORMALIZE PROVIDER RESULT
// =====================================================
//
// vtu.js is responsible for translating VTU's response
// into:
//
// success
// failure
// unknown
//
// The service trusts only those internal outcomes.
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
// HANDLE PROVIDER SUCCESS
// =====================================================
//
// IMPORTANT:
//
// We commit the reservation ONLY after VTU explicitly
// confirms success.
//
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
        await getAirtimeTransaction(
            normalizedTransactionId
        );


    if (!transaction) {

        throw new Error(
            "Airtime transaction not found while processing provider success."
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


    /*
     * If the transaction was already successfully
     * completed, do not commit the wallet again.
     */

    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        return {

            status:
                STATUS_SUCCESSFUL,

            transactionId:
                normalizedTransactionId,

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


    /*
     * A confirmed provider success must not overwrite
     * a terminal failed state.
     */

    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        throw createError(
            "Airtime transaction is already marked as failed.",
            409
        );

    }


    const reservationId =
        transaction.reservationId;


    if (!reservationId) {

        /*
         * This is a critical accounting condition.
         *
         * Never mark the Airtime successful without knowing
         * which reservation must be committed.
         */

        throw new Error(
            "Airtime transaction has no wallet reservation."
        );

    }


    /*
     * Commit is the ONLY operation that permanently
     * decreases the user's wallet balance.
     */

    await commitReservation({

        uid:
            authenticatedUid,

        reservationId,

        provider:
            "vtu.ng"

    });


    const gainKobo =
        calculateGainKobo(
            transaction.amountKobo,
            providerResult?.providerCostKobo
        );


    const updated =
        await updateTransaction(
            normalizedTransactionId,
            {

                status:
                    STATUS_SUCCESSFUL,

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

                gainKobo,

                providerOutcome:
                    "success",

                reservationId,

                reconciliationRequired:
                    false,

                failureReason:
                    ""

            }
        );


    return {

        status:
            STATUS_SUCCESSFUL,

        transactionId:
            normalizedTransactionId,

        amountKobo:
            updated.amountKobo,

        network:
            updated.network,

        phoneNumber:
            updated.phoneNumber,

        rewardPoints:
            updated.rewardPoints ||
            0,

        gainKobo:
            updated.gainKobo ??
            null

    };

}


// =====================================================
// HANDLE PROVIDER FAILURE
// =====================================================
//
// IMPORTANT:
//
// Funds are released ONLY when VTU explicitly confirms
// failure.
//
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
        await getAirtimeTransaction(
            normalizedTransactionId
        );


    if (!transaction) {

        throw new Error(
            "Airtime transaction not found while processing provider failure."
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


    /*
     * Idempotent terminal failure.
     */

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

            network:
                transaction.network,

            phoneNumber:
                transaction.phoneNumber,

            rewardPoints:
                transaction.rewardPoints ||
                0,

            gainKobo:
                null

        };

    }


    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        throw createError(
            "A successful Airtime transaction cannot be marked as failed.",
            409
        );

    }


    const reservationId =
        transaction.reservationId;


    if (!reservationId) {

        throw new Error(
            "Airtime transaction has no wallet reservation."
        );

    }


    /*
     * Release ONLY confirmed provider failure.
     */

    await releaseReservation({

        uid:
            authenticatedUid,

        reservationId,

        reason:
            "vtu_provider_confirmed_failure"

    });


    const failureReason =
        String(
            providerResult?.message ||
            "VTU.ng confirmed that the Airtime order failed."
        )
            .trim()
            .slice(
                0,
                300
            );


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

                gainKobo:
                    null,

                providerOutcome:
                    "failure",

                reservationId,

                reconciliationRequired:
                    false,

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

        network:
            updated.network,

        phoneNumber:
            updated.phoneNumber,

        rewardPoints:
            updated.rewardPoints ||
            0,

        gainKobo:
            null,

        message:
            failureReason

    };

}


// =====================================================
// HANDLE UNKNOWN PROVIDER RESULT
// =====================================================
//
// UNKNOWN means:
//
// - timeout
// - network failure
// - processing
// - queued
// - initiated
// - pending
// - on-hold
// - unexpected provider response
//
// UNKNOWN MUST KEEP THE RESERVATION.
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
        await getAirtimeTransaction(
            normalizedTransactionId
        );


    if (!transaction) {

        throw new Error(
            "Airtime transaction not found while processing provider pending state."
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


    /*
     * If something already finalized the transaction,
     * do not move it backwards to pending.
     */

    if (
        transaction.status ===
        STATUS_SUCCESSFUL ||
        transaction.status ===
        STATUS_FAILED
    ) {

        return {

            status:
                transaction.status,

            transactionId:
                normalizedTransactionId,

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


    const reservationId =
        transaction.reservationId;


    if (!reservationId) {

        throw new Error(
            "Airtime transaction has no wallet reservation."
        );

    }


    /*
     * Confirm that the reservation still belongs to
     * this user and is still pending.
     *
     * We intentionally DO NOT release it.
     */

    const reservation =
        await getReservation({

            uid:
                authenticatedUid,

            reservationId

        });


    if (!reservation) {

        throw new Error(
            "Airtime wallet reservation could not be found."
        );

    }


    if (
        reservation.status !==
        "pending"
    ) {

        /*
         * The reservation has already reached a terminal
         * state. Do not overwrite that financial state.
         */

        if (
            reservation.status ===
            "committed"
        ) {

            return {

                status:
                    STATUS_SUCCESSFUL,

                transactionId:
                    normalizedTransactionId,

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


        throw new Error(
            "Airtime reservation is no longer pending."
        );

    }


    const updated =
        await updateTransaction(
            normalizedTransactionId,
            {

                status:
                    STATUS_PENDING,

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

                reservationId,

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
            updated.amountKobo,

        network:
            updated.network,

        phoneNumber:
            updated.phoneNumber,

        message:
            providerResult?.message ||
            "Your Airtime request is being processed. Please do not retry yet."

    };

}


// =====================================================
// PURCHASE AIRTIME
// =====================================================
//
// This is the main service entry point.
//
// =====================================================

async function purchaseAirtime({
    uid,
    network,
    phoneNumber,
    amountKobo,
    providerClient
}) {

    const authenticatedUid =
        requireUid(
            uid
        );


    const normalizedNetwork =
        normalizeNetwork(
            network
        );


    const normalizedPhone =
        normalizePhone(
            phoneNumber
        );


    const amount =
        validateAmountKobo(
            amountKobo
        );


    /*
     * Provider client must be injected by the route.
//
//     This keeps this service independent from the actual
     * VTU.ng implementation and makes the boundary explicit.
     */

    if (
        !providerClient ||
        typeof providerClient.purchaseAirtime !==
            "function"
    ) {

        throw new Error(
            "Airtime provider client is not available."
        );

    }


    /*
     * -----------------------------------------------------
     * CREATE UNIQUE NOVAPAY TRANSACTION
     * -----------------------------------------------------
     */

    const transactionId =
        createTransactionId();


    /*
     * -----------------------------------------------------
     * CREATE BUSINESS TRANSACTION
     * -----------------------------------------------------
     */

    let transaction =
        await createInitialTransaction({

            uid:
                authenticatedUid,

            transactionId,

            network:
                normalizedNetwork,

            phoneNumber:
                normalizedPhone,

            amountKobo:
                amount

        });


    /*
     * -----------------------------------------------------
     * RESERVE USER MONEY
     * -----------------------------------------------------
     *
     * reservation.js changes:
     *
     * reservedKobo ↑
     *
     * balanceKobo remains unchanged.
     *
     * Therefore:
     *
     * availableKobo =
     * balanceKobo - reservedKobo
     *
     * This is intentional.
     *
     * The actual permanent debit happens ONLY at commit.
     * -----------------------------------------------------
     */

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

                    network:
                        normalizedNetwork,

                    phoneNumber:
                        normalizedPhone

                }

            });

    }

    catch (error) {

        /*
         * The wallet reservation did not happen.
         *
         * Therefore no money was locked.
         *
         * Mark the business transaction failed.
         */

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

                failureReason:
                    message

            }
        );


        throw error;

    }


    /*
     * -----------------------------------------------------
     * LINK RESERVATION TO TRANSACTION
     * -----------------------------------------------------
     *
     * This is critical.
     *
     * The Airtime transaction must permanently know which
     * wallet reservation belongs to it.
     * -----------------------------------------------------
     */

    transaction =
        await updateTransaction(
            transactionId,
            {

                reservationId:
                    reservation.reservationId,

                status:
                    STATUS_PENDING

            }
        );


    /*
     * -----------------------------------------------------
     * PROVIDER CALL
     * -----------------------------------------------------
     *
     * The provider adapter receives the NovaPay transaction
     * ID and generates its own deterministic provider
     * request ID.
     * -----------------------------------------------------
     */

    let providerResult;


    try {

        providerResult =
            await providerClient.purchaseAirtime({

                transactionId,

                network:
                    normalizedNetwork,

                phoneNumber:
                    normalizedPhone,

                amountKobo:
                    amount

            });

    }

    catch (error) {

        /*
         * IMPORTANT:
         *
         * We DO NOT release the reservation here.
         *
         * The provider adapter treats network errors,
         * timeouts and unknown responses as uncertain.
         *
         * Therefore the customer's money remains reserved
         * until reconciliation can determine the outcome.
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


        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_PENDING,

                providerReference,

                providerStatus,

                providerCode,

                providerOutcome:
                    "unknown",

                reconciliationRequired:
                    true,

                failureReason:
                    ""

            }
        );


        /*
         * Return a pending result rather than exposing the
         * provider's internal error to the frontend.
         */

        return {

            status:
                STATUS_PENDING,

            transactionId,

            amountKobo:
                amount,

            network:
                normalizedNetwork,

            phoneNumber:
                normalizedPhone,

            message:
                "Your Airtime request is being verified. Please do not retry yet."

        };

    }


    /*
     * -----------------------------------------------------
     * NORMALIZE PROVIDER OUTCOME
     * -----------------------------------------------------
     */

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

        return handleProviderSuccess({

            uid:
                authenticatedUid,

            transactionId,

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

        return handleProviderFailure({

            uid:
                authenticatedUid,

            transactionId,

            providerResult

        });

    }


    /*
     * -----------------------------------------------------
     * UNKNOWN / PROCESSING
     * -----------------------------------------------------
     *
     * Reservation remains active.
     * Transaction remains pending.
     * Reconciliation is required.
     * -----------------------------------------------------
     */

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

    purchaseAirtime,

    getAirtimeTransaction

};