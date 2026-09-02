"use strict";

const crypto = require("crypto");
const { db } = require("../firebase-admin");

const WALLETS_COLLECTION = "wallets";
const RESERVATIONS_COLLECTION = "walletReservations";
const CURRENCY = "NGN";

const STATUS_PENDING = "pending";
const STATUS_COMMITTED = "committed";
const STATUS_RELEASED = "released";

const MAX_RESERVATION_KOBO = Number(
    process.env.MAX_WALLET_RESERVATION_KOBO ||
        5_000_000
);

function createError(
    message,
    code = "RESERVATION_ERROR"
) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requireUid(uid) {
    const normalizedUid =
        String(uid ?? "").trim();

    if (!normalizedUid) {
        throw createError(
            "Authenticated user is required.",
            "AUTH_REQUIRED"
        );
    }

    if (normalizedUid.length > 200) {
        throw createError(
            "Invalid authenticated user.",
            "INVALID_UID"
        );
    }

    return normalizedUid;
}

function requireReference(reference) {
    const normalizedReference =
        String(reference ?? "").trim();

    if (!normalizedReference) {
        throw createError(
            "Reservation reference is required.",
            "INVALID_REFERENCE"
        );
    }

    if (normalizedReference.length > 150) {
        throw createError(
            "Reservation reference is too long.",
            "INVALID_REFERENCE"
        );
    }

    return normalizedReference;
}

function validateAmountKobo(amountKobo) {
    if (
        !Number.isSafeInteger(amountKobo) ||
        amountKobo <= 0
    ) {
        throw createError(
            "Reservation amount must be a positive integer in kobo.",
            "INVALID_AMOUNT"
        );
    }

    if (
        Number.isSafeInteger(MAX_RESERVATION_KOBO) &&
        MAX_RESERVATION_KOBO > 0 &&
        amountKobo > MAX_RESERVATION_KOBO
    ) {
        throw createError(
            "Reservation amount exceeds the allowed limit.",
            "AMOUNT_LIMIT_EXCEEDED"
        );
    }

    return amountKobo;
}

function normalizeCurrency(currency) {
    const normalized =
        String(currency ?? CURRENCY)
            .trim()
            .toUpperCase();

    if (normalized !== CURRENCY) {
        throw createError(
            "Unsupported wallet currency.",
            "INVALID_CURRENCY"
        );
    }

    return normalized;
}

function normalizeService(service) {
    const normalized =
        String(service ?? "")
            .trim()
            .toLowerCase();

    if (!normalized) {
        throw createError(
            "Reservation service is required.",
            "INVALID_SERVICE"
        );
    }

    if (normalized.length > 50) {
        throw createError(
            "Reservation service is too long.",
            "INVALID_SERVICE"
        );
    }

    return normalized;
}

function requireReservationId(reservationId) {
    const normalized =
        String(reservationId ?? "").trim();

    if (!normalized) {
        throw createError(
            "Reservation ID is required.",
            "INVALID_RESERVATION_ID"
        );
    }

    if (normalized.length > 200) {
        throw createError(
            "Invalid reservation ID.",
            "INVALID_RESERVATION_ID"
        );
    }

    return normalized;
}

/*
 * New reservations use a deterministic ID derived from:
 *
 *     authenticated UID + reservation reference
 *
 * This is the important concurrency protection.
 *
 * Two simultaneous requests using the same UID and reference
 * therefore target the exact same Firestore reservation document.
 *
 * Existing random reservation IDs remain valid because getReservation(),
 * commitReservation(), and releaseReservation() still accept arbitrary
 * existing reservation IDs.
 */
function createReservationId(
    uid,
    reference
) {
    const normalizedUid =
        requireUid(uid);

    const normalizedReference =
        requireReference(reference);

    const digest =
        crypto
            .createHash("sha256")
            .update(
                `${normalizedUid}:${normalizedReference}`,
                "utf8"
            )
            .digest("hex");

    return `NPRES_${digest}`;
}

function createAuditId() {
    return (
        "NPAUD_" +
        Date.now().toString(36) +
        "_" +
        crypto.randomBytes(8).toString("hex")
    );
}

