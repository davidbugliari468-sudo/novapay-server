"use strict";

const crypto = require("crypto");

const {
    validatePurchaseInput
} = require("./validation");

const {
    findDataPlan,
    getDataCatalog
} = require("./catalog");

const {
    purchaseData,
    requeryData,
    VtuProviderError
} = require("./provider/vtu");

const {
    reserveFunds,
    getReservation,
    commitReservation,
    releaseReservation
} = require("../wallet/reservation");

const {
    db
} = require("../firebase-admin");

const TRANSACTIONS_COLLECTION = "dataTransactions";
const CURRENCY = "NGN";

const UNKNOWN_RETRY_AFTER_SECONDS = 30;

function createServiceError(
    message,
    {
        code = "DATA_PURCHASE_ERROR",
        statusCode = 400,
        details = null,
        cause = null
    } = {}
) {
    const error = new Error(message);

    error.code = code;
    error.statusCode = statusCode;

    if (details !== null) {
        error.details = details;
    }

    if (cause !== null) {
        error.cause = cause;
    }

    return error;
}

function requireUid(uid) {
    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {
        throw createServiceError(
            "Authentication is required.",
            {
                code: "AUTH_REQUIRED",
                statusCode: 401
            }
        );
    }

    return uid.trim();
}

function requireTransactionId(transactionId) {
    if (
        typeof transactionId !== "string" ||
        !transactionId.trim()
    ) {
        throw createServiceError(
            "A transaction ID is required.",
            {
                code: "INVALID_TRANSACTION_ID",
                statusCode: 400
            }
        );
    }

    const normalized =
        transactionId.trim();

    if (
        normalized.length > 200 ||
        !/^[A-Za-z0-9._:-]+$/.test(
            normalized
        )
    ) {
        throw createServiceError(
            "Invalid transaction ID.",
            {
                code: "INVALID_TRANSACTION_ID",
                statusCode: 400
            }
        );
    }

    return normalized;
}

function requireReference(reference) {
    if (
        typeof reference !== "string" ||
        !reference.trim()
    ) {
        throw createServiceError(
            "A purchase reference is required.",
            {
                code: "REFERENCE_REQUIRED",
                statusCode: 400
            }
        );
    }

    const normalized =
        reference.trim();

    if (
        normalized.length > 150 ||
        !/^[A-Za-z0-9._:-]+$/.test(
            normalized
        )
    ) {
        throw createServiceError(
            "Invalid transaction reference.",
            {
                code: "INVALID_REFERENCE",
                statusCode: 400
            }
        );
    }

    return normalized;
}

function toPlainPlan(plan) {
    if (
        !plan ||
        typeof plan !== "object"
    ) {
        throw createServiceError(
            "The selected data plan is invalid.",
            {
                code: "INVALID_DATA_PLAN",
                statusCode: 500
            }
        );
    }

    const requiredFields = [
        "planId",
        "variationId",
        "network",
        "provider",
        "dataPlan",
        "dataAmount",
        "validityLabel",
        "category",
        "customerPriceKobo"
    ];

    for (const field of requiredFields) {
        if (
            plan[field] === undefined ||
            plan[field] === null
        ) {
            throw createServiceError(
                "The selected data plan is incomplete.",
                {
                    code: "INVALID_DATA_PLAN",
                    statusCode: 500,
                    details: {
                        missingField: field
                    }
                }
            );
        }
    }

    if (
        !Number.isSafeInteger(
            plan.customerPriceKobo
        ) ||
        plan.customerPriceKobo <= 0
    ) {
        throw createServiceError(
            "The selected data plan has an invalid price.",
            {
                code: "INVALID_DATA_PLAN",
                statusCode: 500
            }
        );
    }

    if (
        !Number.isSafeInteger(
            plan.priceKobo
        ) ||
        plan.priceKobo <= 0
    ) {
        throw createServiceError(
            "The selected data plan has an invalid provider price.",
            {
                code: "INVALID_DATA_PLAN",
                statusCode: 500
            }
        );
    }

    if (
        plan.customerPriceKobo !==
        plan.priceKobo
    ) {
        throw createServiceError(
            "The selected data plan has inconsistent pricing.",
            {
                code: "DATA_PLAN_PRICE_MISMATCH",
                statusCode: 500
            }
        );
    }

    return Object.freeze({
        planId:
            String(plan.planId),

        provider:
            String(plan.provider),

        variationId:
            String(plan.variationId),

        network:
            String(plan.network),

        serviceName:
            String(
                plan.serviceName ||
                ""
            ),

        dataPlan:
            String(plan.dataPlan),

        dataAmount:
            String(plan.dataAmount),

        dataAmountValue:
            plan.dataAmountValue ?? null,

        dataAmountUnit:
            plan.dataAmountUnit ?? null,

        validityDays:
            plan.validityDays ?? null,

        validityLabel:
            String(plan.validityLabel),

        category:
            String(plan.category),

        isHot:
            Boolean(plan.isHot),

        priceNaira:
            Number(plan.priceNaira),

        priceKobo:
            plan.priceKobo,

        customerPriceNaira:
            Number(
                plan.customerPriceNaira
            ),

        customerPriceKobo:
            plan.customerPriceKobo,

        availability:
            plan.availability !== false,

        source:
            String(
                plan.source ||
                "vtu_data_variations"
            )
    });
}

