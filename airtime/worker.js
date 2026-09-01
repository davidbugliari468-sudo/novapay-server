// airtime/worker.js

const {
    findTransactionsRequiringReconciliation,
    reconcileAirtimeTransaction
} = require("./reconciliation");


// =====================================================
// NOVAPAY — AIRTIME RECONCILIATION WORKER
// =====================================================
//
// RESPONSIBILITY
//
// This module runs reconciliation jobs for Airtime
// transactions whose provider result is uncertain.
//
// It does NOT:
//
// - create Airtime purchases
// - directly modify wallet balances
// - release funds because of a timeout
// - commit funds because a request was sent
// - trust frontend information
//
// It ONLY:
//
// 1. finds pending transactions requiring reconciliation
// 2. asks the provider adapter for the current status
// 3. allows reconciliation.js to determine the financial
//    outcome
//
// FINANCIAL CONTROL:
//
// reconciliation.js
//        ↓
// reservation.js
//        ↓
// wallet
//
// The worker never bypasses that chain.
//
// =====================================================


// =====================================================
// CONSTANTS
// =====================================================

const DEFAULT_BATCH_SIZE =
    25;

const MAX_BATCH_SIZE =
    100;


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
// VALIDATE PROVIDER CLIENT
// =====================================================
//
// The worker receives the provider adapter through
// dependency injection.
//
// This keeps worker.js independent from VTU.ng secrets,
// HTTP implementation and provider-specific details.
//
// =====================================================

function requireProviderClient(
    providerClient
) {

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


    return providerClient;

}


// =====================================================
// NORMALIZE BATCH SIZE
// =====================================================

function normalizeBatchSize(
    value
) {

    const parsed =
        Number(
            value
        );


    if (
        !Number.isInteger(
            parsed
        ) ||
        parsed <= 0
    ) {

        return DEFAULT_BATCH_SIZE;

    }


    return Math.min(
        parsed,
        MAX_BATCH_SIZE
    );

}


// =====================================================
// RECONCILE ONE TRANSACTION
// =====================================================
//
// This function intentionally delegates the actual
// financial decision to reconciliation.js.
//
// =====================================================

async function reconcileOne({
    transaction,
    providerClient
}) {

    if (
        !transaction ||
        typeof transaction !==
        "object"
    ) {

        throw createError(
            "Invalid Airtime reconciliation transaction."
        );

    }


    if (
        !transaction.id
    ) {

        throw createError(
            "Airtime reconciliation transaction ID is missing."
        );

    }


    const client =
        requireProviderClient(
            providerClient
        );


    return reconcileAirtimeTransaction({

        uid:
            transaction.uid,

        transactionId:
            transaction.id,

        providerClient:
            client

    });

}


// =====================================================
// RUN RECONCILIATION BATCH
// =====================================================
//
// This function processes one bounded batch.
//
// IMPORTANT:
//
// A failure for one transaction does NOT stop the worker
// from attempting the remaining transactions.
//
// This is important for financial recovery jobs.
//
// =====================================================

async function runReconciliationBatch({
    providerClient,
    limit = DEFAULT_BATCH_SIZE
} = {}) {

    const client =
        requireProviderClient(
            providerClient
        );


    const batchSize =
        normalizeBatchSize(
            limit
        );


    const transactions =
        await findTransactionsRequiringReconciliation({

            limit:
                batchSize

        });


    const results = [];

    const errors = [];


    /*
     * Process sequentially.
     *
     * This deliberately avoids launching a large number
     * of provider status requests simultaneously.
     *
     * A financial reconciliation worker should prefer
     * controlled execution over uncontrolled concurrency.
     */

    for (
        const transaction
        of transactions
    ) {

        try {

            const result =
                await reconcileOne({

                    transaction,

                    providerClient:
                        client

                });


            results.push({

                transactionId:
                    transaction.id,

                uid:
                    transaction.uid,

                result

            });

        }

        catch (error) {

            errors.push({

                transactionId:
                    transaction.id,

                uid:
                    transaction.uid,

                message:
                    String(
                        error?.message ||
                        "Airtime reconciliation failed."
                    )
                        .trim()
                        .slice(
                            0,
                            300
                        )

            });

        }

    }


    return {

        scanned:
            transactions.length,

        processed:
            results.length,

        failed:
            errors.length,

        results,

        errors

    };

}


// =====================================================
// RUN SINGLE TRANSACTION RECONCILIATION
// =====================================================
//
// This helper is useful when an internal system already
// knows the exact transaction that requires reconciliation.
//
// =====================================================

async function runSingleReconciliation({
    uid,
    transactionId,
    providerClient
}) {

    if (
        typeof uid !==
            "string" ||
        !uid.trim()
    ) {

        throw createError(
            "Authenticated user ID is required.",
            401
        );

    }


    if (
        typeof transactionId !==
            "string" ||
        !transactionId.trim()
    ) {

        throw createError(
            "Airtime transaction ID is required.",
            400
        );

    }


    const client =
        requireProviderClient(
            providerClient
        );


    return reconcileAirtimeTransaction({

        uid:
            uid.trim(),

        transactionId:
            transactionId.trim(),

        providerClient:
            client

    });

}


// =====================================================
// WORKER HEALTH INFORMATION
// =====================================================
//
// This is intentionally static.
//
// It can be used by an internal health/diagnostic layer
// without exposing provider credentials or wallet data.
//
// =====================================================

function getWorkerInfo() {

    return {

        service:
            "airtime",

        worker:
            "reconciliation",

        enabled:
            true,

        defaultBatchSize:
            DEFAULT_BATCH_SIZE,

        maxBatchSize:
            MAX_BATCH_SIZE

    };

}


// =====================================================
// MODULE EXPORTS
// =====================================================

module.exports = {

    runReconciliationBatch,

    runSingleReconciliation,

    getWorkerInfo

};