function getWalletRef(uid) {
    return db
        .collection(WALLETS_COLLECTION)
        .doc(requireUid(uid));
}

function getReservationRef(
    reservationId
) {
    return db
        .collection(RESERVATIONS_COLLECTION)
        .doc(
            requireReservationId(
                reservationId
            )
        );
}

function readIntegerField(
    value,
    fieldName
) {
    if (!Number.isSafeInteger(value)) {
        throw createError(
            `Wallet field ${fieldName} is invalid.`,
            "INVALID_WALLET_STATE"
        );
    }

    return value;
}

function readWalletState(
    walletData
) {
    if (
        !walletData ||
        typeof walletData !== "object"
    ) {
        throw createError(
            "Wallet was not found.",
            "WALLET_NOT_FOUND"
        );
    }

    const balanceKobo =
        readIntegerField(
            walletData.balanceKobo,
            "balanceKobo"
        );

    const reservedKobo =
        readIntegerField(
            walletData.reservedKobo ?? 0,
            "reservedKobo"
        );

    if (balanceKobo < 0) {
        throw createError(
            "Wallet balance cannot be negative.",
            "INVALID_WALLET_STATE"
        );
    }

    if (reservedKobo < 0) {
        throw createError(
            "Wallet reserved amount cannot be negative.",
            "INVALID_WALLET_STATE"
        );
    }

    if (reservedKobo > balanceKobo) {
        throw createError(
            "Wallet reserved amount exceeds balance.",
            "INVALID_WALLET_STATE"
        );
    }

    return {
        balanceKobo,
        reservedKobo,
        availableKobo:
            balanceKobo - reservedKobo
    };
}

async function findReservationByReference(
    uid,
    reference
) {
    const normalizedUid =
        requireUid(uid);

    const normalizedReference =
        requireReference(reference);

    const snapshot =
        await db
            .collection(
                RESERVATIONS_COLLECTION
            )
            .where(
                "uid",
                "==",
                normalizedUid
            )
            .where(
                "reference",
                "==",
                normalizedReference
            )
            .limit(2)
            .get();

    if (snapshot.empty) {
        return null;
    }

    if (snapshot.size > 1) {
        throw createError(
            "Multiple reservations exist for the same reference.",
            "DUPLICATE_RESERVATION_REFERENCE"
        );
    }

    const document =
        snapshot.docs[0];

    return {
        id: document.id,
        ...document.data()
    };
}

function buildReservationData({
    reservationId,
    uid,
    reference,
    amountKobo,
    currency,
    service,
    wallet,
    metadata,
    now
}) {
    return {
        id: reservationId,
        uid,
        reference,
        amountKobo,
        currency,
        service,
        status: STATUS_PENDING,

        balanceBeforeKobo:
            wallet.balanceKobo,

        balanceAfterKobo:
            wallet.balanceKobo,

        reservedBeforeKobo:
            wallet.reservedKobo,

        reservedAfterKobo:
            wallet.reservedKobo +
            amountKobo,

        availableBeforeKobo:
            wallet.availableKobo,

        availableAfterKobo:
            wallet.availableKobo -
            amountKobo,

        metadata:
            metadata &&
            typeof metadata === "object"
                ? metadata
                : null,

        createdAt: now,
        updatedAt: now,

        committedAt: null,
        releasedAt: null,

        releaseReason: null,
        provider: null
    };
}