/*
 * The purchase reference is now the idempotency key.
 *
 * The transaction ID is deterministic for the
 * authenticated user + purchase reference.
 *
 * This means:
 *
 * Same user + same reference
 *        ↓
 * Same transaction ID
 *        ↓
 * Same provider request ID
 *        ↓
 * Retry cannot create a second purchase.
 */
function createTransactionId(
    uid,
    reference
) {
    const digest =
        crypto
            .createHash("sha256")
            .update(
                `${uid}:${reference}`,
                "utf8"
            )
            .digest("hex");

    return `DATA_${digest}`;
}

function createTransactionReference(
    transactionId
) {
    const digest =
        crypto
            .createHash("sha256")
            .update(
                transactionId,
                "utf8"
            )
            .digest("hex");

    return `NDATA_${digest.slice(0, 32)}`;
}

function buildTransactionSnapshot({
    transactionId,
    uid,
    reference,
    input,
    plan,
    reservationId,
    status,
    providerResult = null
}) {
    return {
        id:
            transactionId,

        uid,

        transactionId,

        reference,

        reservationId,

        service:
            "data",

        type:
            "data",

        status,

        direction:
            "debit",

        currency:
            CURRENCY,

        network:
            plan.network,

        phoneNumber:
            input.phoneNumber,

        planId:
            plan.planId,

        variationId:
            plan.variationId,

        provider:
            plan.provider,

        providerRequestId:
            providerResult?.requestId ||
            null,

        providerReference:
            providerResult?.providerReference ||
            null,

        providerStatus:
            providerResult?.providerStatus ||
            null,

        providerCostKobo:
            Number.isSafeInteger(
                providerResult?.providerCostKobo
            )
                ? providerResult.providerCostKobo
                : null,

        providerOutcome:
            providerResult?.outcome ||
            null,

        dataPlan:
            plan.dataPlan,

        dataAmount:
            plan.dataAmount,

        dataAmountValue:
            plan.dataAmountValue,

        dataAmountUnit:
            plan.dataAmountUnit,

        validityDays:
            plan.validityDays,

        validityLabel:
            plan.validityLabel,

        category:
            plan.category,

        isHot:
            plan.isHot,

        amountKobo:
            plan.customerPriceKobo,

        amountNaira:
            plan.customerPriceNaira,

        productSnapshot: {
            planId:
                plan.planId,

            variationId:
                plan.variationId,

            provider:
                plan.provider,

            network:
                plan.network,

            dataPlan:
                plan.dataPlan,

            dataAmount:
                plan.dataAmount,

            dataAmountValue:
                plan.dataAmountValue,

            dataAmountUnit:
                plan.dataAmountUnit,

            validityDays:
                plan.validityDays,

            validityLabel:
                plan.validityLabel,

            category:
                plan.category,

            isHot:
                plan.isHot,

            customerPriceKobo:
                plan.customerPriceKobo,

            customerPriceNaira:
                plan.customerPriceNaira,

            providerPriceKobo:
                plan.priceKobo
        },

        createdAt:
            new Date(),

        updatedAt:
            new Date()
    };
}

async function saveTransaction(
    transaction
) {
    const transactionRef =
        db
            .collection(
                TRANSACTIONS_COLLECTION
            )
            .doc(transaction.id);

    await transactionRef.create(
        transaction
    );

    return transaction;
}

async function getTransaction(
    uid,
    transactionId
) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const transactionRef =
        db
            .collection(
                TRANSACTIONS_COLLECTION
            )
            .doc(
                normalizedTransactionId
            );

    const snapshot =
        await transactionRef.get();

    if (!snapshot.exists) {
        return null;
    }

    const transaction =
        snapshot.data();

    if (
        transaction.uid !==
        authenticatedUid
    ) {
        throw createServiceError(
            "Transaction not found.",
            {
                code:
                    "TRANSACTION_NOT_FOUND",
                statusCode: 404
            }
        );
    }

    return {
        id:
            snapshot.id,
        ...transaction
    };
}

