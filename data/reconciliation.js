"use strict";

const crypto = require("crypto");

const {
    db
} = require("../firebase-admin");

const {
    reconcileDataTransaction
} = require("./service");

const DATA_TRANSACTIONS_COLLECTION =
    "dataTransactions";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;

const DEFAULT_CLAIM_TTL_MS =
    5 * 60 * 1000;

const DEFAULT_RECONCILIATION_INTERVAL_MS =
    60 * 1000;

let workerTimer = null;
let workerRunning = false;

const WORKER_ID =
    `DATA_RECON_${crypto
        .randomBytes(8)
        .toString("hex")}`;

function createReconciliationError(
    message,
    {
        code = "DATA_RECONCILIATION_ERROR",
        cause = null
    } = {}
) {
    const error =
        new Error(message);

    error.code =
        code;

    if (cause) {
        error.cause =
            cause;
    }

    return error;
}

function normalizeBatchSize(
    value
) {
    const parsed =
        Number.parseInt(
            value,
            10
        );

    if (
        !Number.isInteger(parsed) ||
        parsed <= 0
    ) {
        return DEFAULT_BATCH_SIZE;
    }

    return Math.min(
        parsed,
        MAX_BATCH_SIZE
    );
}

function normalizeClaimTtl(
    value
) {
    const parsed =
        Number.parseInt(
            value,
            10
        );

    if (
        !Number.isInteger(parsed) ||
        parsed <= 0
    ) {
        return DEFAULT_CLAIM_TTL_MS;
    }

    return Math.max(
        30 * 1000,
        parsed
    );
}

function normalizeInterval(
    value
) {
    const parsed =
        Number.parseInt(
            value,
            10
        );

    if (
        !Number.isInteger(parsed) ||
        parsed <= 0
    ) {
        return DEFAULT_RECONCILIATION_INTERVAL_MS;
    }

    return Math.max(
        10 * 1000,
        parsed
    );
}

function isClaimExpired(
    transaction
) {
    const claimedAt =
        transaction?.reconciliationClaimedAt;

    if (!claimedAt) {
        return true;
    }

    let claimedAtMs = null;

    if (
        typeof claimedAt.toMillis ===
        "function"
    ) {
        claimedAtMs =
            claimedAt.toMillis();
    } else if (
        claimedAt instanceof Date
    ) {
        claimedAtMs =
            claimedAt.getTime();
    } else if (
        typeof claimedAt === "number"
    ) {
        claimedAtMs =
            claimedAt;
    } else if (
        typeof claimedAt === "string"
    ) {
        const parsed =
            Date.parse(
                claimedAt
            );

        if (
            Number.isFinite(parsed)
        ) {
            claimedAtMs =
                parsed;
        }
    }

    if (
        !Number.isFinite(
            claimedAtMs
        )
    ) {
        return true;
    }

    const ttl =
        normalizeClaimTtl(
            process.env
                .DATA_RECONCILIATION_CLAIM_TTL_MS
        );

    return (
        Date.now() -
            claimedAtMs >=
        ttl
    );
}

function getTransactionRef(
    transactionId
) {
    if (
        typeof transactionId !==
            "string" ||
        !transactionId.trim()
    ) {
        throw createReconciliationError(
            "Invalid transaction ID.",
            {
                code:
                    "INVALID_TRANSACTION_ID"
            }
        );
    }

    return db
        .collection(
            DATA_TRANSACTIONS_COLLECTION
        )
        .doc(
            transactionId.trim()
        );
}

