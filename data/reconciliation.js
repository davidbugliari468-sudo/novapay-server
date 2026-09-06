"use strict";

const { db } = require("../firebase-admin");

const babspay = require("./provider/babspay");

const {
    getReservation,
    commitReservation,
    releaseReservation
} = require("../wallet/reservation");

const DATA_TRANSACTIONS_COLLECTION =
    "dataTransactions";

const SERVICE_NAME = "data";
const PROVIDER_NAME = "babspay";

const STATUS_PENDING = "pending";
const STATUS_UNKNOWN = "unknown";
const STATUS_SUCCESSFUL = "successful";
const STATUS_FAILED = "failed";

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const RECONCILIATION_INTERVAL_MS =
    parseIntegerEnv(
        "DATA_RECONCILIATION_INTERVAL_MS",
        DEFAULT_INTERVAL_MS,
        10_000,
        60 * 60 * 1000
    );

const RECONCILIATION_BATCH_SIZE =
    parseIntegerEnv(
        "DATA_RECONCILIATION_BATCH_SIZE",
        DEFAULT_BATCH_SIZE,
        1,
        100
    );

const RECONCILIATION_MAX_AGE_MS =
    parseIntegerEnv(
        "DATA_RECONCILIATION_MAX_AGE_MS",
        DEFAULT_MAX_AGE_MS,
        60 * 1000,
        7 * 24 * 60 * 60 * 1000
    );

let workerRunning = false;
let workerTimer = null;

function parseIntegerEnv(
    name,
    fallback,
    minimum,
    maximum
) {
    const raw =
        process.env[name];

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
        value < minimum ||
        value > maximum
    ) {
        throw new Error(
            `Invalid ${name} configuration`
        );
    }

    return value;
}

function createError(
    message,
    code = "DATA_RECONCILIATION_ERROR"
) {
    const error =
        new Error(message);

    error.code = code;

    return error;
}

