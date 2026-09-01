// wallet/reservation.js

const crypto = require("crypto");

const { db } = require("../firebase-admin");


// =====================================================
// NOVAPAY — WALLET RESERVATION / DEBIT FOUNDATION
// =====================================================
//
// Financial invariant:
//
//     0 <= reservedKobo <= balanceKobo
//
// Available balance:
//
//     availableKobo =
//         balanceKobo - reservedKobo
//
// IMPORTANT:
//
// - Frontend never changes wallet balances.
// - All monetary values are stored as integer kobo.
// - Reservations are temporary wallet locks.
// - Reservation creation is atomic.
// - Reservation commit is atomic.
// - Reservation release is atomic.
// - Idempotency is deterministic.
// - A committed reservation can never be released.
// - A released reservation can never be committed.
// - Provider uncertainty does NOT automatically release funds.
//
// Wallet document:
//
// wallets/{uid}
//
// {
//     uid: "...",
//     currency: "NGN",
//     balanceKobo: 100000,
//     reservedKobo: 20000,
//     updatedAt: ...
// }
//
// Reservation document:
//
// reservations/{reservationId}
//
// {
//     id: "...",
//     uid: "...",
//     reference: "...",
//     service: "airtime",
//     amountKobo: 20000,
//     currency: "NGN",
//     status: "pending",
//     ...
// }
//
// =====================================================


// =====================================================
// COLLECTIONS
// =====================================================

const WALLETS_COLLECTION =
    "wallets";

const RESERVATIONS_COLLECTION =
    "reservations";

const LEDGER_COLLECTION =
    "ledger";


// =====================================================
// CONSTANTS
// =====================================================

const DEFAULT_CURRENCY =
    "NGN";


const RESERVATION_STATUS =
    Object.freeze({

        PENDING:
            "pending",

        COMMITTED:
            "committed",

        RELEASED:
            "released"

    });


// =====================================================
// VALIDATION
// =====================================================

function validateUid(uid) {

    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {

        throw new Error(
            "Authenticated user ID is required."
        );

    }

    return uid.trim();

}


// -----------------------------------------------------
// AMOUNT
// -----------------------------------------------------

function validateAmountKobo(
    amountKobo
) {

    const amount =
        Number(
            amountKobo
        );


    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0
    ) {

        throw new Error(
            "Amount must be a positive integer in kobo."
        );

    }


    return amount;

}


// -----------------------------------------------------
// CURRENCY
// -----------------------------------------------------

function normalizeCurrency(
    currency
) {

    const normalized =
        String(
            currency ||
            DEFAULT_CURRENCY
        )
            .trim()
            .toUpperCase();


    if (
        normalized !==
        DEFAULT_CURRENCY
    ) {

        throw new Error(
            "Unsupported wallet currency."
        );

    }


    return normalized;

}


// -----------------------------------------------------
// REFERENCE
// -----------------------------------------------------

function normalizeReference(
    reference
) {

    const normalized =
        String(
            reference ||
            ""
        )
            .trim();


    if (!normalized) {

        throw new Error(
            "Transaction reference is required."
        );

    }


    if (
        normalized.length >
        200
    ) {

        throw new Error(
            "Transaction reference is too long."
        );

    }


    return normalized;

}


// -----------------------------------------------------
// SERVICE
// -----------------------------------------------------

function normalizeService(
    service
) {

    const normalized =
        String(
            service ||
            ""
        )
            .trim()
            .toLowerCase();


    if (!normalized) {

        throw new Error(
            "Payment service is required."
        );

    }


    if (
        normalized.length >
        50
    ) {

        throw new Error(
            "Payment service is too long."
        );

    }


    return normalized;

}


// =====================================================
// WALLET REFERENCE
// =====================================================

function getWalletRef(uid) {

    const validUid =
        validateUid(uid);


    return db
        .collection(
            WALLETS_COLLECTION
        )
        .doc(
            validUid
        );

}


// =====================================================
// RESERVATION REFERENCE
// =====================================================