function assertInputMatchesExistingTransaction(
    input,
    transaction
) {
    if (
        transaction.service !==
        "data"
    ) {
        throw createServiceError(
            "This purchase reference is already being used.",
            {
                code:
                    "REFERENCE_ALREADY_USED",
                statusCode: 409
            }
        );
    }

    if (
        transaction.network !==
        input.network
    ) {
        throw createServiceError(
            "This purchase reference is already linked to another data purchase.",
            {
                code:
                    "REFERENCE_ALREADY_USED",
                statusCode: 409
            }
        );
    }

    if (
        transaction.planId !==
        input.planId
    ) {
        throw createServiceError(
            "This purchase reference is already linked to another data plan.",
            {
                code:
                    "REFERENCE_ALREADY_USED",
                statusCode: 409
            }
        );
    }

    if (
        transaction.phoneNumber !==
        input.phoneNumber
    ) {
        throw createServiceError(
            "This purchase reference is already linked to another phone number.",
            {
                code:
                    "REFERENCE_ALREADY_USED",
                statusCode: 409
            }
        );
    }
}

function buildExistingPurchaseResponse(
    transaction
) {
    if (
        transaction.status ===
        "successful"
    ) {
        return {
            success:
                true,

            status:
                "successful",

            transactionId:
                transaction.transactionId ||
                transaction.id,

            reference:
                transaction.reference,

            plan: {
                planId:
                    transaction.planId,

                network:
                    transaction.network,

                dataPlan:
                    transaction.dataPlan,

                dataAmount:
                    transaction.dataAmount,

                validityLabel:
                    transaction.validityLabel,

                category:
                    transaction.category,

                customerPriceKobo:
                    transaction.amountKobo,

                customerPriceNaira:
                    transaction.amountNaira
            },

            message:
                "Data purchase successful."
        };
    }

    if (
        transaction.status ===
        "failed"
    ) {
        throw createServiceError(
            "Data purchase could not be completed.",
            {
                code:
                    transaction.failureCode ||
                    "DATA_PROVIDER_REJECTED",
                statusCode:
                    400
            }
        );
    }

    return {
        success:
            false,

        status:
            "pending",

        transactionId:
            transaction.transactionId ||
            transaction.id,

        reference:
            transaction.reference,

        message:
            "Your data purchase is being confirmed. Please check your transaction history shortly."
    };
}

async function claimPurchaseTransaction({
    transactionId,
    transaction
}) {
    const transactionRef =
        db
            .collection(
                TRANSACTIONS_COLLECTION
            )
            .doc(transactionId);

    try {
        await transactionRef.create(
            transaction
        );

        return {
            created:
                true,

            transaction
        };
    } catch (error) {
        /*
         * Firestore ALREADY_EXISTS means another
         * request already claimed this idempotency key.
         *
         * We intentionally do not start another
         * reservation or provider purchase.
         */
        if (
            error.code !==
            6
        ) {
            throw error;
        }

        const existingSnapshot =
            await transactionRef.get();

        if (
            !existingSnapshot.exists
        ) {
            throw createServiceError(
                "The Data purchase could not be established safely. Please try again.",
                {
                    code:
                        "DATA_IDEMPOTENCY_CONFLICT",
                    statusCode:
                        503
                }
            );
        }

        return {
            created:
                false,

            transaction: {
                id:
                    existingSnapshot.id,
                ...existingSnapshot.data()
            }
        };
    }
}

async function updateTransaction(
    transactionId,
    updates
) {
    const transactionRef =
        db
            .collection(
                TRANSACTIONS_COLLECTION
            )
            .doc(transactionId);

    await transactionRef.update({
        ...updates,

        updatedAt:
            new Date()
    });
}

function assertInputMatchesPlan(
    input,
    plan
) {
    if (
        input.network !==
        plan.network
    ) {
        throw createServiceError(
            "The selected data plan does not match the selected network.",
            {
                code:
                    "DATA_PLAN_NETWORK_MISMATCH",
                statusCode:
                    400
            }
        );
    }

    if (
        plan.provider !==
        "vtu.ng"
    ) {
        throw createServiceError(
            "The selected data provider is not supported.",
            {
                code:
                    "UNSUPPORTED_DATA_PROVIDER",
                statusCode:
                    500
            }
        );
    }

    if (
        !plan.availability
    ) {
        throw createServiceError(
            "This data plan is currently unavailable.",
            {
                code:
                    "DATA_PLAN_UNAVAILABLE",
                statusCode:
                    409
            }
        );
    }

    if (
        String(plan.planId) !==
        String(plan.variationId)
    ) {
        throw createServiceError(
            "The data plan identity is inconsistent.",
            {
                code:
                    "DATA_PLAN_IDENTITY_MISMATCH",
                statusCode:
                    500
            }
        );
    }
}