async function claimTransaction(
    transactionId
) {
    const transactionRef =
        getTransactionRef(
            transactionId
        );

    const claimResult =
        await db.runTransaction(
            async transaction => {
                const snapshot =
                    await transaction.get(
                        transactionRef
                    );

                if (
                    !snapshot.exists
                ) {
                    return {
                        claimed: false,
                        reason:
                            "not_found"
                    };
                }

                const data =
                    snapshot.data();

                if (
                    data.service !==
                    "data"
                ) {
                    return {
                        claimed: false,
                        reason:
                            "not_data"
                    };
                }

                if (
                    data.status ===
                    "successful" ||
                    data.status ===
                    "failed"
                ) {
                    return {
                        claimed: false,
                        reason:
                            "terminal"
                    };
                }

                if (
                    data.reconciliationRequired !==
                    true
                ) {
                    return {
                        claimed: false,
                        reason:
                            "not_required"
                    };
                }

                if (
                    data.reconciliationClaimedBy &&
                    data.reconciliationClaimedBy !==
                        WORKER_ID &&
                    !isClaimExpired(
                        data
                    )
                ) {
                    return {
                        claimed: false,
                        reason:
                            "claimed"
                    };
                }

                const now =
                    new Date();

                transaction.update(
                    transactionRef,
                    {
                        reconciliationClaimedBy:
                            WORKER_ID,
                        reconciliationClaimedAt:
                            now,
                        reconciliationAttempts:
                            (
                                Number(
                                    data.reconciliationAttempts
                                ) || 0
                            ) + 1,
                        updatedAt:
                            now
                    }
                );

                return {
                    claimed: true,
                    uid:
                        data.uid
                };
            }
        );

    return claimResult;
}

async function releaseClaim(
    transactionId
) {
    const transactionRef =
        getTransactionRef(
            transactionId
        );

    try {
        await transactionRef.update({
            reconciliationClaimedBy:
                null,
            reconciliationClaimedAt:
                null,
            updatedAt:
                new Date()
        });
    } catch (error) {
        /*
         * The transaction may already have become
         * terminal during reconciliation. Failure to
         * clear the claim is therefore logged rather
         * than allowed to hide the actual result.
         */
        console.error(
            "Unable to clear Data reconciliation claim:",
            {
                transactionId,
                message:
                    error?.message ||
                    "Unknown error"
            }
        );
    }
}

async function markReconciliationRequired(
    transactionId,
    error
) {
    const transactionRef =
        getTransactionRef(
            transactionId
        );

    await transactionRef.update({
        status: "pending",
        reconciliationRequired:
            true,
        reconciliationClaimedBy:
            null,
        reconciliationClaimedAt:
            null,
        reconciliationError:
            error?.message ||
            "Reconciliation failed.",
        reconciliationErrorCode:
            error?.code ||
            "DATA_RECONCILIATION_ERROR",
        updatedAt:
            new Date()
    });
}

async function reconcileOne(
    transactionId
) {
    const claim =
        await claimTransaction(
            transactionId
        );

    if (
        !claim.claimed
    ) {
        return {
            transactionId,
            status: "skipped",
            reason:
                claim.reason
        };
    }

    try {
        /*
         * The service performs the authoritative
         * provider requery and reservation handling.
         *
         * It commits only on confirmed provider success,
         * releases only on confirmed provider failure,
         * and keeps unknown outcomes pending.
         */
        const result =
            await reconcileDataTransaction({
                uid:
                    claim.uid,
                transactionId
            });

        await releaseClaim(
            transactionId
        );

        return {
            transactionId,
            status:
                result.status ||
                "pending",
            result
        };
    } catch (error) {
        /*
         * Never convert a reconciliation error into
         * a wallet release.
         *
         * The transaction remains pending and will be
         * retried on a later worker pass.
         */
        try {
            await markReconciliationRequired(
                transactionId,
                error
            );
        } catch (markError) {
            console.error(
                "Unable to preserve Data reconciliation state:",
                {
                    transactionId,
                    message:
                        markError?.message ||
                        "Unknown error"
                }
            );
        }

        return {
            transactionId,
            status: "pending",
            error:
                error?.message ||
                "Reconciliation failed."
        };
    }
}

async function getPendingTransactions(
    batchSize
) {
    const limit =
        normalizeBatchSize(
            batchSize
        );

    /*
     * We intentionally query by status only.
     *
     * This avoids requiring a composite Firestore
     * index for the recovery worker.
     */
    const snapshot =
        await db
            .collection(
                DATA_TRANSACTIONS_COLLECTION
            )
            .where(
                "status",
                "==",
                "pending"
            )
            .limit(limit)
            .get();

    const transactions = [];

    for (const document of snapshot.docs) {
        const data =
            document.data();

        if (
            data.service !==
            "data"
        ) {
            continue;
        }

        if (
            data.reconciliationRequired !==
            true
        ) {
            continue;
        }

        if (
            !data.uid ||
            typeof data.uid !==
                "string"
        ) {
            continue;
        }

        transactions.push({
            id:
                document.id,
            ...data
        });
    }

    return transactions;
}