function getReservationRef(
    uid,
    reservationId
) {

    validateUid(uid);


    if (
        typeof reservationId !==
            "string" ||
        !reservationId.trim()
    ) {

        throw new Error(
            "Reservation ID is required."
        );

    }


    return db
        .collection(
            RESERVATIONS_COLLECTION
        )
        .doc(
            reservationId.trim()
        );

}


// =====================================================
// LEDGER REFERENCE
// =====================================================

function getLedgerRef(
    uid,
    ledgerId
) {

    const validUid =
        validateUid(uid);


    if (
        typeof ledgerId !==
            "string" ||
        !ledgerId.trim()
    ) {

        throw new Error(
            "Ledger ID is required."
        );

    }


    return getWalletRef(
        validUid
    )
        .collection(
            LEDGER_COLLECTION
        )
        .doc(
            ledgerId.trim()
        );

}


// =====================================================
// RESERVATION ID
// =====================================================
//
// Deterministic.
//
// Same:
//
//     uid + reference
//
// produces the same reservation ID.
//
// This is the foundation for idempotency.
//
// IMPORTANT:
//
// The caller must therefore use a stable transaction
// reference when retrying the same financial operation.
// =====================================================

function createReservationId(
    uid,
    reference
) {

    const validUid =
        validateUid(uid);

    const validReference =
        normalizeReference(
            reference
        );


    return crypto
        .createHash(
            "sha256"
        )
        .update(
            `novapay-reservation:v1:${validUid}:${validReference}`
        )
        .digest(
            "hex"
        );

}


// =====================================================
// LEDGER ID
// =====================================================

function createLedgerId(
    uid,
    reference,
    service
) {

    const validUid =
        validateUid(uid);

    const validReference =
        normalizeReference(
            reference
        );

    const validService =
        normalizeService(
            service
        );


    return crypto
        .createHash(
            "sha256"
        )
        .update(
            `novapay-ledger:v1:${validUid}:${validService}:${validReference}`
        )
        .digest(
            "hex"
        );

}


// =====================================================
// VALIDATE WALLET
// =====================================================

function validateWalletData(
    wallet
) {

    if (
        !wallet ||
        typeof wallet !== "object"
    ) {

        throw new Error(
            "Wallet data is invalid."
        );

    }


    const balanceKobo =
        Number(
            wallet.balanceKobo
        );


    const reservedKobo =
        Number(
            wallet.reservedKobo ??
            0
        );


    if (
        !Number.isSafeInteger(
            balanceKobo
        ) ||
        balanceKobo < 0
    ) {

        throw new Error(
            "Wallet contains an invalid balance."
        );

    }


    if (
        !Number.isSafeInteger(
            reservedKobo
        ) ||
        reservedKobo < 0
    ) {

        throw new Error(
            "Wallet contains an invalid reserved balance."
        );

    }


    if (
        reservedKobo >
        balanceKobo
    ) {

        throw new Error(
            "Wallet reservation integrity violation."
        );

    }


    const currency =
        normalizeCurrency(
            wallet.currency
        );


    return {

        balanceKobo,

        reservedKobo,

        availableKobo:
            balanceKobo -
            reservedKobo,

        currency

    };

}


// =====================================================
// CALCULATE AVAILABLE BALANCE
// =====================================================
//
// This function reads the wallet aggregate.
//
// It intentionally does NOT scan reservation documents.
//
// The wallet's reservedKobo is the authoritative aggregate.
// =====================================================

async function calculateAvailableBalance(
    transaction,
    uid
) {

    const validUid =
        validateUid(uid);


    const walletRef =
        getWalletRef(
            validUid
        );


    const walletSnapshot =
        await transaction.get(
            walletRef
        );


    if (
        !walletSnapshot.exists
    ) {

        throw new Error(
            "Wallet not found."
        );

    }


    return validateWalletData(
        walletSnapshot.data()
    );

}


// =====================================================
// RESERVE FUNDS
// =====================================================
//
// Atomic operation:
//
//     wallet.reservedKobo += amount
//     reservation.status = pending
//
// Both changes occur in ONE Firestore transaction.
//
// Therefore concurrent reservation attempts against the
// same wallet serialize correctly.
// =====================================================