async function verifyFreshPlan(
    planId,
    expectedPlan
) {
    const currentPlan =
        await findDataPlan(
            planId,
            {
                forceRefresh:
                    true
            }
        );

    if (!currentPlan) {
        throw createServiceError(
            "This data plan is no longer available.",
            {
                code:
                    "DATA_PLAN_NOT_FOUND",
                statusCode:
                    409
            }
        );
    }

    const normalizedCurrentPlan =
        toPlainPlan(
            currentPlan
        );

    if (
        normalizedCurrentPlan.network !==
        expectedPlan.network
    ) {
        throw createServiceError(
            "The data plan network has changed. Please refresh and try again.",
            {
                code:
                    "DATA_PLAN_CHANGED",
                statusCode:
                    409
            }
        );
    }

    if (
        normalizedCurrentPlan.variationId !==
        expectedPlan.variationId
    ) {
        throw createServiceError(
            "The data plan has changed. Please refresh and try again.",
            {
                code:
                    "DATA_PLAN_CHANGED",
                statusCode:
                    409
            }
        );
    }

    if (
        normalizedCurrentPlan.customerPriceKobo !==
        expectedPlan.customerPriceKobo
    ) {
        throw createServiceError(
            "The price of this data plan has changed. Please refresh and try again.",
            {
                code:
                    "DATA_PLAN_PRICE_CHANGED",
                statusCode:
                    409
            }
        );
    }

    if (
        normalizedCurrentPlan.dataPlan !==
        expectedPlan.dataPlan
    ) {
        throw createServiceError(
            "The data plan details have changed. Please refresh and try again.",
            {
                code:
                    "DATA_PLAN_CHANGED",
                statusCode:
                    409
            }
        );
    }

    if (
        normalizedCurrentPlan.dataAmount !==
        expectedPlan.dataAmount
    ) {
        throw createServiceError(
            "The data plan details have changed. Please refresh and try again.",
            {
                code:
                    "DATA_PLAN_CHANGED",
                statusCode:
                    409
            }
        );
    }

    if (
        normalizedCurrentPlan.validityLabel !==
        expectedPlan.validityLabel
    ) {
        throw createServiceError(
            "The data plan validity has changed. Please refresh and try again.",
            {
                code:
                    "DATA_PLAN_CHANGED",
                statusCode:
                    409
            }
        );
    }

    return normalizedCurrentPlan;
}

function sanitizeProviderResult(
    providerResult
) {
    if (!providerResult) {
        return null;
    }

    return {
        outcome:
            providerResult.outcome ||
            "unknown",

        providerStatus:
            providerResult.providerStatus ||
            null,

        providerReference:
            providerResult.providerReference ||
            null,

        providerCostKobo:
            Number.isSafeInteger(
                providerResult.providerCostKobo
            )
                ? providerResult.providerCostKobo
                : null,

        providerCode:
            providerResult.providerCode ||
            null,

        requestId:
            providerResult.requestId ||
            null,

        requestedVariationId:
            providerResult.requestedVariationId ||
            null,

        returnedVariationId:
            providerResult.returnedVariationId ||
            null,

        httpStatus:
            providerResult.httpStatus ||
            null
    };
}