async function runReconciliationBatch({
    batchSize = DEFAULT_BATCH_SIZE
} = {}) {
    if (workerRunning) {
        return {
            running: true,
            processed: 0,
            skipped: true,
            reason:
                "A reconciliation batch is already running."
        };
    }

    workerRunning = true;

    const startedAt =
        Date.now();

    const summary = {
        running: false,
        processed: 0,
        successful: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        errors: 0,
        durationMs: 0
    };

    try {
        const transactions =
            await getPendingTransactions(
                batchSize
            );

        for (
            const transaction
            of transactions
        ) {
            const result =
                await reconcileOne(
                    transaction.id
                );

            summary.processed += 1;

            if (
                result.status ===
                "successful"
            ) {
                summary.successful += 1;
            } else if (
                result.status ===
                "failed"
            ) {
                summary.failed += 1;
            } else if (
                result.status ===
                "pending"
            ) {
                summary.pending += 1;
            } else if (
                result.status ===
                "skipped"
            ) {
                summary.skipped += 1;
            }

            if (result.error) {
                summary.errors += 1;
            }
        }

        return summary;
    } finally {
        summary.durationMs =
            Date.now() -
            startedAt;

        workerRunning = false;
    }
}

function startReconciliationWorker({
    intervalMs =
        normalizeInterval(
            process.env
                .DATA_RECONCILIATION_INTERVAL_MS
        ),
    batchSize =
        normalizeBatchSize(
            process.env
                .DATA_RECONCILIATION_BATCH_SIZE
        ),
    runImmediately = true
} = {}) {
    if (workerTimer) {
        return {
            started: false,
            reason:
                "Data reconciliation worker is already running.",
            workerId:
                WORKER_ID
        };
    }

    const normalizedInterval =
        normalizeInterval(
            intervalMs
        );

    const normalizedBatchSize =
        normalizeBatchSize(
            batchSize
        );

    const execute =
        async () => {
            try {
                const result =
                    await runReconciliationBatch({
                        batchSize:
                            normalizedBatchSize
                    });

                if (
                    result.processed >
                    0
                ) {
                    console.log(
                        "Data reconciliation batch completed:",
                        result
                    );
                }
            } catch (error) {
                console.error(
                    "Data reconciliation worker error:",
                    {
                        code:
                            error?.code ||
                            "DATA_RECONCILIATION_ERROR",
                        message:
                            error?.message ||
                            "Unknown error"
                    }
                );
            }
        };

    if (runImmediately) {
        void execute();
    }

    workerTimer =
        setInterval(
            execute,
            normalizedInterval
        );

    workerTimer.unref?.();

    console.log(
        "Data reconciliation worker started:",
        {
            workerId:
                WORKER_ID,
            intervalMs:
                normalizedInterval,
            batchSize:
                normalizedBatchSize
        }
    );

    return {
        started: true,
        workerId:
            WORKER_ID,
        intervalMs:
            normalizedInterval,
        batchSize:
            normalizedBatchSize
    };
}

function stopReconciliationWorker() {
    if (!workerTimer) {
        return {
            stopped: false,
            reason:
                "Data reconciliation worker is not running."
        };
    }

    clearInterval(
        workerTimer
    );

    workerTimer = null;

    console.log(
        "Data reconciliation worker stopped:",
        {
            workerId:
                WORKER_ID
        }
    );

    return {
        stopped: true,
        workerId:
            WORKER_ID
    };
}

function getWorkerInfo() {
    return {
        workerId:
            WORKER_ID,
        running:
            workerRunning,
        scheduled:
            Boolean(workerTimer),
        batchSize:
            normalizeBatchSize(
                process.env
                    .DATA_RECONCILIATION_BATCH_SIZE
            ),
        intervalMs:
            normalizeInterval(
                process.env
                    .DATA_RECONCILIATION_INTERVAL_MS
            ),
        claimTtlMs:
            normalizeClaimTtl(
                process.env
                    .DATA_RECONCILIATION_CLAIM_TTL_MS
            )
    };
}

module.exports = {
    runReconciliationBatch,
    reconcileOne,
    startReconciliationWorker,
    stopReconciliationWorker,
    getWorkerInfo
};