async function reserveFunds({
    uid,
    reference,
    amountKobo,
    currency = DEFAULT_CURRENCY,
    service = "airtime",
    metadata = {}
}) {

    const validUid =
        validateUid(uid);

    const validReference =
        normalizeReference(
            reference
        );

    const validAmount =
        validateAmountKobo(
            amountKobo
        );

    const validCurrency =
        normalizeCurrency(
            currency
        );

    const validService =
        normalizeService(
            service
        );


    const reservationId =
        createReservationId(
            validUid,
            validReference
        );


    const reservationRef =
        getReservationRef(
            validUid,
            reservationId
        );


    const walletRef =
        getWalletRef(
            validUid
        );


    const safeMetadata =
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata)
            ? metadata
            : {};


    const result =
        await db.runTransaction(
            async transaction => {

                // -----------------------------------------
                // READ RESERVATION
                // -----------------------------------------

                const reservationSnapshot =
                    await transaction.get(
                        reservationRef
                    );


                // -----------------------------------------
                // IDEMPOTENT RETRY
                // -----------------------------------------

                if (
                    reservationSnapshot.exists
                ) {

                    const existing =
                        reservationSnapshot.data();


                    if (
                        existing.uid !==
                        validUid
                    ) {

                        throw new Error(
                            "Reservation ownership mismatch."
                        );

                    }


                    if (
                        Number(
                            existing.amountKobo
                        ) !==
                        validAmount
                    ) {

                        throw new Error(
                            "Transaction reference is already associated with a different amount."
                        );

                    }


                    if (
                        String(
                            existing.currency ||
                            ""
                        )
                            .toUpperCase() !==
                        validCurrency
                    ) {

                        throw new Error(
                            "Transaction reference is already associated with a different currency."
                        );

                    }


                    if (
                        String(
                            existing.service ||
                            ""
                        )
                            .trim()
                            .toLowerCase() !==
                        validService
                    ) {

                        throw new Error(
                            "Transaction reference is already associated with a different service."
                        );

                    }


                    return {

                        reservationId,

                        status:
                            existing.status,

                        amountKobo:
                            Number(
                                existing.amountKobo
                            ),

                        currency:
                            existing.currency,

                        balanceKobo:
                            Number(
                                existing.balanceKobo
                            ),

                        reservedBeforeKobo:
                            Number(
                                existing.reservedBeforeKobo
                            ),

                        reservedAfterKobo:
                            Number(
                                existing.reservedAfterKobo
                            ),

                        availableKobo:
                            Number(
                                existing.availableKobo
                            ),

                        availableAfterKobo:
                            Number(
                                existing.availableAfterKobo
                            ),

                        duplicate:
                            true

                    };

                }


                // -----------------------------------------
                // READ WALLET
                // -----------------------------------------

                const walletSnapshot =
                    await transaction.get(
                        walletRef
                    );


                if (
                    !walletSnapshot.exists
                ) {

                    throw new Error(
                        "Wallet not found."
                    );

                }


                const wallet =
                    validateWalletData(
                        walletSnapshot.data()
                    );


                if (
                    wallet.currency !==
                    validCurrency
                ) {

                    throw new Error(
                        "Wallet currency mismatch."
                    );

                }


                // -----------------------------------------
                // AVAILABLE BALANCE
                // -----------------------------------------

                const availableKobo =
                    wallet.availableKobo;


                // -----------------------------------------
                // INSUFFICIENT FUNDS
                // -----------------------------------------

                if (
                    availableKobo <
                    validAmount
                ) {

                    const error =
                        new Error(
                            "Insufficient wallet balance."
                        );


                    error.code =
                        "INSUFFICIENT_FUNDS";


                    throw error;

                }


                // -----------------------------------------
                // NEW RESERVED BALANCE
                // -----------------------------------------

                const reservedAfterKobo =
                    wallet.reservedKobo +
                    validAmount;


                if (
                    !Number.isSafeInteger(
                        reservedAfterKobo
                    )
                ) {

                    throw new Error(
                        "Reserved wallet amount exceeds supported limits."
                    );

                }


                if (
                    reservedAfterKobo >
                    wallet.balanceKobo
                ) {

                    throw new Error(
                        "Wallet reservation would exceed available funds."
                    );

                }


                const availableAfterKobo =
                    wallet.balanceKobo -
                    reservedAfterKobo;


                const now =
                    new Date();


                // -----------------------------------------
                // UPDATE WALLET
                // -----------------------------------------

                transaction.update(
                    walletRef,
                    {

                        reservedKobo:
                            reservedAfterKobo,

                        updatedAt:
                            now

                    }
                );


                // -----------------------------------------
                // CREATE RESERVATION
                // -----------------------------------------

                transaction.create(
                    reservationRef,
                    {

                        id:
                            reservationId,

                        uid:
                            validUid,

                        reference:
                            validReference,

                        service:
                            validService,

                        amountKobo:
                            validAmount,

                        currency:
                            validCurrency,

                        status:
                            RESERVATION_STATUS.PENDING,

                        balanceKobo:
                            wallet.balanceKobo,

                        reservedBeforeKobo:
                            wallet.reservedKobo,

                        reservedAfterKobo,

                        availableKobo:

                            wallet.availableKobo,

                        availableAfterKobo,

                        metadata:
                            safeMetadata,

                        createdAt:
                            now,

                        updatedAt:
                            now

                    }
                );


                return {

                    reservationId,

                    status:
                        RESERVATION_STATUS.PENDING,

                    amountKobo:
                        validAmount,

                    currency:
                        validCurrency,

                    balanceKobo:
                        wallet.balanceKobo,

                    reservedBeforeKobo:
                        wallet.reservedKobo,

                    reservedAfterKobo,

                    availableKobo:
                        wallet.availableKobo,

                    availableAfterKobo,

                    duplicate:
                        false

                };

            }
        );


    return {

        uid:
            validUid,

        ...result

    };

}