async function markProviderSuccess({
    uid,
    transactionId,
    reservationId,
    providerResult
}) {
    const reservation =
        await getReservation(
            reservationId
        );

    if (!reservation) {
        throw createServiceError(
            "The wallet reservation could not be found.",
            {
                code:
                    "RESERVATION_NOT_FOUND",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.uid !==
        uid
    ) {
        throw createServiceError(
            "Wallet reservation ownership mismatch.",
            {
                code:
                    "RESERVATION_OWNERSHIP_MISMATCH",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.reference !==
        transactionId
    ) {
        throw createServiceError(
            "Wallet reservation transaction mismatch.",
            {
                code:
                    "RESERVATION_TRANSACTION_MISMATCH",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.status ===
        "released"
    ) {
        throw createServiceError(
            "The wallet reservation was already released.",
            {
                code:
                    "RESERVATION_ALREADY_RELEASED",
                statusCode:
                    500
            }
        );
    }

    const committed =
        await commitReservation(
            reservationId,
            {
                uid,
                provider:
                    "vtu.ng"
            }
        );

    await updateTransaction(
        transactionId,
        {
            status:
                "successful",

            providerStatus:
                providerResult.providerStatus ||
                "completed",

            providerOutcome:
                "success",

            providerReference:
                providerResult.providerReference ||
                null,

            providerRequestId:
                providerResult.requestId ||
                null,

            providerCostKobo:
                Number.isSafeInteger(
                    providerResult.providerCostKobo
                )
                    ? providerResult.providerCostKobo
                    : null
        }
    );

    return committed;
}

async function markProviderFailure({
    uid,
    transactionId,
    reservationId,
    providerResult
}) {
    const reservation =
        await getReservation(
            reservationId
        );

    if (!reservation) {
        throw createServiceError(
            "The wallet reservation could not be found.",
            {
                code:
                    "RESERVATION_NOT_FOUND",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.uid !==
        uid
    ) {
        throw createServiceError(
            "Wallet reservation ownership mismatch.",
            {
                code:
                    "RESERVATION_OWNERSHIP_MISMATCH",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.reference !==
        transactionId
    ) {
        throw createServiceError(
            "Wallet reservation transaction mismatch.",
            {
                code:
                    "RESERVATION_TRANSACTION_MISMATCH",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.status ===
        "committed"
    ) {
        await updateTransaction(
            transactionId,
            {
                status:
                    "successful",

                providerOutcome:
                    "success",

                providerStatus:
                    providerResult.providerStatus ||
                    null,

                providerReference:
                    providerResult.providerReference ||
                    null,

                providerRequestId:
                    providerResult.requestId ||
                    null,

                providerCostKobo:
                    Number.isSafeInteger(
                        providerResult.providerCostKobo
                    )
                        ? providerResult.providerCostKobo
                        : null
            }
        );

        return reservation;
    }

    if (
        reservation.status ===
        "released"
    ) {
        await updateTransaction(
            transactionId,
            {
                status:
                    "failed",

                providerOutcome:
                    "failure",

                providerStatus:
                    providerResult.providerStatus ||
                    null,

                providerReference:
                    providerResult.providerReference ||
                    null,

                providerRequestId:
                    providerResult.requestId ||
                    null,

                providerCostKobo:
                    Number.isSafeInteger(
                        providerResult.providerCostKobo
                    )
                        ? providerResult.providerCostKobo
                        : null
            }
        );

        return reservation;
    }

    const released =
        await releaseReservation(
            reservationId,
            {
                uid
            }
        );

    await updateTransaction(
        transactionId,
        {
            status:
                "failed",

            providerOutcome:
                "failure",

            providerStatus:
                providerResult.providerStatus ||
                null,

            providerReference:
                providerResult.providerReference ||
                null,

            providerRequestId:
                providerResult.requestId ||
                null,

            providerCostKobo:
                Number.isSafeInteger(
                    providerResult.providerCostKobo
                )
                    ? providerResult.providerCostKobo
                    : null
        }
    );

    return released;
}

async function purchaseDataForCustomer({
    uid,
    network,
    phoneNumber,
    planId,
    reference
}) {
    const authenticatedUid =
        requireUid(uid);

    const purchaseReference =
        requireReference(
            reference
        );

    const input =
        validatePurchaseInput({
            network,
            phoneNumber,
            planId,
            currency:
                CURRENCY,
            reference:
                purchaseReference
        });

    const transactionId =
        createTransactionId(
            authenticatedUid,
            purchaseReference
        );

    /*
     * Step 1:
     * Resolve the customer-selected plan from
     * the authoritative server-side catalog.
     */
    const catalogPlan =
        await findDataPlan(
            input.planId
        );

    if (!catalogPlan) {
        throw createServiceError(
            "This data plan is no longer available.",
            {
                code:
                    "DATA_PLAN_NOT_FOUND",
                statusCode:
                    409
            }
        );
    }

    let plan =
        toPlainPlan(
            catalogPlan
        );

    /*
     * Step 2:
     * Verify selected network and server product.
     */
    assertInputMatchesPlan(
        input,
        plan
    );

    /*
     * Step 3:
     * Refresh provider-backed catalog before
     * establishing the purchase.
     */
    plan =
        await verifyFreshPlan(
            input.planId,
            plan
        );

    assertInputMatchesPlan(
        input,
        plan
    );

    /*
     * Step 4:
     * Establish the idempotent transaction.
     *
     * The document ID is deterministic.
     *
     * If another request already created this
     * transaction, this request MUST NOT continue
     * into reservation or provider purchase.
     */
    const initialTransaction =
        buildTransactionSnapshot({
            transactionId,
            uid:
                authenticatedUid,
            reference:
                purchaseReference,
            input,
            plan,
            reservationId:
                null,
            status:
                "pending"
        });

    const claimResult =
        await claimPurchaseTransaction({
            transactionId,
            transaction:
                initialTransaction
        });

    if (!claimResult.created) {
        const existingTransaction =
            claimResult.transaction;

        if (
            existingTransaction.uid !==
            authenticatedUid
        ) {
            throw createServiceError(
                "Unable to establish this purchase safely.",
                {
                    code:
                        "DATA_IDEMPOTENCY_CONFLICT",
                    statusCode:
                        503
                }
            );
        }

        assertInputMatchesExistingTransaction(
            input,
            existingTransaction
        );

        return buildExistingPurchaseResponse(
            existingTransaction
        );
    }

    let reservation;

    try {
        /*
         * Step 5:
         * Reserve exactly the server-authoritative
         * customer price.
         */
        reservation =
            await reserveFunds({
                uid:
                    authenticatedUid,

                amountKobo:
                    plan.customerPriceKobo,

                currency:
                    CURRENCY,

                service:
                    "data",

                reference:
                    transactionId
            });

        if (
            !reservation ||
            !reservation.id
        ) {
            throw createServiceError(
                "The wallet reservation could not be created.",
                {
                    code:
                        "RESERVATION_FAILED",
                    statusCode:
                        500
                }
            );
        }

        await updateTransaction(
            transactionId,
            {
                reservationId:
                    reservation.id,

                reservationStatus:
                    reservation.status,

                reservedAmountKobo:
                    plan.customerPriceKobo
            }
        );
    } catch (error) {
        await updateTransaction(
            transactionId,
            {
                status:
                    "failed",

                failureCode:
                    error.code ||
                    "RESERVATION_FAILED"
            }
        ).catch(() => {});

        throw error;
    }

    /*
     * Step 6:
     * Call VTU using ONLY the server-selected
     * variation and network.
     */
    let providerResult;

    try {
        providerResult =
            await purchaseData({
                transactionId,
                network:
                    plan.network,
                phoneNumber:
                    input.phoneNumber,
                variationId:
                    plan.variationId
            });
    } catch (error) {
        const providerError =
            error instanceof
            VtuProviderError
                ? error
                : null;

        /*
         * Unknown provider outcomes remain reserved.
         */
        if (
            providerError &&
            (
                providerError.kind ===
                    "timeout" ||
                providerError.kind ===
                    "network" ||
                providerError.kind ===
                    "unknown"
            )
        ) {
            await updateTransaction(
                transactionId,
                {
                    status:
                        "pending",

                    providerOutcome:
                        "unknown",

                    providerStatus:
                        providerError.providerStatus ||
                        null,

                    providerCode:
                        providerError.providerCode ||
                        null,

                    providerRequestId:
                        createSafeProviderRequestId(
                            transactionId
                        ),

                    reconciliationRequired:
                        true,

                    retryAfterSeconds:
                        UNKNOWN_RETRY_AFTER_SECONDS
                }
            );

            return {
                success:
                    false,

                status:
                    "pending",

                transactionId,

                reference:
                    purchaseReference,

                message:
                    "Your data purchase is being confirmed. Please check your transaction history shortly."
            };
        }

        /*
         * Definite provider rejection/failure can
         * safely release the reservation.
         */
        try {
            const failedResult = {
                outcome:
                    "failure",

                providerStatus:
                    providerError?.providerStatus ||
                    null,

                providerReference:
                    providerError?.providerReference ||
                    null,

                providerCostKobo:
                    null,

                providerCode:
                    providerError?.providerCode ||
                    null,

                requestId:
                    createSafeProviderRequestId(
                        transactionId
                    ),

                requestedVariationId:
                    plan.variationId,

                returnedVariationId:
                    null
            };

            await markProviderFailure({
                uid:
                    authenticatedUid,

                transactionId,

                reservationId:
                    reservation.id,

                providerResult:
                    failedResult
            });
        } catch (releaseError) {
            await updateTransaction(
                transactionId,
                {
                    status:
                        "pending",

                    providerOutcome:
                        "failure",

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        releaseError.message
                }
            ).catch(() => {});

            throw createServiceError(
                "The data purchase requires reconciliation.",
                {
                    code:
                        "DATA_RECONCILIATION_REQUIRED",

                    statusCode:
                        503,

                    cause:
                        releaseError
                }
            );
        }

        throw createServiceError(
            "Data purchase could not be completed.",
            {
                code:
                    "DATA_PROVIDER_REJECTED",

                statusCode:
                    400
            }
        );
    }

    const safeProviderResult =
        sanitizeProviderResult(
            providerResult
        );

    /*
     * Step 7:
     * Reject a provider response that identifies
     * a different variation.
     */
    if (
        providerResult.returnedVariationId &&
        providerResult.returnedVariationId !==
            plan.variationId
    ) {
        await updateTransaction(
            transactionId,
            {
                status:
                    "pending",

                providerOutcome:
                    "unknown",

                providerStatus:
                    providerResult.providerStatus ||
                    null,

                providerReference:
                    providerResult.providerReference ||
                    null,

                providerRequestId:
                    providerResult.requestId ||
                    null,

                providerCostKobo:
                    Number.isSafeInteger(
                        providerResult.providerCostKobo
                    )
                        ? providerResult.providerCostKobo
                        : null,

                reconciliationRequired:
                    true,

                productMismatch:
                    true
            }
        );

        return {
            success:
                false,

            status:
                "pending",

            transactionId,

            reference:
                purchaseReference,

            message:
                "Your data purchase is being confirmed. Please check your transaction history shortly."
        };
    }

    /*
     * Step 8:
     * Confirmed provider success = commit wallet.
     */
    if (
        providerResult.outcome ===
        "success"
    ) {
        try {
            await updateTransaction(
                transactionId,
                {
                    providerStatus:
                        providerResult.providerStatus ||
                        null,

                    providerOutcome:
                        "success",

                    providerReference:
                        providerResult.providerReference ||
                        null,

                    providerRequestId:
                        providerResult.requestId ||
                        null,

                    providerCostKobo:
                        Number.isSafeInteger(
                            providerResult.providerCostKobo
                        )
                            ? providerResult.providerCostKobo
                            : null
                }
            );

            await markProviderSuccess({
                uid:
                    authenticatedUid,

                transactionId,

                reservationId:
                    reservation.id,

                providerResult:
                    safeProviderResult
            });

            return {
                success:
                    true,

                status:
                    "successful",

                transactionId,

                reference:
                    purchaseReference,

                plan: {
                    planId:
                        plan.planId,

                    network:
                        plan.network,

                    dataPlan:
                        plan.dataPlan,

                    dataAmount:
                        plan.dataAmount,

                    validityLabel:
                        plan.validityLabel,

                    category:
                        plan.category,

                    customerPriceKobo:
                        plan.customerPriceKobo,

                    customerPriceNaira:
                        plan.customerPriceNaira
                },

                message:
                    "Data purchase successful."
            };
        } catch (commitError) {
            /*
             * Provider success is known.
             *
             * Never release the reservation here.
             */
            await updateTransaction(
                transactionId,
                {
                    status:
                        "pending",

                    providerOutcome:
                        "success",

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        commitError.message
                }
            ).catch(() => {});

            throw createServiceError(
                "Your data purchase was received and is being finalized.",
                {
                    code:
                        "DATA_COMMIT_RECONCILIATION_REQUIRED",

                    statusCode:
                        503,

                    cause:
                        commitError
                }
            );
        }
    }

    /*
     * Step 9:
     * Explicit provider failure = release.
     */
    if (
        providerResult.outcome ===
        "failure"
    ) {
        try {
            await markProviderFailure({
                uid:
                    authenticatedUid,

                transactionId,

                reservationId:
                    reservation.id,

                providerResult:
                    safeProviderResult
            });
        } catch (releaseError) {
            await updateTransaction(
                transactionId,
                {
                    status:
                        "pending",

                    providerOutcome:
                        "failure",

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        releaseError.message
                }
            ).catch(() => {});

            throw createServiceError(
                "The data purchase requires reconciliation.",
                {
                    code:
                        "DATA_RECONCILIATION_REQUIRED",

                    statusCode:
                        503,

                    cause:
                        releaseError
                }
            );
        }

        throw createServiceError(
            "Data purchase could not be completed.",
            {
                code:
                    "DATA_PROVIDER_REJECTED",

                statusCode:
                    400
            }
        );
    }

    /*
     * Step 10:
     * Anything else remains uncertain.
     */
    await updateTransaction(
        transactionId,
        {
            status:
                "pending",

            providerOutcome:
                "unknown",

            providerStatus:
                providerResult.providerStatus ||
                null,

            providerReference:
                providerResult.providerReference ||
                null,

            providerRequestId:
                providerResult.requestId ||
                null,

            providerCostKobo:
                Number.isSafeInteger(
                    providerResult.providerCostKobo
                )
                    ? providerResult.providerCostKobo
                    : null,

            reconciliationRequired:
                true,

            retryAfterSeconds:
                UNKNOWN_RETRY_AFTER_SECONDS
        }
    );

    return {
        success:
            false,

        status:
            "pending",

        transactionId,

        reference:
            purchaseReference,

        message:
            "Your data purchase is being confirmed. Please check your transaction history shortly."
    };
}

function createSafeProviderRequestId(
    transactionId
) {
    const digest =
        crypto
            .createHash("sha256")
            .update(
                transactionId,
                "utf8"
            )
            .digest("hex");

    return `ND${digest.slice(0, 46)}`;
}

async function reconcileDataTransaction({
    uid,
    transactionId
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedTransactionId =
        requireTransactionId(
            transactionId
        );

    const transaction =
        await getTransaction(
            authenticatedUid,
            normalizedTransactionId
        );

    if (!transaction) {
        throw createServiceError(
            "Transaction not found.",
            {
                code:
                    "TRANSACTION_NOT_FOUND",
                statusCode:
                    404
            }
        );
    }

    if (
        transaction.service !==
        "data"
    ) {
        throw createServiceError(
            "This is not a Data transaction.",
            {
                code:
                    "INVALID_DATA_TRANSACTION",
                statusCode:
                    400
            }
        );
    }

    if (
        transaction.status ===
        "successful"
    ) {
        return {
            success:
                true,

            status:
                "successful",

            transactionId:
                normalizedTransactionId
        };
    }

    const reservationId =
        transaction.reservationId;

    if (
        typeof reservationId !==
        "string" ||
        !reservationId.trim()
    ) {
        throw createServiceError(
            "Data transaction has no wallet reservation.",
            {
                code:
                    "DATA_RESERVATION_MISSING",
                statusCode:
                    500
            }
        );
    }

    const reservation =
        await getReservation(
            reservationId
        );

    if (!reservation) {
        throw createServiceError(
            "Data transaction reservation could not be found.",
            {
                code:
                    "DATA_RESERVATION_NOT_FOUND",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.uid !==
            authenticatedUid ||
        reservation.reference !==
            normalizedTransactionId ||
        reservation.service !==
            "data"
    ) {
        throw createServiceError(
            "Data transaction reservation does not match.",
            {
                code:
                    "DATA_RESERVATION_MISMATCH",
                statusCode:
                    500
            }
        );
    }

    if (
        reservation.status ===
        "committed"
    ) {
        await updateTransaction(
            normalizedTransactionId,
            {
                status:
                    "successful",

                providerOutcome:
                    "success",

                reconciliationRequired:
                    false
            }
        );

        return {
            success:
                true,

            status:
                "successful",

            transactionId:
                normalizedTransactionId
        };
    }

    if (
        reservation.status ===
        "released"
    ) {
        await updateTransaction(
            normalizedTransactionId,
            {
                status:
                    "failed",

                providerOutcome:
                    "failure",

                reconciliationRequired:
                    false
            }
        );

        return {
            success:
                false,

            status:
                "failed",

            transactionId:
                normalizedTransactionId
        };
    }

    let providerResult;

    try {
        providerResult =
            await requeryData({
                transactionId:
                    normalizedTransactionId
            });
    } catch (error) {
        await updateTransaction(
            normalizedTransactionId,
            {
                status:
                    "pending",

                providerOutcome:
                    "unknown",

                reconciliationRequired:
                    true,

                reconciliationError:
                    error.message
            }
        ).catch(() => {});

        return {
            success:
                false,

            status:
                "pending",

            transactionId:
                normalizedTransactionId
        };
    }

    const safeProviderResult =
        sanitizeProviderResult(
            providerResult
        );

    /*
     * A requery response must still identify the
     * exact variation requested by NovaPay.
     */
    if (
        providerResult.returnedVariationId &&
        providerResult.returnedVariationId !==
            transaction.variationId
    ) {
        await updateTransaction(
            normalizedTransactionId,
            {
                status:
                    "pending",

                providerOutcome:
                    "unknown",

                providerStatus:
                    providerResult.providerStatus ||
                    null,

                providerReference:
                    providerResult.providerReference ||
                    null,

                providerRequestId:
                    providerResult.requestId ||
                    null,

                providerCostKobo:
                    Number.isSafeInteger(
                        providerResult.providerCostKobo
                    )
                        ? providerResult.providerCostKobo
                        : null,

                reconciliationRequired:
                    true,

                productMismatch:
                    true
            }
        );

        return {
            success:
                false,

            status:
                "pending",

            transactionId:
                normalizedTransactionId
        };
    }

    if (
        providerResult.outcome ===
        "success"
    ) {
        try {
            await markProviderSuccess({
                uid:
                    authenticatedUid,

                transactionId:
                    normalizedTransactionId,

                reservationId,

                providerResult:
                    safeProviderResult
            });

            return {
                success:
                    true,

                status:
                    "successful",

                transactionId:
                    normalizedTransactionId
            };
        } catch (error) {
            await updateTransaction(
                normalizedTransactionId,
                {
                    status:
                        "pending",

                    providerOutcome:
                        "success",

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        error.message
                }
            ).catch(() => {});

            return {
                success:
                    false,

                status:
                    "pending",

                transactionId:
                    normalizedTransactionId
            };
        }
    }

    if (
        providerResult.outcome ===
        "failure"
    ) {
        try {
            await markProviderFailure({
                uid:
                    authenticatedUid,

                transactionId:
                    normalizedTransactionId,

                reservationId,

                providerResult:
                    safeProviderResult
            });

            return {
                success:
                    false,

                status:
                    "failed",

                transactionId:
                    normalizedTransactionId
            };
        } catch (error) {
            await updateTransaction(
                normalizedTransactionId,
                {
                    status:
                        "pending",

                    providerOutcome:
                        "failure",

                    reconciliationRequired:
                        true,

                    reconciliationError:
                        error.message
                }
            ).catch(() => {});

            return {
                success:
                    false,

                status:
                    "pending",

                transactionId:
                    normalizedTransactionId
            };
        }
    }

    await updateTransaction(
        normalizedTransactionId,
        {
            status:
                "pending",

            providerOutcome:
                "unknown",

            providerStatus:
                providerResult.providerStatus ||
                null,

            providerReference:
                providerResult.providerReference ||
                null,

            providerRequestId:
                providerResult.requestId ||
                null,

            providerCostKobo:
                Number.isSafeInteger(
                    providerResult.providerCostKobo
                )
                    ? providerResult.providerCostKobo
                    : null,

            reconciliationRequired:
                true
        }
    );

    return {
        success:
            false,

        status:
            "pending",

        transactionId:
            normalizedTransactionId
    };
}

async function getDataPlans({
    forceRefresh = false
} = {}) {
    return getDataCatalog({
        forceRefresh
    });
}

module.exports = {
    purchaseDataForCustomer,
    reconcileDataTransaction,
    getTransaction,
    getDataPlans
};