function normalizeOutcome(
    result
) {
    if (
        !result ||
        typeof result !== "object"
    ) {
        return {
            outcome:
                STATUS_UNKNOWN,
            providerReference:
                null,
            message:
                "Invalid provider requery response."
        };
    }

    const rawOutcome =
        String(
            result.outcome ||
            result.status ||
            ""
        )
            .trim()
            .toLowerCase();

    const providerReference =
        normalizeProviderReference(
            result.providerReference ||
            result.ref ||
            result.reference ||
            result.transref ||
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
        rawOutcome ===
            STATUS_SUCCESSFUL ||
        rawOutcome === "success"
    ) {
        return {
            outcome:
                STATUS_SUCCESSFUL,
            providerReference,
            message
        };
    }

    if (
        rawOutcome ===
            STATUS_FAILED ||
        rawOutcome === "failed" ||
        rawOutcome === "fail" ||
        rawOutcome === "failure" ||
        rawOutcome === "reversed" ||
        rawOutcome === "reverse"
    ) {
        return {
            outcome:
                STATUS_FAILED,
            providerReference,
            message
        };
    }

    if (
        rawOutcome ===
            STATUS_PENDING ||
        rawOutcome === "processing" ||
        rawOutcome === "queued"
    ) {
        return {
            outcome:
                STATUS_PENDING,
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

function normalizeProviderReference(
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

function getTransactionRef(
    transactionId
) {
    return db
        .collection(
            DATA_TRANSACTIONS_COLLECTION
        )
        .doc(transactionId);
}

async function getTransaction(
    transactionId
) {
    const transactionRef =
        getTransactionRef(
            transactionId
        );

    const snapshot =
        await transactionRef.get();

    if (!snapshot.exists) {
        return null;
    }

    return {
        id:
            snapshot.id,
        ...snapshot.data()
    };
}

async function updateTransaction(
    transactionId,
    updates
) {
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

function transactionIdFromDocument(
    document
) {
    if (
        document &&
        document.id
    ) {
        return document.id;
    }

    return null;
}

function reservationMatchesTransaction(
    reservation,
    transaction
) {
    if (
        !reservation ||
        !transaction
    ) {
        return false;
    }

    if (
        reservation.uid !==
        transaction.uid
    ) {
        return false;
    }

    if (
        reservation.reference !==
        transaction.reference
    ) {
        return false;
    }

    if (
        reservation.service !==
        SERVICE_NAME
    ) {
        return false;
    }

    if (
        reservation.id !==
        transaction.reservationId
    ) {
        return false;
    }

    if (
        reservation.amountKobo !==
        transaction.customerPriceKobo
    ) {
        return false;
    }

    return true;
}

function metadataMatchesTransaction(
    reservation,
    transaction
) {
    const metadata =
        reservation &&
        reservation.metadata;

    if (
        !metadata ||
        typeof metadata !==
            "object"
    ) {
        return false;
    }

    if (
        String(
            metadata.provider || ""
        ).toLowerCase() !==
        PROVIDER_NAME
    ) {
        return false;
    }

    if (
        String(
            metadata.planId || ""
        ) !==
        String(
            transaction.planId || ""
        )
    ) {
        return false;
    }

    if (
        String(
            metadata.networkId || ""
        ) !==
        String(
            transaction.networkId || ""
        )
    ) {
        return false;
    }

    if (
        metadata.providerPriceKobo !==
        transaction.providerPriceKobo
    ) {
        return false;
    }

    if (
        metadata.customerPriceKobo !==
        transaction.customerPriceKobo
    ) {
        return false;
    }

    if (
        String(
            metadata.phoneNumber || ""
        ) !==
        String(
            transaction.phoneNumber || ""
        )
    ) {
        return false;
    }

    return true;
}

async function safelyLoadReservation(
    transaction
) {
    if (
        !transaction.reservationId
    ) {
        throw createError(
            "Data transaction has no reservation ID.",
            "MISSING_RESERVATION_ID"
        );
    }

    const reservation =
        await getReservation(
            transaction.reservationId
        );

    if (
        !reservationMatchesTransaction(
            reservation,
            transaction
        )
    ) {
        throw createError(
            "Reservation does not match the Data transaction.",
            "RESERVATION_TRANSACTION_MISMATCH"
        );
    }

    if (
        !metadataMatchesTransaction(
            reservation,
            transaction
        )
    ) {
        throw createError(
            "Reservation metadata does not match the Data transaction.",
            "RESERVATION_METADATA_MISMATCH"
        );
    }

    return reservation;
}

async function reconcileTransaction(
    transaction
) {
    if (
        !transaction ||
        typeof transaction !==
            "object"
    ) {
        throw createError(
            "Invalid Data transaction."
        );
    }

    const transactionId =
        transaction.id;

    if (!transactionId) {
        throw createError(
            "Data transaction ID is missing."
        );
    }

    if (
        transaction.service !==
        SERVICE_NAME
    ) {
        return {
            ok:
                false,
            status:
                "ignored",
            transactionId
        };
    }

    if (
        transaction.status ===
            STATUS_SUCCESSFUL ||
        transaction.status ===
            STATUS_FAILED
    ) {
        return {
            ok:
                true,
            status:
                transaction.status,
            transactionId
        };
    }

    let reservation;

    try {
        reservation =
            await safelyLoadReservation(
                transaction
            );
    } catch (error) {
        await updateTransaction(
            transactionId,
            {
                reconciliationRequired:
                    true,
                reconciliationError:
                    error.code ||
                    "RESERVATION_VALIDATION_ERROR"
            }
        );

        return {
            ok:
                false,
            status:
                STATUS_UNKNOWN,
            transactionId,
            error:
                error.code
        };
    }

    /*
     * If the wallet reservation is already committed,
     * the financial side is already final.
     *
     * We can safely synchronize the Data transaction
     * without touching the wallet again.
     */
    if (
        reservation.status ===
        "committed"
    ) {
        await updateTransaction(
            transactionId,
            {
                status:
                    STATUS_SUCCESSFUL,

                reconciliationRequired:
                    false,

                completedAt:
                    transaction.completedAt ||
                    new Date(),

                walletReservationStatus:
                    "committed",

                reconciliationError:
                    null
            }
        );

        return {
            ok:
                true,
            status:
                STATUS_SUCCESSFUL,
            transactionId
        };
    }

    /*
     * A released reservation means the wallet has
     * already been restored.
     *
     * Never call release again.
     */
    if (
        reservation.status ===
        "released"
    ) {
        await updateTransaction(
            transactionId,
            {
                status:
                    STATUS_FAILED,

                reconciliationRequired:
                    false,

                completedAt:
                    transaction.completedAt ||
                    new Date(),

                walletReservationStatus:
                    "released",

                reconciliationError:
                    null
            }
        );

        return {
            ok:
                true,
            status:
                STATUS_FAILED,
            transactionId
        };
    }

    /*
     * Only pending reservations are eligible for
     * provider requery.
     */
    if (
        reservation.status !==
        "pending"
    ) {
        await updateTransaction(
            transactionId,
            {
                reconciliationRequired:
                    true,

                reconciliationError:
                    "INVALID_RESERVATION_STATE"
            }
        );

        return {
            ok:
                false,
            status:
                STATUS_UNKNOWN,
            transactionId
        };
    }

    /*
     * BabsPay's purchase reference is our own unique
     * reference unless a confirmed provider reference
     * has already been recorded.
     */
    const providerReference =
        normalizeProviderReference(
            transaction.providerReference
        );

    const requeryReference =
        providerReference ||
        transaction.reference;

    if (!requeryReference) {
        await updateTransaction(
            transactionId,
            {
                status:
                    STATUS_UNKNOWN,

                reconciliationRequired:
                    true,

                reconciliationError:
                    "MISSING_REQUERY_REFERENCE"
            }
        );

        return {
            ok:
                false,
            status:
                STATUS_UNKNOWN,
            transactionId
        };
    }

    let providerResult;

    try {
        /*
         * BabsPay:
         *
         * GET /api/transaction/status?reference=...
         *
         * The provider adapter owns the actual HTTP
         * authentication and response interpretation.
         */
        providerResult =
            await babspay.requeryTransaction({
                reference:
                    requeryReference
            });
    } catch (error) {
        /*
         * A failed requery does NOT prove failure.
         *
         * Keep the reservation locked and try again
         * during the next reconciliation cycle.
         */
        await updateTransaction(
            transactionId,
            {
                status:
                    STATUS_UNKNOWN,

                reconciliationRequired:
                    true,

                reconciliationError:
                    "PROVIDER_REQUERY_UNAVAILABLE"
            }
        );

        return {
            ok:
                false,
            status:
                STATUS_UNKNOWN,
            transactionId
        };
    }

    /*
     * A provider "not found" or otherwise ambiguous
     * response must not release customer funds.
     */
    const outcome =
        normalizeOutcome(
            providerResult
        );

    if (
        outcome.outcome ===
        STATUS_SUCCESSFUL
    ) {
        /*
         * Provider explicitly confirms success.
         *
         * Verify that any returned provider
         * reference is consistent with what we already
         * recorded.
         */
        if (
            transaction.providerReference &&
            outcome.providerReference &&
            transaction.providerReference !==
                outcome.providerReference
        ) {
            await updateTransaction(
                transactionId,
                {
                    status:
                        STATUS_UNKNOWN,

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        "PROVIDER_REFERENCE_MISMATCH"
                }
            );

            return {
                ok:
                    false,
                status:
                    STATUS_UNKNOWN,
                transactionId
            };
        }

        /*
         * Commit is idempotent. If another process
         * committed immediately before this one, the
         * reservation implementation returns the
         * committed state rather than debiting twice.
         */
        let committed;

        try {
            committed =
                await commitReservation({
                    uid:
                        transaction.uid,

                    reservationId:
                        transaction.reservationId,

                    provider:
                        PROVIDER_NAME
                });
        } catch (error) {
            /*
             * Never release after provider success.
             *
             * If wallet commitment fails, leave the
             * reservation pending and flag it for the
             * next reconciliation attempt/manual review.
             */
            await updateTransaction(
                transactionId,
                {
                    status:
                        STATUS_UNKNOWN,

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        error.code ||
                        "WALLET_COMMIT_FAILED",

                    providerReference:
                        outcome.providerReference ||
                        transaction.providerReference ||
                        null
                }
            );

            return {
                ok:
                    false,
                status:
                    STATUS_UNKNOWN,
                transactionId
            };
        }

        await updateTransaction(
            transactionId,
            {
                status:
                    STATUS_SUCCESSFUL,

                providerReference:
                    outcome.providerReference ||
                    transaction.providerReference ||
                    null,

                providerMessage:
                    outcome.message ||
                    "Data purchase confirmed successfully.",

                reconciliationRequired:
                    false,

                reconciliationError:
                    null,

                completedAt:
                    new Date(),

                walletReservationStatus:
                    committed.status
            }
        );

        return {
            ok:
                true,
            status:
                STATUS_SUCCESSFUL,
            transactionId
        };
    }

    if (
        outcome.outcome ===
        STATUS_FAILED
    ) {
        /*
         * An explicit provider failure/reversal is the
         * only normal condition here that permits us to
         * release the wallet hold.
         */
        let released;

        try {
            released =
                await releaseReservation({
                    uid:
                        transaction.uid,

                    reservationId:
                        transaction.reservationId,

                    reason:
                        outcome.message ||
                        "BabsPay confirmed Data transaction failure.",

                    provider:
                        PROVIDER_NAME
                });
        } catch (error) {
            /*
             * If release fails, DO NOT mark the
             * transaction failed as though the wallet
             * was restored.
             *
             * The customer funds remain reserved until
             * release succeeds.
             */
            await updateTransaction(
                transactionId,
                {
                    status:
                        STATUS_UNKNOWN,

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        error.code ||
                        "WALLET_RELEASE_FAILED",

                    providerReference:
                        outcome.providerReference ||
                        transaction.providerReference ||
                        null
                }
            );

            return {
                ok:
                    false,
                status:
                    STATUS_UNKNOWN,
                transactionId
            };
        }

        await updateTransaction(
            transactionId,
            {
                status:
                    STATUS_FAILED,

                providerReference:
                    outcome.providerReference ||
                    transaction.providerReference ||
                    null,

                providerMessage:
                    outcome.message ||
                    "BabsPay confirmed Data transaction failure.",

                reconciliationRequired:
                    false,

                reconciliationError:
                    null,

                completedAt:
                    new Date(),

                walletReservationStatus:
                    released.status
            }
        );

        return {
            ok:
                true,
            status:
                STATUS_FAILED,
            transactionId
        };
    }

    /*
     * Pending, not-found, malformed, or otherwise
     * ambiguous provider results stay unresolved.
     *
     * NEVER release the wallet here.
     */
    await updateTransaction(
        transactionId,
        {
            status:
                outcome.outcome ===
                STATUS_PENDING
                    ? STATUS_PENDING
                    : STATUS_UNKNOWN,

            providerReference:
                outcome.providerReference ||
                transaction.providerReference ||
                null,

            providerMessage:
                outcome.message ||
                "BabsPay transaction is not yet conclusively resolved.",

            reconciliationRequired:
                true,

            reconciliationError:
                null
        }
    );

    return {
        ok:
            false,
        status:
            outcome.outcome ===
            STATUS_PENDING
                ? STATUS_PENDING
                : STATUS_UNKNOWN,
        transactionId
    };
}

function getEligibleQueryDate() {
    return new Date(
        Date.now() -
            RECONCILIATION_MAX_AGE_MS
    );
}

async function findTransactionsForReconciliation() {
    const cutoff =
        getEligibleQueryDate();

    /*
     * Two separate queries are used because Firestore
     * does not need a compound "status IN" query here.
     */
    const [pendingSnapshot, unknownSnapshot] =
        await Promise.all([
            db
                .collection(
                    DATA_TRANSACTIONS_COLLECTION
                )
                .where(
                    "service",
                    "==",
                    SERVICE_NAME
                )
                .where(
                    "status",
                    "==",
                    STATUS_PENDING
                )
                .where(
                    "createdAt",
                    ">=",
                    cutoff
                )
                .orderBy(
                    "createdAt",
                    "asc"
                )
                .limit(
                    RECONCILIATION_BATCH_SIZE
                )
                .get(),

            db
                .collection(
                    DATA_TRANSACTIONS_COLLECTION
                )
                .where(
                    "service",
                    "==",
                    SERVICE_NAME
                )
                .where(
                    "status",
                    "==",
                    STATUS_UNKNOWN
                )
                .where(
                    "createdAt",
                    ">=",
                    cutoff
                )
                .orderBy(
                    "createdAt",
                    "asc"
                )
                .limit(
                    RECONCILIATION_BATCH_SIZE
                )
                .get()
        ]);

    const records =
        new Map();

    for (
        const document of
        pendingSnapshot.docs
    ) {
        records.set(
            document.id,
            {
                id:
                    document.id,
                ...document.data()
            }
        );
    }

    for (
        const document of
        unknownSnapshot.docs
    ) {
        records.set(
            document.id,
            {
                id:
                    document.id,
                ...document.data()
            }
        );
    }

    return Array.from(
        records.values()
    )
        .sort(
            (a, b) => {
                const aTime =
                    a.createdAt &&
                    typeof a.createdAt.toMillis ===
                        "function"
                        ? a.createdAt.toMillis()
                        : 0;

                const bTime =
                    b.createdAt &&
                    typeof b.createdAt.toMillis ===
                        "function"
                        ? b.createdAt.toMillis()
                        : 0;

                return aTime - bTime;
            }
        )
        .slice(
            0,
            RECONCILIATION_BATCH_SIZE
        );
}

async function reconcileBatch() {
    const transactions =
        await findTransactionsForReconciliation();

    if (
        transactions.length === 0
    ) {
        return {
            scanned:
                0,
            successful:
                0,
            failed:
                0,
            pending:
                0,
            unknown:
                0,
            errors:
                0
        };
    }

    const summary = {
        scanned:
            transactions.length,
        successful:
            0,
        failed:
            0,
        pending:
            0,
        unknown:
            0,
        errors:
            0
    };

    for (
        const transaction of
        transactions
    ) {
        try {
            const result =
                await reconcileTransaction(
                    transaction
                );

            if (
                result.status ===
                STATUS_SUCCESSFUL
            ) {
                summary.successful += 1;
            } else if (
                result.status ===
                STATUS_FAILED
            ) {
                summary.failed += 1;
            } else if (
                result.status ===
                STATUS_PENDING
            ) {
                summary.pending += 1;
            } else {
                summary.unknown += 1;
            }
        } catch (error) {
            summary.errors += 1;

            try {
                await updateTransaction(
                    transaction.id,
                    {
                        reconciliationRequired:
                            true,

                        reconciliationError:
                            error.code ||
                            "RECONCILIATION_ERROR"
                    }
                );
            } catch {
                /*
                 * Nothing else is safe to do here.
                 *
                 * Most importantly, this worker never
                 * releases funds simply because an internal
                 * reconciliation operation failed.
                 */
            }
        }
    }

    return summary;
}

async function runReconciliationOnce() {
    if (workerRunning) {
        return {
            skipped:
                true,
            reason:
                "Reconciliation worker is already running."
        };
    }

    workerRunning = true;

    try {
        const summary =
            await reconcileBatch();

        console.log(
            "Data reconciliation completed:",
            summary
        );

        return summary;
    } catch (error) {
        console.error(
            "Data reconciliation failed:",
            error.message
        );

        return {
            scanned:
                0,
            successful:
                0,
            failed:
                0,
            pending:
                0,
            unknown:
                0,
            errors:
                1
        };
    } finally {
        workerRunning = false;
    }
}

function startReconciliationWorker() {
    if (workerTimer) {
        return {
            running:
                true,
            intervalMs:
                RECONCILIATION_INTERVAL_MS,
            batchSize:
                RECONCILIATION_BATCH_SIZE,
            maxAgeMs:
                RECONCILIATION_MAX_AGE_MS
        };
    }

    workerTimer =
        setInterval(
            () => {
                runReconciliationOnce()
                    .catch((error) => {
                        console.error(
                            "Unhandled Data reconciliation error:",
                            error.message
                        );
                    });
            },
            RECONCILIATION_INTERVAL_MS
        );

    /*
     * Do not keep Node alive solely because of the
     * reconciliation timer. The server itself owns
     * the process lifetime.
     */
    if (
        workerTimer &&
        typeof workerTimer.unref ===
            "function"
    ) {
        workerTimer.unref();
    }

    console.log(
        "Data reconciliation worker started:",
        {
            intervalMs:
                RECONCILIATION_INTERVAL_MS,
            batchSize:
                RECONCILIATION_BATCH_SIZE,
            maxAgeMs:
                RECONCILIATION_MAX_AGE_MS
        }
    );

    return {
        running:
            true,
        intervalMs:
            RECONCILIATION_INTERVAL_MS,
        batchSize:
            RECONCILIATION_BATCH_SIZE,
        maxAgeMs:
            RECONCILIATION_MAX_AGE_MS
    };
}

function stopReconciliationWorker() {
    if (workerTimer) {
        clearInterval(
            workerTimer
        );

        workerTimer = null;
    }

    return {
        running:
            false
    };
}

module.exports = {
    reconcileTransaction,
    reconcileBatch,
    runReconciliationOnce,
    startReconciliationWorker,
    stopReconciliationWorker
};