// =====================================================
// COMMIT RESERVATION
// =====================================================
//
// Atomic operation:
//
//     wallet.balanceKobo -= amount
//     wallet.reservedKobo -= amount
//     reservation.status = committed
//     ledger entry = successful debit
//
// Everything occurs in ONE Firestore transaction.
// =====================================================

async function commitReservation({
    uid,
    reservationId,
    provider = "vtu.ng",
    providerReference = null
}) {

    const validUid =
        validateUid(uid);


    const reservationRef =
        getReservationRef(
            validUid,
            reservationId
        );


    const walletRef =
        getWalletRef(
            validUid
        );


    const normalizedProvider =
        String(
            provider ||
            "vtu.ng"
        )
            .trim()
            .toLowerCase();


    if (
        !normalizedProvider
    ) {

        throw new Error(
            "Provider is required."
        );

    }


    const normalizedProviderReference =
        providerReference !==
            undefined &&
        providerReference !==
            null
            ? String(
                providerReference
            )
                .trim()
                .slice(
                    0,
                    200
                ) ||
                null
            : null;


    const result =
        await db.runTransaction(
            async transaction => {

                // -----------------------------------------
                // READ RESERVATION
                // -----------------------------------------

                const reservationSnapshot =
                    await transaction.get(
                        reservationRef
                    );


                if (
                    !reservationSnapshot.exists
                ) {

                    throw new Error(
                        "Reservation not found."
                    );

                }


                const reservation =
                    reservationSnapshot.data();


                if (
                    reservation.uid !==
                    validUid
                ) {

                    throw new Error(
                        "Reservation ownership mismatch."
                    );

                }


                const amountKobo =
                    validateAmountKobo(
                        reservation.amountKobo
                    );


                const service =
                    normalizeService(
                        reservation.service
                    );


                // -----------------------------------------
                // IDEMPOTENT COMMIT
                // -----------------------------------------

                if (
                    reservation.status ===
                    RESERVATION_STATUS.COMMITTED
                ) {

                    return {

                        committed:
                            true,

                        duplicate:
                            true,

                        amountKobo,

                        balanceAfterKobo:
                            Number(
                                reservation.balanceAfterKobo
                            ),

                        ledgerId:
                            reservation.ledgerId ||
                            null

                    };

                }


                // -----------------------------------------
                // TERMINAL RELEASE
                // -----------------------------------------

                if (
                    reservation.status ===
                    RESERVATION_STATUS.RELEASED
                ) {

                    throw new Error(
                        "A released reservation cannot be committed."
                    );

                }


                if (
                    reservation.status !==
                    RESERVATION_STATUS.PENDING
                ) {

                    throw new Error(
                        "Reservation is not pending."
                    );

                }


                // -----------------------------------------
                // READ WALLET
                // -----------------------------------------

                const walletSnapshot =
                    await transaction.get(
                        walletRef
                    );


                if (
                    !walletSnapshot.exists
                ) {

                    throw new Error(
                        "Wallet not found."
                    );

                }


                const wallet =
                    validateWalletData(
                        walletSnapshot.data()
                    );


                // -----------------------------------------
                // VERIFY RESERVED BALANCE
                // -----------------------------------------

                if (
                    wallet.reservedKobo <
                    amountKobo
                ) {

                    throw new Error(
                        "Wallet reserved balance is insufficient for this reservation."
                    );

                }


                if (
                    wallet.balanceKobo <
                    amountKobo
                ) {

                    throw new Error(
                        "Wallet balance is insufficient for the reserved debit."
                    );

                }


                // -----------------------------------------
                // CALCULATE NEW WALLET STATE
                // -----------------------------------------

                const balanceAfterKobo =
                    wallet.balanceKobo -
                    amountKobo;


                const reservedAfterKobo =
                    wallet.reservedKobo -
                    amountKobo;


                if (
                    balanceAfterKobo <
                    0
                ) {

                    throw new Error(
                        "Wallet balance cannot become negative."
                    );

                }


                if (
                    reservedAfterKobo <
                    0
                ) {

                    throw new Error(
                        "Wallet reserved balance cannot become negative."
                    );

                }


                if (
                    reservedAfterKobo >
                    balanceAfterKobo
                ) {

                    throw new Error(
                        "Wallet reservation integrity violation after commit."
                    );

                }


                const availableAfterKobo =
                    balanceAfterKobo -
                    reservedAfterKobo;


                const now =
                    new Date();


                // -----------------------------------------
                // LEDGER ID
                // -----------------------------------------

                const ledgerId =
                    createLedgerId(
                        validUid,
                        reservation.reference,
                        service
                    );


                const ledgerRef =
                    getLedgerRef(
                        validUid,
                        ledgerId
                    );


                // -----------------------------------------
                // READ LEDGER
                // -----------------------------------------

                const ledgerSnapshot =
                    await transaction.get(
                        ledgerRef
                    );


                if (
                    ledgerSnapshot.exists
                ) {

                    const existingLedger =
                        ledgerSnapshot.data();


                    if (
                        existingLedger.reservationId !==
                        reservationSnapshot.id
                    ) {

                        throw new Error(
                            "Ledger reference collision detected."
                        );

                    }


                    throw new Error(
                        "A ledger entry already exists for this transaction."
                    );

                }


                // -----------------------------------------
                // UPDATE WALLET
                // -----------------------------------------

                transaction.update(
                    walletRef,
                    {

                        balanceKobo:
                            balanceAfterKobo,

                        reservedKobo:
                            reservedAfterKobo,

                        updatedAt:
                            now

                    }
                );


                // -----------------------------------------
                // UPDATE RESERVATION
                // -----------------------------------------

                transaction.update(
                    reservationRef,
                    {

                        status:
                            RESERVATION_STATUS.COMMITTED,

                        balanceAfterKobo,

                        reservedAfterKobo,

                        availableAfterKobo,

                        ledgerId,

                        provider:
                            normalizedProvider,

                        providerReference:
                            normalizedProviderReference,

                        committedAt:
                            now,

                        updatedAt:
                            now

                    }
                );


                // -----------------------------------------
                // CREATE LEDGER
                // -----------------------------------------

                transaction.create(
                    ledgerRef,
                    {

                        id:
                            ledgerId,

                        uid:
                            validUid,

                        type:
                            service,

                        direction:
                            "debit",

                        status:
                            "successful",

                        reference:
                            reservation.reference,

                        provider:
                            normalizedProvider,

                        providerReference:
                            normalizedProviderReference,

                        amountKobo,

                        currency:
                            reservation.currency,

                        balanceBeforeKobo:
                            wallet.balanceKobo,

                        balanceAfterKobo,

                        reservedBeforeKobo:
                            wallet.reservedKobo,

                        reservedAfterKobo,

                        availableAfterKobo,

                        reservationId:
                            reservationSnapshot.id,

                        createdAt:
                            now

                    }
                );


                return {

                    committed:
                        true,

                    duplicate:
                        false,

                    amountKobo,

                    balanceAfterKobo,

                    reservedAfterKobo,

                    availableAfterKobo,

                    ledgerId

                };

            }
        );


    return {

        uid:
            validUid,

        reservationId,

        ...result

    };

}