async function reserveFunds({
    uid,
    reference,
    amountKobo,
    currency = CURRENCY,
    service,
    metadata = null
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedReference =
        requireReference(reference);

    const amount =
        validateAmountKobo(
            amountKobo
        );

    const normalizedCurrency =
        normalizeCurrency(currency);

    const normalizedService =
        normalizeService(service);

    /*
     * Backward-compatible lookup.
     *
     * This allows older random-ID reservations to
     * remain idempotent.
     */
    const existing =
        await findReservationByReference(
            authenticatedUid,
            normalizedReference
        );

    if (existing) {
        if (
            existing.uid !==
            authenticatedUid
        ) {
            throw createError(
                "Reservation ownership mismatch.",
                "RESERVATION_OWNERSHIP_ERROR"
            );
        }

        if (
            existing.amountKobo !==
            amount
        ) {
            throw createError(
                "Reservation amount does not match the existing reservation.",
                "RESERVATION_CONFLICT"
            );
        }

        if (
            String(
                existing.currency ||
                    ""
            ).toUpperCase() !==
            normalizedCurrency
        ) {
            throw createError(
                "Reservation currency does not match the existing reservation.",
                "RESERVATION_CONFLICT"
            );
        }

        if (
            String(
                existing.service ||
                    ""
            ).trim().toLowerCase() !==
            normalizedService
        ) {
            throw createError(
                "Reservation service does not match the existing reservation.",
                "RESERVATION_CONFLICT"
            );
        }

        return existing;
    }

    /*
     * Deterministic ID is the concurrency barrier.
     *
     * If two requests arrive simultaneously with the
     * same UID + reference, both transactions read this
     * same document. Firestore transaction retry semantics
     * ensure only one can create the reservation.
     */
    const reservationId =
        createReservationId(
            authenticatedUid,
            normalizedReference
        );

    const walletRef =
        getWalletRef(
            authenticatedUid
        );

    const reservationRef =
        getReservationRef(
            reservationId
        );

    const auditRef =
        db
            .collection(
                RESERVATIONS_COLLECTION
            )
            .doc(
                reservationId
            )
            .collection("audit")
            .doc(createAuditId());

    const now =
        new Date();

    return db.runTransaction(
        async (transaction) => {
            const walletSnapshot =
                await transaction.get(
                    walletRef
                );

            const reservationSnapshot =
                await transaction.get(
                    reservationRef
                );

            if (
                reservationSnapshot.exists
            ) {
                const existingReservation =
                    reservationSnapshot.data();

                if (
                    existingReservation.uid !==
                    authenticatedUid
                ) {
                    throw createError(
                        "Reservation ownership mismatch.",
                        "RESERVATION_OWNERSHIP_ERROR"
                    );
                }

                if (
                    existingReservation.reference !==
                    normalizedReference
                ) {
                    throw createError(
                        "Reservation reference conflict.",
                        "RESERVATION_CONFLICT"
                    );
                }

                if (
                    existingReservation.amountKobo !==
                    amount
                ) {
                    throw createError(
                        "Reservation amount does not match the existing reservation.",
                        "RESERVATION_CONFLICT"
                    );
                }

                if (
                    String(
                        existingReservation.currency ||
                            ""
                    ).toUpperCase() !==
                    normalizedCurrency
                ) {
                    throw createError(
                        "Reservation currency does not match the existing reservation.",
                        "RESERVATION_CONFLICT"
                    );
                }

                if (
                    String(
                        existingReservation.service ||
                            ""
                    ).trim().toLowerCase() !==
                    normalizedService
                ) {
                    throw createError(
                        "Reservation service does not match the existing reservation.",
                        "RESERVATION_CONFLICT"
                    );
                }

                return {
                    id:
                        reservationSnapshot.id,
                    ...existingReservation
                };
            }

            const wallet =
                readWalletState(
                    walletSnapshot.exists
                        ? walletSnapshot.data()
                        : null
                );

            if (
                wallet.availableKobo <
                amount
            ) {
                throw createError(
                    "Insufficient wallet balance.",
                    "INSUFFICIENT_FUNDS"
                );
            }

            const reservation =
                buildReservationData({
                    reservationId,
                    uid:
                        authenticatedUid,
                    reference:
                        normalizedReference,
                    amountKobo:
                        amount,
                    currency:
                        normalizedCurrency,
                    service:
                        normalizedService,
                    wallet,
                    metadata,
                    now
                });

            const newReservedKobo =
                wallet.reservedKobo +
                amount;

            const newAvailableKobo =
                wallet.balanceKobo -
                newReservedKobo;

            transaction.update(
                walletRef,
                {
                    reservedKobo:
                        newReservedKobo,
                    updatedAt: now
                }
            );

            transaction.create(
                reservationRef,
                reservation
            );

            transaction.create(
                auditRef,
                {
                    id: auditRef.id,
                    reservationId,
                    uid:
                        authenticatedUid,
                    action: "reserved",
                    status:
                        STATUS_PENDING,
                    amountKobo:
                        amount,
                    balanceKobo:
                        wallet.balanceKobo,
                    reservedKobo:
                        newReservedKobo,
                    availableKobo:
                        newAvailableKobo,
                    createdAt: now
                }
            );

            return reservation;
        }
    );
}

async function getReservation(
    reservationId
) {
    const reservationRef =
        getReservationRef(
            reservationId
        );

    const snapshot =
        await reservationRef.get();

    if (!snapshot.exists) {
        throw createError(
            "Reservation not found.",
            "RESERVATION_NOT_FOUND"
        );
    }

    return {
        id: snapshot.id,
        ...snapshot.data()
    };
}

async function commitReservation({
    uid,
    reservationId,
    provider = null
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedReservationId =
        requireReservationId(
            reservationId
        );

    const normalizedProvider =
        provider
            ? String(provider)
                .trim()
                .toLowerCase()
                .slice(0, 100)
            : null;

    const walletRef =
        getWalletRef(
            authenticatedUid
        );

    const reservationRef =
        getReservationRef(
            normalizedReservationId
        );

    const ledgerRef =
        walletRef
            .collection("ledger")
            .doc(
                normalizedReservationId
            );

    const auditRef =
        db
            .collection(
                RESERVATIONS_COLLECTION
            )
            .doc(
                normalizedReservationId
            )
            .collection("audit")
            .doc(createAuditId());

    const now =
        new Date();

    return db.runTransaction(
        async (transaction) => {
            const walletSnapshot =
                await transaction.get(
                    walletRef
                );

            const reservationSnapshot =
                await transaction.get(
                    reservationRef
                );

            if (
                !reservationSnapshot.exists
            ) {
                throw createError(
                    "Reservation not found.",
                    "RESERVATION_NOT_FOUND"
                );
            }

            const reservation =
                reservationSnapshot.data();

            if (
                reservation.uid !==
                authenticatedUid
            ) {
                throw createError(
                    "Reservation ownership mismatch.",
                    "RESERVATION_OWNERSHIP_ERROR"
                );
            }

            if (
                reservation.status ===
                STATUS_COMMITTED
            ) {
                return {
                    id:
                        reservationSnapshot.id,
                    ...reservation
                };
            }

            if (
                reservation.status ===
                STATUS_RELEASED
            ) {
                throw createError(
                    "Released reservation cannot be committed.",
                    "RESERVATION_ALREADY_RELEASED"
                );
            }

            if (
                reservation.status !==
                STATUS_PENDING
            ) {
                throw createError(
                    "Reservation is in an invalid state.",
                    "INVALID_RESERVATION_STATE"
                );
            }

            const amount =
                validateAmountKobo(
                    reservation.amountKobo
                );

            const wallet =
                readWalletState(
                    walletSnapshot.exists
                        ? walletSnapshot.data()
                        : null
                );

            if (
                wallet.reservedKobo <
                amount
            ) {
                throw createError(
                    "Wallet reserved amount is inconsistent with the reservation.",
                    "RESERVATION_STATE_CONFLICT"
                );
            }

            if (
                wallet.balanceKobo <
                amount
            ) {
                throw createError(
                    "Wallet balance is insufficient for reservation commit.",
                    "INSUFFICIENT_FUNDS"
                );
            }

            const newBalanceKobo =
                wallet.balanceKobo -
                amount;

            const newReservedKobo =
                wallet.reservedKobo -
                amount;

            const newAvailableKobo =
                newBalanceKobo -
                newReservedKobo;

            transaction.update(
                walletRef,
                {
                    balanceKobo:
                        newBalanceKobo,
                    reservedKobo:
                        newReservedKobo,
                    updatedAt: now
                }
            );

            transaction.update(
                reservationRef,
                {
                    status:
                        STATUS_COMMITTED,
                    balanceBeforeKobo:
                        wallet.balanceKobo,
                    balanceAfterKobo:
                        newBalanceKobo,
                    reservedBeforeKobo:
                        wallet.reservedKobo,
                    reservedAfterKobo:
                        newReservedKobo,
                    availableBeforeKobo:
                        wallet.availableKobo,
                    availableAfterKobo:
                        newAvailableKobo,
                    committedAt: now,
                    updatedAt: now,
                    provider:
                        normalizedProvider
                }
            );

            transaction.create(
                ledgerRef,
                {
                    id:
                        ledgerRef.id,
                    uid:
                        authenticatedUid,
                    reservationId:
                        normalizedReservationId,
                    reference:
                        reservation.reference,
                    amountKobo:
                        amount,
                    balanceBeforeKobo:
                        wallet.balanceKobo,
                    balanceAfterKobo:
                        newBalanceKobo,
                    reservedBeforeKobo:
                        wallet.reservedKobo,
                    reservedAfterKobo:
                        newReservedKobo,
                    availableBeforeKobo:
                        wallet.availableKobo,
                    availableAfterKobo:
                        newAvailableKobo,
                    createdAt: now,
                    type:
                        reservation.service,
                    service:
                        reservation.service ||
                        "airtime",
                    status:
                        "successful",
                    direction:
                        "debit",
                    currency:
                        reservation.currency ||
                        CURRENCY,
                    provider:
                        normalizedProvider
                }
            );

            transaction.create(
                auditRef,
                {
                    id: auditRef.id,
                    reservationId:
                        normalizedReservationId,
                    uid:
                        authenticatedUid,
                    action: "committed",
                    status:
                        STATUS_COMMITTED,
                    amountKobo:
                        amount,
                    balanceBeforeKobo:
                        wallet.balanceKobo,
                    balanceAfterKobo:
                        newBalanceKobo,
                    reservedBeforeKobo:
                        wallet.reservedKobo,
                    reservedAfterKobo:
                        newReservedKobo,
                    availableBeforeKobo:
                        wallet.availableKobo,
                    availableAfterKobo:
                        newAvailableKobo,
                    provider:
                        normalizedProvider,
                    createdAt: now
                }
            );

            return {
                id:
                    reservationSnapshot.id,
                ...reservation,
                status:
                    STATUS_COMMITTED,
                balanceBeforeKobo:
                    wallet.balanceKobo,
                balanceAfterKobo:
                    newBalanceKobo,
                reservedBeforeKobo:
                    wallet.reservedKobo,
                reservedAfterKobo:
                    newReservedKobo,
                availableBeforeKobo:
                    wallet.availableKobo,
                availableAfterKobo:
                    newAvailableKobo,
                committedAt: now,
                updatedAt: now,
                provider:
                    normalizedProvider
            };
        }
    );
}

async function releaseReservation({
    uid,
    reservationId,
    reason = null,
    provider = null
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedReservationId =
        requireReservationId(
            reservationId
        );

    const normalizedReason =
        reason
            ? String(reason)
                .trim()
                .slice(0, 200)
            : null;

    const normalizedProvider =
        provider
            ? String(provider)
                .trim()
                .toLowerCase()
                .slice(0, 100)
            : null;

    const walletRef =
        getWalletRef(
            authenticatedUid
        );

    const reservationRef =
        getReservationRef(
            normalizedReservationId
        );

    const auditRef =
        db
            .collection(
                RESERVATIONS_COLLECTION
            )
            .doc(
                normalizedReservationId
            )
            .collection("audit")
            .doc(createAuditId());

    const now =
        new Date();

    return db.runTransaction(
        async (transaction) => {
            const walletSnapshot =
                await transaction.get(
                    walletRef
                );

            const reservationSnapshot =
                await transaction.get(
                    reservationRef
                );

            if (
                !reservationSnapshot.exists
            ) {
                throw createError(
                    "Reservation not found.",
                    "RESERVATION_NOT_FOUND"
                );
            }

            const reservation =
                reservationSnapshot.data();

            if (
                reservation.uid !==
                authenticatedUid
            ) {
                throw createError(
                    "Reservation ownership mismatch.",
                    "RESERVATION_OWNERSHIP_ERROR"
                );
            }

            if (
                reservation.status ===
                STATUS_RELEASED
            ) {
                return {
                    id:
                        reservationSnapshot.id,
                    ...reservation
                };
            }

            if (
                reservation.status ===
                STATUS_COMMITTED
            ) {
                throw createError(
                    "Committed reservation cannot be released.",
                    "RESERVATION_ALREADY_COMMITTED"
                );
            }

            if (
                reservation.status !==
                STATUS_PENDING
            ) {
                throw createError(
                    "Reservation is in an invalid state.",
                    "INVALID_RESERVATION_STATE"
                );
            }

            const amount =
                validateAmountKobo(
                    reservation.amountKobo
                );

            const wallet =
                readWalletState(
                    walletSnapshot.exists
                        ? walletSnapshot.data()
                        : null
                );

            /*
             * Never blindly reduce reservedKobo when the wallet
             * says less is reserved than this reservation requires.
             *
             * This is a deliberate safety stop. A mismatch must be
             * investigated/reconciled instead of potentially creating
             * an incorrect wallet state.
             */
            if (
                wallet.reservedKobo <
                amount
            ) {
                throw createError(
                    "Wallet reserved amount is inconsistent with the reservation.",
                    "RESERVATION_STATE_CONFLICT"
                );
            }

            const newReservedKobo =
                wallet.reservedKobo -
                amount;

            const newAvailableKobo =
                wallet.balanceKobo -
                newReservedKobo;

            transaction.update(
                walletRef,
                {
                    reservedKobo:
                        newReservedKobo,
                    updatedAt: now
                }
            );

            transaction.update(
                reservationRef,
                {
                    status:
                        STATUS_RELEASED,
                    reservedBeforeKobo:
                        wallet.reservedKobo,
                    reservedAfterKobo:
                        newReservedKobo,
                    availableBeforeKobo:
                        wallet.availableKobo,
                    availableAfterKobo:
                        newAvailableKobo,
                    releasedAt: now,
                    updatedAt: now,
                    releaseReason:
                        normalizedReason,
                    provider:
                        normalizedProvider
                }
            );

            transaction.create(
                auditRef,
                {
                    id: auditRef.id,
                    reservationId:
                        normalizedReservationId,
                    uid:
                        authenticatedUid,
                    action: "released",
                    status:
                        STATUS_RELEASED,
                    amountKobo:
                        amount,
                    balanceKobo:
                        wallet.balanceKobo,
                    reservedBeforeKobo:
                        wallet.reservedKobo,
                    reservedAfterKobo:
                        newReservedKobo,
                    availableBeforeKobo:
                        wallet.availableKobo,
                    availableAfterKobo:
                        newAvailableKobo,
                    reason:
                        normalizedReason,
                    provider:
                        normalizedProvider,
                    createdAt: now
                }
            );

            return {
                id:
                    reservationSnapshot.id,
                ...reservation,
                status:
                    STATUS_RELEASED,
                reservedBeforeKobo:
                    wallet.reservedKobo,
                reservedAfterKobo:
                    newReservedKobo,
                availableBeforeKobo:
                    wallet.availableKobo,
                availableAfterKobo:
                    newAvailableKobo,
                releasedAt: now,
                updatedAt: now,
                releaseReason:
                    normalizedReason,
                provider:
                    normalizedProvider
            };
        }
    );
}

async function getWalletBalance(
    uid
) {
    const authenticatedUid =
        requireUid(uid);

    const walletRef =
        getWalletRef(
            authenticatedUid
        );

    const snapshot =
        await walletRef.get();

    const wallet =
        readWalletState(
            snapshot.exists
                ? snapshot.data()
                : null
        );

    return {
        uid:
            authenticatedUid,
        currency:
            CURRENCY,
        balanceKobo:
            wallet.balanceKobo,
        reservedKobo:
            wallet.reservedKobo,
        availableKobo:
            wallet.availableKobo
    };
}

module.exports = {
    reserveFunds,
    getReservation,
    commitReservation,
    releaseReservation,
    getWalletBalance
};