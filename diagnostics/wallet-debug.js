"use strict";

const { db } = require("../firebase-admin");

const WALLETS_COLLECTION = "wallets";
const RESERVATIONS_COLLECTION = "walletReservations";
const AIRTIME_TRANSACTIONS_COLLECTION = "airtimeTransactions";
const DATA_TRANSACTIONS_COLLECTION = "dataTransactions";

const MAX_RESULTS = 100;

function safeInteger(value, fallback = 0) {
    const number = Number(value);

    return Number.isSafeInteger(number)
        ? number
        : fallback;
}

function toNaira(kobo) {
    return Number((kobo / 100).toFixed(2));
}

function serializeTimestamp(value) {
    if (!value) {
        return null;
    }

    if (typeof value.toDate === "function") {
        return value.toDate().toISOString();
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    return String(value);
}

function serializeDocument(snapshot) {
    if (!snapshot.exists) {
        return null;
    }

    const data = snapshot.data() || {};

    return {
        id: snapshot.id,
        ...data,
        createdAt: serializeTimestamp(data.createdAt),
        updatedAt: serializeTimestamp(data.updatedAt),
        completedAt: serializeTimestamp(data.completedAt),
        failedAt: serializeTimestamp(data.failedAt),
        releasedAt: serializeTimestamp(data.releasedAt),
        committedAt: serializeTimestamp(data.committedAt)
    };
}

function summarizeReservation(data) {
    const amountKobo = safeInteger(
        data.amountKobo
    );

    return {
        id: data.id || null,
        uid: data.uid || null,
        service: data.service || null,
        reference: data.reference || null,
        amountKobo,
        amountNaira: toNaira(amountKobo),
        status: data.status || null,
        currency: data.currency || null,
        transactionId: data.transactionId || null,
        createdAt: serializeTimestamp(data.createdAt),
        updatedAt: serializeTimestamp(data.updatedAt),
        committedAt: serializeTimestamp(data.committedAt),
        releasedAt: serializeTimestamp(data.releasedAt)
    };
}

function summarizeTransaction(data) {
    const amountKobo = safeInteger(
        data.amountKobo
    );

    const providerCostKobo =
        data.providerCostKobo === null ||
        data.providerCostKobo === undefined
            ? null
            : safeInteger(
                data.providerCostKobo,
                null
            );

    const gainKobo =
        data.gainKobo === null ||
        data.gainKobo === undefined
            ? null
            : safeInteger(
                data.gainKobo,
                null
            );

    return {
        id: data.id || null,
        uid: data.uid || null,
        type: data.type || null,
        service: data.service || null,
        network: data.network || null,
        phoneNumber: data.phoneNumber || null,
        planId: data.planId || null,
        variationId: data.variationId || null,
        reference: data.reference || null,
        clientReference: data.clientReference || null,
        reservationId: data.reservationId || null,
        amountKobo,
        amountNaira: toNaira(amountKobo),
        status: data.status || null,
        direction: data.direction || null,
        currency: data.currency || null,
        provider: data.provider || null,
        providerStatus: data.providerStatus || null,
        providerReference: data.providerReference || null,
        providerRequestId: data.providerRequestId || null,
        providerCostKobo,
        providerCostNaira:
            providerCostKobo === null
                ? null
                : toNaira(providerCostKobo),
        gainKobo,
        gainNaira:
            gainKobo === null
                ? null
                : toNaira(gainKobo),
        reconciliationRequired:
            data.reconciliationRequired === true,
        createdAt: serializeTimestamp(data.createdAt),
        updatedAt: serializeTimestamp(data.updatedAt),
        completedAt: serializeTimestamp(data.completedAt),
        failedAt: serializeTimestamp(data.failedAt)
    };
}

async function readCollection(
    collectionRef,
    uid
) {
    const snapshot =
        await collectionRef
            .where("uid", "==", uid)
            .limit(MAX_RESULTS)
            .get();

    return snapshot.docs.map(
        (doc) => doc.data()
    );
}

function sortNewestFirst(items) {
    return items.slice().sort(
        (a, b) => {
            const aTime =
                a.createdAt &&
                typeof a.createdAt.toMillis === "function"
                    ? a.createdAt.toMillis()
                    : 0;

            const bTime =
                b.createdAt &&
                typeof b.createdAt.toMillis === "function"
                    ? b.createdAt.toMillis()
                    : 0;

            return bTime - aTime;
        }
    );
}

async function diagnoseWallet(uid) {
    if (!uid || typeof uid !== "string") {
        const error = new Error(
            "Authenticated user ID is required."
        );

        error.statusCode = 401;

        throw error;
    }

    const walletRef =
        db
            .collection(WALLETS_COLLECTION)
            .doc(uid);

    const walletSnapshot =
        await walletRef.get();

    const walletData =
        walletSnapshot.exists
            ? walletSnapshot.data() || {}
            : null;

    const balanceKobo =
        walletData
            ? safeInteger(
                walletData.balanceKobo
            )
            : 0;

    const reservedKobo =
        walletData
            ? safeInteger(
                walletData.reservedKobo
            )
            : 0;

    const calculatedAvailableKobo =
        balanceKobo -
        reservedKobo;

    const storedAvailableKobo =
        walletData &&
        walletData.availableKobo !== undefined
            ? safeInteger(
                walletData.availableKobo
            )
            : null;

    const reservationsRaw =
        await readCollection(
            db.collection(
                RESERVATIONS_COLLECTION
            ),
            uid
        );

    const reservations =
        reservationsRaw.map(
            summarizeReservation
        );

    const airtimeRaw =
        await readCollection(
            db.collection(
                AIRTIME_TRANSACTIONS_COLLECTION
            ),
            uid
        );

    const airtimeTransactions =
        sortNewestFirst(
            airtimeRaw
        ).map(
            summarizeTransaction
        );

    const dataRaw =
        await readCollection(
            db.collection(
                DATA_TRANSACTIONS_COLLECTION
            ),
            uid
        );

    const dataTransactions =
        sortNewestFirst(
            dataRaw
        ).map(
            summarizeTransaction
        );

    const pendingReservations =
        reservations.filter(
            (item) =>
                item.status === "pending"
        );

    const committedReservations =
        reservations.filter(
            (item) =>
                item.status === "committed"
        );

    const releasedReservations =
        reservations.filter(
            (item) =>
                item.status === "released"
        );

    const pendingReservationTotalKobo =
        pendingReservations.reduce(
            (
                total,
                reservation
            ) =>
                total +
                reservation.amountKobo,
            0
        );

    const committedReservationTotalKobo =
        committedReservations.reduce(
            (
                total,
                reservation
            ) =>
                total +
                reservation.amountKobo,
            0
        );

    const releasedReservationTotalKobo =
        releasedReservations.reduce(
            (
                total,
                reservation
            ) =>
                total +
                reservation.amountKobo,
            0
        );

    const reservationById =
        new Map(
            reservations.map(
                (reservation) => [
                    reservation.id,
                    reservation
                ]
            )
        );

    const problems = [];

    if (!walletSnapshot.exists) {
        problems.push({
            code: "WALLET_NOT_FOUND",
            severity: "critical",
            message:
                "The wallet document does not exist."
        });
    }

    if (balanceKobo < 0) {
        problems.push({
            code: "NEGATIVE_BALANCE",
            severity: "critical",
            message:
                "Wallet balance is negative."
        });
    }

    if (reservedKobo < 0) {
        problems.push({
            code: "NEGATIVE_RESERVED",
            severity: "critical",
            message:
                "Wallet reserved amount is negative."
        });
    }

    if (reservedKobo > balanceKobo) {
        problems.push({
            code: "RESERVED_EXCEEDS_BALANCE",
            severity: "critical",
            message:
                "Reserved funds exceed wallet balance."
        });
    }

    if (
        storedAvailableKobo !== null &&
        storedAvailableKobo !==
            calculatedAvailableKobo
    ) {
        problems.push({
            code: "AVAILABLE_BALANCE_MISMATCH",
            severity: "critical",
            message:
                "Stored availableKobo does not match balanceKobo - reservedKobo.",
            details: {
                storedAvailableKobo,
                calculatedAvailableKobo
            }
        });
    }

    if (
        pendingReservationTotalKobo !==
        reservedKobo
    ) {
        problems.push({
            code:
                "PENDING_RESERVATIONS_MISMATCH",
            severity: "critical",
            message:
                "Wallet reservedKobo does not equal the total of pending reservations.",
            details: {
                walletReservedKobo:
                    reservedKobo,
                pendingReservationTotalKobo
            }
        });
    }

    for (
        const reservation
        of pendingReservations
    ) {
        const matchingAirtime =
            airtimeTransactions.find(
                (transaction) =>
                    transaction.reservationId ===
                    reservation.id
            );

        const matchingData =
            dataTransactions.find(
                (transaction) =>
                    transaction.reservationId ===
                    reservation.id
            );

        if (
            !matchingAirtime &&
            !matchingData
        ) {
            problems.push({
                code:
                    "ORPHAN_PENDING_RESERVATION",
                severity: "critical",
                message:
                    "A pending reservation has no matching Airtime or Data transaction.",
                reservation
            });
        }
    }

    for (
        const transaction
        of [
            ...airtimeTransactions,
            ...dataTransactions
        ]
    ) {
        if (
            !transaction.reservationId
        ) {
            if (
                transaction.status ===
                    "successful" ||
                transaction.status ===
                    "pending" ||
                transaction.status ===
                    "unknown"
            ) {
                problems.push({
                    code:
                        "TRANSACTION_MISSING_RESERVATION",
                    severity: "high",
                    message:
                        "A financial transaction has no reservation ID.",
                    transaction
                });
            }

            continue;
        }

        const reservation =
            reservationById.get(
                transaction.reservationId
            );

        if (!reservation) {
            problems.push({
                code:
                    "TRANSACTION_RESERVATION_NOT_FOUND",
                severity: "critical",
                message:
                    "Transaction references a reservation that does not exist.",
                transaction
            });

            continue;
        }

        if (
            transaction.status ===
                "successful" &&
            reservation.status !==
                "committed"
        ) {
            problems.push({
                code:
                    "SUCCESSFUL_TRANSACTION_RESERVATION_MISMATCH",
                severity: "critical",
                message:
                    "Successful transaction does not have a committed reservation.",
                transaction,
                reservation
            });
        }

        if (
            (
                transaction.status ===
                    "failed"
            ) &&
            reservation.status ===
                "pending"
        ) {
            problems.push({
                code:
                    "FAILED_TRANSACTION_STILL_RESERVED",
                severity: "critical",
                message:
                    "Failed transaction still has a pending reservation.",
                transaction,
                reservation
            });
        }

        if (
            (
                transaction.status ===
                    "successful"
            ) &&
            reservation.status ===
                "released"
        ) {
            problems.push({
                code:
                    "SUCCESSFUL_TRANSACTION_RELEASED_RESERVATION",
                severity: "critical",
                message:
                    "Successful transaction has a released reservation.",
                transaction,
                reservation
            });
        }
    }

    const pendingAirtime =
        airtimeTransactions.filter(
            (transaction) =>
                transaction.status ===
                    "pending" ||
                transaction.status ===
                    "unknown"
        );

    const pendingData =
        dataTransactions.filter(
            (transaction) =>
                transaction.status ===
                    "pending" ||
                transaction.status ===
                    "unknown"
        );

    if (
        pendingData.length > 0
    ) {
        problems.push({
            code:
                "DATA_TRANSACTIONS_PENDING",
            severity: "warning",
            message:
                "Data has pending/unknown transactions that may be holding reservations.",
            count:
                pendingData.length,
            transactions:
                pendingData
        });
    }

    if (
        pendingAirtime.length > 0
    ) {
        problems.push({
            code:
                "AIRTIME_TRANSACTIONS_PENDING",
            severity: "warning",
            message:
                "Airtime has pending/unknown transactions that may be holding reservations.",
            count:
                pendingAirtime.length,
            transactions:
                pendingAirtime
        });
    }

    const summary = {
        balanceKobo,
        balanceNaira:
            toNaira(balanceKobo),

        reservedKobo,
        reservedNaira:
            toNaira(reservedKobo),

        calculatedAvailableKobo,
        calculatedAvailableNaira:
            toNaira(
                calculatedAvailableKobo
            ),

        storedAvailableKobo,
        storedAvailableNaira:
            storedAvailableKobo === null
                ? null
                : toNaira(
                    storedAvailableKobo
                ),

        pendingReservationTotalKobo,
        pendingReservationTotalNaira:
            toNaira(
                pendingReservationTotalKobo
            ),

        committedReservationTotalKobo,
        committedReservationTotalNaira:
            toNaira(
                committedReservationTotalKobo
            ),

        releasedReservationTotalKobo,
        releasedReservationTotalNaira:
            toNaira(
                releasedReservationTotalKobo
            )
    };

    return {
        success: true,

        diagnostic: {
            generatedAt:
                new Date().toISOString(),

            uid,

            walletExists:
                walletSnapshot.exists
        },

        summary,

        reservations,

        airtimeTransactions,

        dataTransactions,

        consistency: {
            healthy:
                problems.length === 0,

            problemCount:
                problems.length,

            problems
        }
    };
}

function getUidFromRequest(req) {
    return (
        req?.user?.uid ||
        req?.auth?.uid ||
        req?.firebaseUser?.uid ||
        req?.user?.localId ||
        null
    );
}

function createDiagnosticRouter(
    authenticationMiddleware
) {
    const express =
        require("express");

    const router =
        express.Router();

    router.get(
        "/wallet",
        authenticationMiddleware,
        async (req, res) => {
            try {
                const uid =
                    getUidFromRequest(req);

                if (!uid) {
                    return res
                        .status(401)
                        .json({
                            success: false,
                            error:
                                "Authentication required."
                        });
                }

                const result =
                    await diagnoseWallet(
                        uid
                    );

                return res.json(
                    result
                );
            } catch (error) {
                console.error(
                    "[DIAGNOSTIC] Wallet diagnostic failed:",
                    error
                );

                return res
                    .status(
                        Number.isInteger(
                            error?.statusCode
                        )
                            ? error.statusCode
                            : 500
                    )
                    .json({
                        success: false,
                        error:
                            "Wallet diagnostic failed.",
                        code:
                            error?.code ||
                            "DIAGNOSTIC_ERROR"
                    });
            }
        }
    );

    return router;
}

module.exports = {
    diagnoseWallet,
    createDiagnosticRouter
};