// =====================================================
// RELEASE RESERVATION
// =====================================================
//
// Atomic operation:
//
//     wallet.reservedKobo -= amount
//     reservation.status = released
//
// IMPORTANT:
//
// No money is credited.
//
// The money was never permanently debited.
//
// We simply remove the temporary lock.
// =====================================================

async function releaseReservation({
    uid,
    reservationId,
    reason = "provider_failed"
}) {

    const validUid =
        validateUid(uid);


    const reservationRef =
        getReservationRef(
            validUid,
            reservationId
        );


    const walletRef =
        getWalletRef(
            validUid
        );


    const normalizedReason =
        String(
            reason ||
            "provider_failed"
        )
            .trim()
            .slice(
                0,
                300
            );


    const result =
        await db.runTransaction(
            async transaction => {

                // -----------------------------------------
                // READ RESERVATION
                // -----------------------------------------

                const reservationSnapshot =
                    await transaction.get(
                        reservationRef
                    );


                if (
                    !reservationSnapshot.exists
                ) {

                    throw new Error(
                        "Reservation not found."
                    );

                }


                const reservation =
                    reservationSnapshot.data();


                if (
                    reservation.uid !==
                    validUid
                ) {

                    throw new Error(
                        "Reservation ownership mismatch."
                    );

                }


                const amountKobo =
                    validateAmountKobo(
                        reservation.amountKobo
                    );


                // -----------------------------------------
                // IDEMPOTENT RELEASE
                // -----------------------------------------

                if (
                    reservation.status ===
                    RESERVATION_STATUS.RELEASED
                ) {

                    return {

                        released:
                            true,

                        duplicate:
                            true,

                        amountKobo,

                        balanceKobo:
                            Number(
                                reservation.balanceKobo
                            ),

                        reservedAfterKobo:
                            Number(
                                reservation.reservedAfterKobo
                            ),

                        availableAfterKobo:
                            Number(
                                reservation.availableAfterKobo
                            )

                    };

                }


                // -----------------------------------------
                // CANNOT RELEASE COMMITTED MONEY
                // -----------------------------------------

                if (
                    reservation.status ===
                    RESERVATION_STATUS.COMMITTED
                ) {

                    throw new Error(
                        "A committed reservation cannot be released."
                    );

                }


                if (
                    reservation.status !==
                    RESERVATION_STATUS.PENDING
                ) {

                    throw new Error(
                        "Reservation cannot be released."
                    );

                }


                // -----------------------------------------
                // READ WALLET
                // -----------------------------------------

                const walletSnapshot =
                    await transaction.get(
                        walletRef
                    );


                if (
                    !walletSnapshot.exists
                ) {

                    throw new Error(
                        "Wallet not found."
                    );

                }


                const wallet =
                    validateWalletData(
                        walletSnapshot.data()
                    );


                // -----------------------------------------
                // VERIFY RESERVED BALANCE
                // -----------------------------------------

                if (
                    wallet.reservedKobo <
                    amountKobo
                ) {

                    throw new Error(
                        "Wallet reserved balance is insufficient for this release."
                    );

                }


                // -----------------------------------------
                // CALCULATE NEW RESERVED BALANCE
                // -----------------------------------------

                const reservedAfterKobo =
                    wallet.reservedKobo -
                    amountKobo;


                if (
                    reservedAfterKobo <
                    0
                ) {

                    throw new Error(
                        "Wallet reserved balance cannot become negative."
                    );

                }


                if (
                    reservedAfterKobo >
                    wallet.balanceKobo
                ) {

                    throw new Error(
                        "Wallet reservation integrity violation after release."
                    );

                }


                const availableAfterKobo =
                    wallet.balanceKobo -
                    reservedAfterKobo;


                const now =
                    new Date();


                // -----------------------------------------
                // UPDATE WALLET
                // -----------------------------------------

                transaction.update(
                    walletRef,
                    {

                        reservedKobo:
                            reservedAfterKobo,

                        updatedAt:
                            now

                    }
                );


                // -----------------------------------------
                // UPDATE RESERVATION
                // -----------------------------------------

                transaction.update(
                    reservationRef,
                    {

                        status:
                            RESERVATION_STATUS.RELEASED,

                        reservedAfterKobo,

                        availableAfterKobo,

                        releaseReason:
                            normalizedReason,

                        releasedAt:
                            now,

                        updatedAt:
                            now

                    }
                );


                return {

                    released:
                        true,

                    duplicate:
                        false,

                    amountKobo,

                    balanceKobo:
                        wallet.balanceKobo,

                    reservedBeforeKobo:
                        wallet.reservedKobo,

                    reservedAfterKobo,

                    availableAfterKobo

                };

            }
        );


    return {

        uid:
            validUid,

        reservationId,

        ...result

    };

}


// =====================================================
// GET RESERVATION
// =====================================================

async function getReservation({
    uid,
    reservationId
}) {

    const validUid =
        validateUid(uid);


    const reservationRef =
        getReservationRef(
            validUid,
            reservationId
        );


    const snapshot =
        await reservationRef.get();


    if (
        !snapshot.exists
    ) {

        return null;

    }


    const data =
        snapshot.data();


    if (
        data.uid !==
        validUid
    ) {

        return null;

    }


    return {

        id:
            snapshot.id,

        uid:
            validUid,

        reference:
            String(
                data.reference ||
                ""
            ),

        service:
            String(
                data.service ||
                ""
            ),

        amountKobo:
            Number(
                data.amountKobo
            ),

        currency:
            String(
                data.currency ||
                DEFAULT_CURRENCY
            ),

        status:
            String(
                data.status ||
                ""
            ),

        balanceKobo:
            Number(
                data.balanceKobo
            ),

        reservedBeforeKobo:
            Number(
                data.reservedBeforeKobo
            ),

        reservedAfterKobo:
            Number(
                data.reservedAfterKobo
            ),

        availableKobo:
            Number(
                data.availableKobo
            ),

        availableAfterKobo:
            Number(
                data.availableAfterKobo
            ),

        balanceAfterKobo:
            data.balanceAfterKobo !==
                undefined
                ? Number(
                    data.balanceAfterKobo
                )
                : null,

        ledgerId:
            data.ledgerId ||
            null,

        provider:
            data.provider ||
            null,

        providerReference:
            data.providerReference ||
            null,

        metadata:
            data.metadata &&
            typeof data.metadata ===
                "object"
                ? data.metadata
                : {},

        createdAt:
            data.createdAt ||
            null,

        updatedAt:
            data.updatedAt ||
            null,

        committedAt:
            data.committedAt ||
            null,

        releasedAt:
            data.releasedAt ||
            null,

        releaseReason:
            data.releaseReason ||
            null

    };

}


// =====================================================
// GET WALLET BALANCE
// =====================================================
//
// Useful for backend APIs.
//
// Returns the authoritative wallet aggregate.
// =====================================================

async function getWalletBalance(
    uid
) {

    const validUid =
        validateUid(uid);


    const walletRef =
        getWalletRef(
            validUid
        );


    const snapshot =
        await walletRef.get();


    if (
        !snapshot.exists
    ) {

        return null;

    }


    const wallet =
        validateWalletData(
            snapshot.data()
        );


    return {

        uid:
            validUid,

        currency:
            wallet.currency,

        balanceKobo:
            wallet.balanceKobo,

        reservedKobo:
            wallet.reservedKobo,

        availableKobo:
            wallet.availableKobo

    };

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    RESERVATION_STATUS,

    createReservationId,

    createLedgerId,

    validateAmountKobo,

    calculateAvailableBalance,

    getWalletBalance,

    reserveFunds,

    commitReservation,

    releaseReservation,

    getReservation

};