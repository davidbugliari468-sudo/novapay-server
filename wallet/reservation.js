// wallet/reservation.js

const crypto = require("crypto");

const { db } = require("../firebase-admin");


// =====================================================
// NOVAPAY — WALLET RESERVATION SERVICE
// =====================================================
//
// This module manages temporary wallet locks.
//
// Airtime flow:
//
//   Airtime service
//        ↓
//   reserveFunds()
//        ↓
//   money becomes RESERVED
//        ↓
//   VTU.ng operation
//        ↓
//   ┌──────────────┬──────────────┐
//   ↓              ↓              ↓
// SUCCESS        FAILURE        UNKNOWN
//   ↓              ↓              ↓
// COMMIT         RELEASE        KEEP RESERVED
//
// IMPORTANT
//
// reserveFunds()
//   → does NOT reduce balanceKobo
//
// commitReservation()
//   → reduces balanceKobo
//   → reduces reservedKobo
//
// releaseReservation()
//   → keeps balanceKobo unchanged
//   → reduces reservedKobo
//
// availableKobo:
//
//   balanceKobo - reservedKobo
//
// All financial changes use Firestore transactions.
// =====================================================


// =====================================================
// COLLECTIONS
// =====================================================

const WALLETS_COLLECTION = "wallets";

const RESERVATIONS_COLLECTION = "walletReservations";


// =====================================================
// CONSTANTS
// =====================================================

const CURRENCY = "NGN";

const STATUS_PENDING = "pending";

const STATUS_COMMITTED = "committed";

const STATUS_RELEASED = "released";


// =====================================================
// MAX RESERVATION
// =====================================================

const configuredMaximum =
    Number(process.env.MAX_WALLET_RESERVATION_KOBO);

const MAX_RESERVATION_KOBO =
    Number.isSafeInteger(configuredMaximum) &&
    configuredMaximum > 0
        ? configuredMaximum
        : Number.MAX_SAFE_INTEGER;


// =====================================================
// ERROR HELPER
// =====================================================

function createError(message, statusCode = 500) {
    const error = new Error(message);

    error.statusCode = statusCode;

    return error;
}


// =====================================================
// UID VALIDATION
// =====================================================

function requireUid(uid) {
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
// REFERENCE VALIDATION
// =====================================================

function requireReference(reference) {
    const normalized =
        String(reference || "").trim();

    if (!normalized) {
        throw createError(
            "Wallet reservation reference is required.",
            400
        );
    }

    if (normalized.length > 200) {
        throw createError(
            "Wallet reservation reference is too long.",
            400
        );
    }

    return normalized;
}


// =====================================================
// AMOUNT VALIDATION
// =====================================================

function validateAmountKobo(amountKobo) {
    const amount = Number(amountKobo);

    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0
    ) {
        throw createError(
            "Wallet reservation amount must be a positive integer in kobo.",
            400
        );
    }

    if (amount > MAX_RESERVATION_KOBO) {
        throw createError(
            "Wallet reservation amount exceeds the supported limit.",
            400
        );
    }

    return amount;
}


// =====================================================
// CURRENCY
// =====================================================

function normalizeCurrency(currency = CURRENCY) {
    const normalized =
        String(currency)
            .trim()
            .toUpperCase();

    if (normalized !== CURRENCY) {
        throw createError(
            "Unsupported wallet currency.",
            400
        );
    }

    return normalized;
}


// =====================================================
// SERVICE
// =====================================================

function normalizeService(service) {
    const normalized =
        String(service || "")
            .trim()
            .toLowerCase();

    if (!normalized) {
        throw createError(
            "Wallet service is required.",
            400
        );
    }

    if (normalized.length > 100) {
        throw createError(
            "Wallet service is too long.",
            400
        );
    }

    return normalized;
}


// =====================================================
// RESERVATION ID
// =====================================================

function requireReservationId(reservationId) {
    const normalized =
        String(reservationId || "").trim();

    if (!normalized) {
        throw createError(
            "Wallet reservation ID is required.",
            400
        );
    }

    if (normalized.length > 200) {
        throw createError(
            "Wallet reservation ID is too long.",
            400
        );
    }

    return normalized;
}


// =====================================================
// CREATE RESERVATION ID
// =====================================================

function createReservationId() {
    return (
        "NPRES_" +
        Date.now() +
        "_" +
        crypto.randomBytes(16).toString("hex")
    );
}


// =====================================================
// CREATE AUDIT ID
// =====================================================

function createAuditId() {
    return (
        "NPAUD_" +
        Date.now() +
        "_" +
        crypto.randomBytes(12).toString("hex")
    );
}


// =====================================================
// WALLET REFERENCE
// =====================================================

function getWalletRef(uid) {
    return db
        .collection(WALLETS_COLLECTION)
        .doc(requireUid(uid));
}


// =====================================================
// RESERVATION REFERENCE
// =====================================================

function getReservationRef(reservationId) {
    return db
        .collection(RESERVATIONS_COLLECTION)
        .doc(requireReservationId(reservationId));
}


// =====================================================
// READ INTEGER
// =====================================================

function readIntegerField(value, fieldName) {
    const number = Number(value);

    if (!Number.isSafeInteger(number)) {
        throw new Error(
            `Wallet field ${fieldName} is invalid.`
        );
    }

    return number;
}


// =====================================================
// READ WALLET
// =====================================================

function readWalletState(walletData) {
    if (
        !walletData ||
        typeof walletData !== "object"
    ) {
        throw new Error(
            "Wallet account is invalid."
        );
    }

    const balanceKobo =
        readIntegerField(
            walletData.balanceKobo,
            "balanceKobo"
        );

    const reservedKobo =
        walletData.reservedKobo === undefined ||
        walletData.reservedKobo === null
            ? 0
            : readIntegerField(
                walletData.reservedKobo,
                "reservedKobo"
            );

    if (balanceKobo < 0) {
        throw new Error(
            "Wallet balance cannot be negative."
        );
    }

    if (reservedKobo < 0) {
        throw new Error(
            "Reserved wallet balance cannot be negative."
        );
    }

    if (reservedKobo > balanceKobo) {
        throw new Error(
            "Wallet reservation state is inconsistent."
        );
    }

    return {
        balanceKobo,
        reservedKobo,
        availableKobo:
            balanceKobo - reservedKobo
    };
}


// =====================================================
// FIND EXISTING RESERVATION
// =====================================================
//
// Used for idempotency.
//
// Airtime service uses the NovaPay transaction ID as the
// reservation reference:
//
//   NPAIR_xxxxx
//
// Therefore the same purchase cannot create another
// reservation for the same reference.
// =====================================================

async function findReservationByReference({
    uid,
    reference
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedReference =
        requireReference(reference);

    const snapshot =
        await db
            .collection(RESERVATIONS_COLLECTION)
            .where("uid", "==", authenticatedUid)
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
        throw new Error(
            "Multiple wallet reservations exist for the same reference."
        );
    }

    const document = snapshot.docs[0];

    return {
        id: document.id,
        ...document.data()
    };
}


// =====================================================
// BUILD RESERVATION
// =====================================================

function buildReservationData({
    reservationId,
    uid,
    reference,
    amountKobo,
    currency,
    service,
    metadata,
    now,
    reservedBeforeKobo,
    reservedAfterKobo,
    availableBeforeKobo,
    availableAfterKobo
}) {
    return {
        id: reservationId,

        uid,

        reference,

        amountKobo,

        currency,

        service,

        status: STATUS_PENDING,

        reservedBeforeKobo,

        reservedAfterKobo,

        availableBeforeKobo,

        availableAfterKobo,

        metadata:
            metadata &&
            typeof metadata === "object"
                ? metadata
                : {},

        createdAt: now,

        updatedAt: now,

        committedAt: null,

        releasedAt: null,

        releaseReason: null,

        provider: null
    };
}


// =====================================================
// RESERVE FUNDS
// =====================================================

async function reserveFunds({
    uid,
    reference,
    amountKobo,
    currency = CURRENCY,
    service,
    metadata = {}
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedReference =
        requireReference(reference);

    const amount =
        validateAmountKobo(amountKobo);

    const normalizedCurrency =
        normalizeCurrency(currency);

    const normalizedService =
        normalizeService(service);

    const walletRef =
        getWalletRef(authenticatedUid);

    /*
     * First idempotency check.
     */

    const existing =
        await findReservationByReference({
            uid: authenticatedUid,
            reference: normalizedReference
        });

    if (existing) {
        if (
            Number(existing.amountKobo) !== amount
        ) {
            throw createError(
                "A wallet reservation already exists with a different amount.",
                409
            );
        }

        if (
            String(existing.currency || "")
                .toUpperCase() !==
            normalizedCurrency
        ) {
            throw createError(
                "A wallet reservation already exists with a different currency.",
                409
            );
        }

        if (
            existing.uid !==
            authenticatedUid
        ) {
            throw createError(
                "Wallet reservation does not belong to the authenticated user.",
                403
            );
        }

        return {
            reservationId: existing.id,

            reference: existing.reference,

            amountKobo: existing.amountKobo,

            currency: existing.currency,

            status:
                existing.status ||
                STATUS_PENDING,

            alreadyExists: true,

            balanceKobo: null,

            reservedKobo: null,

            availableKobo: null
        };
    }

    const reservationId =
        createReservationId();

    const reservationRef =
        getReservationRef(
            reservationId
        );

    const now = new Date();

    const result =
        await db.runTransaction(
            async transaction => {

                /*
                 * IMPORTANT:
                 *
                 * Wallet MUST already exist.
                 */

                const walletSnapshot =
                    await transaction.get(
                        walletRef
                    );

                if (!walletSnapshot.exists) {
                    throw createError(
                        "Wallet account not found.",
                        404
                    );
                }

                /*
                 * Check reservation document inside
                 * the transaction as well.
                 */

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
                            "Wallet reservation ownership mismatch.",
                            403
                        );
                    }

                    return {
                        alreadyExists: true,

                        reservationId,

                        reservation:
                            existingReservation,

                        wallet:
                            readWalletState(
                                walletSnapshot.data()
                            )
                    };
                }

                const wallet =
                    readWalletState(
                        walletSnapshot.data()
                    );

                /*
                 * Only AVAILABLE funds may be reserved.
                 */

                if (
                    wallet.availableKobo <
                    amount
                ) {
                    throw createError(
                        "Insufficient wallet balance.",
                        400
                    );
                }

                const reservedAfterKobo =
                    wallet.reservedKobo +
                    amount;

                const availableAfterKobo =
                    wallet.balanceKobo -
                    reservedAfterKobo;

                if (
                    reservedAfterKobo < 0 ||
                    reservedAfterKobo >
                        wallet.balanceKobo
                ) {
                    throw new Error(
                        "Wallet reservation would create an invalid reserved balance."
                    );
                }

                if (
                    availableAfterKobo < 0
                ) {
                    throw new Error(
                        "Wallet reservation would create a negative available balance."
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

                        metadata,

                        now,

                        reservedBeforeKobo:
                            wallet.reservedKobo,

                        reservedAfterKobo,

                        availableBeforeKobo:
                            wallet.availableKobo,

                        availableAfterKobo
                    });

                /*
                 * Only reservedKobo changes.
                 */

                transaction.update(
                    walletRef,
                    {
                        reservedKobo:
                            reservedAfterKobo,

                        updatedAt:
                            now
                    }
                );

                /*
                 * Create reservation.
                 */

                transaction.create(
                    reservationRef,
                    reservation
                );

                /*
                 * Create audit record.
                 */

                const auditRef =
                    reservationRef
                        .collection("audit")
                        .doc(
                            createAuditId()
                        );

                transaction.create(
                    auditRef,
                    {
                        id: auditRef.id,

                        reservationId,

                        uid:
                            authenticatedUid,

                        action:
                            "reserved",

                        amountKobo:
                            amount,

                        balanceBeforeKobo:
                            wallet.balanceKobo,

                        balanceAfterKobo:
                            wallet.balanceKobo,

                        reservedBeforeKobo:
                            wallet.reservedKobo,

                        reservedAfterKobo,

                        availableBeforeKobo:
                            wallet.availableKobo,

                        availableAfterKobo,

                        reference:
                            normalizedReference,

                        service:
                            normalizedService,

                        createdAt:
                            now
                    }
                );

                return {
                    alreadyExists: false,

                    reservationId,

                    reservation,

                    wallet: {
                        balanceKobo:
                            wallet.balanceKobo,

                        reservedKobo:
                            reservedAfterKobo,

                        availableKobo:
                            availableAfterKobo
                    }
                };
            }
        );

    return {
        reservationId:
            result.reservationId,

        reference:
            normalizedReference,

        amountKobo:
            amount,

        currency:
            normalizedCurrency,

        status:
            result.reservation?.status ||
            STATUS_PENDING,

        alreadyExists:
            result.alreadyExists,

        balanceKobo:
            result.wallet?.balanceKobo ??
            null,

        reservedKobo:
            result.wallet?.reservedKobo ??
            null,

        availableKobo:
            result.wallet?.availableKobo ??
            null
    };
}


// =====================================================
// GET RESERVATION
// =====================================================

async function getReservation({
    uid,
    reservationId
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedId =
        requireReservationId(
            reservationId
        );

    const snapshot =
        await getReservationRef(
            normalizedId
        ).get();

    if (!snapshot.exists) {
        return null;
    }

    const reservation =
        snapshot.data();

    if (
        reservation.uid !==
        authenticatedUid
    ) {
        throw createError(
            "Wallet reservation not found.",
            404
        );
    }

    return {
        id: snapshot.id,
        ...reservation
    };
}


// =====================================================
// COMMIT RESERVATION
// =====================================================
//
// Called by Airtime service ONLY after explicit provider
// success.
//
// Financial effect:
//
// balanceKobo   ↓
// reservedKobo ↓
//
// availableKobo remains mathematically correct.
// =====================================================

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

    const walletRef =
        getWalletRef(authenticatedUid);

    const reservationRef =
        getReservationRef(
            normalizedReservationId
        );

    /*
     * Ledger document uses the reservation ID.
     *
     * This gives every committed reservation one
     * deterministic ledger record and prevents a
     * successful retry from creating another ledger
     * document.
     */
    const ledgerRef =
        walletRef
            .collection("ledger")
            .doc(normalizedReservationId);

    const now = new Date();

    const result =
        await db.runTransaction(
            async transaction => {

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
                        "Wallet reservation not found.",
                        404
                    );
                }

                const reservation =
                    reservationSnapshot.data();

                if (
                    reservation.uid !==
                    authenticatedUid
                ) {
                    throw createError(
                        "Wallet reservation does not belong to the authenticated user.",
                        403
                    );
                }

                /*
                 * Idempotent commit.
                 */

                if (
                    reservation.status ===
                    STATUS_COMMITTED
                ) {
                    return {
                        committed: true,

                        alreadyCommitted: true,

                        reservation
                    };
                }

                /*
                 * Released is terminal.
                 */

                if (
                    reservation.status ===
                    STATUS_RELEASED
                ) {
                    throw createError(
                        "A released wallet reservation cannot be committed.",
                        409
                    );
                }

                if (
                    reservation.status !==
                    STATUS_PENDING
                ) {
                    throw createError(
                        "Wallet reservation is in an invalid state.",
                        409
                    );
                }

                if (
                    !walletSnapshot.exists
                ) {
                    throw createError(
                        "Wallet account not found.",
                        404
                    );
                }

                const wallet =
                    readWalletState(
                        walletSnapshot.data()
                    );

                const amount =
                    validateAmountKobo(
                        reservation.amountKobo
                    );

                /*
                 * Reserved money must exist.
                 */

                if (
                    wallet.reservedKobo <
                    amount
                ) {
                    throw new Error(
                        "Wallet reserved balance is inconsistent with the reservation."
                    );
                }

                if (
                    wallet.balanceKobo <
                    amount
                ) {
                    throw new Error(
                        "Wallet balance is inconsistent with the reservation."
                    );
                }

                const newBalanceKobo =
                    wallet.balanceKobo -
                    amount;

                const newReservedKobo =
                    wallet.reservedKobo -
                    amount;

                if (
                    newBalanceKobo < 0
                ) {
                    throw new Error(
                        "Wallet commit would create a negative balance."
                    );
                }

                if (
                    newReservedKobo < 0
                ) {
                    throw new Error(
                        "Wallet commit would create a negative reserved balance."
                    );
                }

                const newAvailableKobo =
                    newBalanceKobo -
                    newReservedKobo;

                if (
                    newAvailableKobo < 0
                ) {
                    throw new Error(
                        "Wallet commit would create a negative available balance."
                    );
                }

                const normalizedProvider =
                    provider === null ||
                    provider === undefined
                        ? null
                        : String(provider)
                            .trim()
                            .slice(0, 100);

                const commitUpdate = {
                    status:
                        STATUS_COMMITTED,

                    committedAt:
                        now,

                    updatedAt:
                        now,

                    provider:
                        normalizedProvider
                };

                /*
                 * Permanently debit the wallet.
                 */

                transaction.update(
                    walletRef,
                    {
                        balanceKobo:
                            newBalanceKobo,

                        reservedKobo:
                            newReservedKobo,

                        updatedAt:
                            now
                    }
                );

                /*
                 * Mark reservation committed.
                 */

                transaction.update(
                    reservationRef,
                    commitUpdate
                );

                /*
                 * =================================================
                 * NOVAPAY LEDGER ENTRY
                 * =================================================
                 *
                 * This is the important fix.
                 *
                 * The ledger entry is created inside the SAME
                 * Firestore transaction as the wallet debit.
                 *
                 * Therefore:
                 *
                 *   wallet debit succeeds
                 *          +
                 *   ledger entry succeeds
                 *
                 * or neither is committed.
                 *
                 * The existing Transaction History route reads:
                 *
                 *   wallets/{uid}/ledger
                 *
                 * so this is the missing record.
                 */

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

                        createdAt:
                            now,
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

                /*
                 * Audit.
                 */

                const auditRef =
                    reservationRef
                        .collection("audit")
                        .doc(
                            createAuditId()
                        );

                transaction.create(
                    auditRef,
                    {
                        id: auditRef.id,

                        reservationId:
                            normalizedReservationId,

                        uid:
                            authenticatedUid,

                        action:
                            "committed",

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

                        createdAt:
                            now
                    }
                );

                return {
                    committed: true,

                    alreadyCommitted: false,

                    reservation: {
                        ...reservation,
                        ...commitUpdate
                    }
                };
            }
        );

    return {
        committed:
            result.committed,

        alreadyCommitted:
            result.alreadyCommitted,

        reservationId:
            normalizedReservationId,

        status:
            STATUS_COMMITTED
    };
}


// =====================================================
// RELEASE RESERVATION
// =====================================================
//
// Called by Airtime service ONLY after explicit provider
// failure.
//
// Financial effect:
//
// balanceKobo   unchanged
// reservedKobo ↓
//
// Therefore availableKobo increases again.
// =====================================================

async function releaseReservation({
    uid,
    reservationId,
    reason = "wallet_reservation_released"
}) {
    const authenticatedUid =
        requireUid(uid);

    const normalizedReservationId =
        requireReservationId(
            reservationId
        );

    const normalizedReason =
        String(
            reason ||
            "wallet_reservation_released"
        )
            .trim()
            .slice(0, 300);

    const walletRef =
        getWalletRef(authenticatedUid);

    const reservationRef =
        getReservationRef(
            normalizedReservationId
        );

    const now = new Date();

    const result =
        await db.runTransaction(
            async transaction => {

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
                        "Wallet reservation not found.",
                        404
                    );
                }

                const reservation =
                    reservationSnapshot.data();

                if (
                    reservation.uid !==
                    authenticatedUid
                ) {
                    throw createError(
                        "Wallet reservation does not belong to the authenticated user.",
                        403
                    );
                }

                /*
                 * Idempotent release.
                 */

                if (
                    reservation.status ===
                    STATUS_RELEASED
                ) {
                    return {
                        released: true,

                        alreadyReleased: true,

                        reservation
                    };
                }

                /*
                 * Committed reservations are terminal.
                 */

                if (
                    reservation.status ===
                    STATUS_COMMITTED
                ) {
                    throw createError(
                        "A committed wallet reservation cannot be released.",
                        409
                    );
                }

                if (
                    reservation.status !==
                    STATUS_PENDING
                ) {
                    throw createError(
                        "Wallet reservation is in an invalid state.",
                        409
                    );
                }

                if (
                    !walletSnapshot.exists
                ) {
                    throw createError(
                        "Wallet account not found.",
                        404
                    );
                }

                const wallet =
                    readWalletState(
                        walletSnapshot.data()
                    );

                const amount =
                    validateAmountKobo(
                        reservation.amountKobo
                    );

                if (
                    wallet.reservedKobo <
                    amount
                ) {
                    throw new Error(
                        "Wallet reserved balance is inconsistent with the reservation."
                    );
                }

                const newReservedKobo =
                    wallet.reservedKobo -
                    amount;

                if (
                    newReservedKobo < 0
                ) {
                    throw new Error(
                        "Wallet release would create a negative reserved balance."
                    );
                }

                const newAvailableKobo =
                    wallet.balanceKobo -
                    newReservedKobo;

                if (
                    newAvailableKobo < 0
                ) {
                    throw new Error(
                        "Wallet release would create a negative available balance."
                    );
                }

                const releaseUpdate = {
                    status:
                        STATUS_RELEASED,

                    releasedAt:
                        now,

                    updatedAt:
                        now,

                    releaseReason:
                        normalizedReason
                };

                /*
                 * Balance stays unchanged.
                 */

                transaction.update(
                    walletRef,
                    {
                        reservedKobo:
                            newReservedKobo,

                        updatedAt:
                            now
                    }
                );

                /*
                 * Mark reservation released.
                 */

                transaction.update(
                    reservationRef,
                    releaseUpdate
                );

                /*
                 * Audit.
                 */

                const auditRef =
                    reservationRef
                        .collection("audit")
                        .doc(
                            createAuditId()
                        );

                transaction.create(
                    auditRef,
                    {
                        id: auditRef.id,

                        reservationId:
                            normalizedReservationId,

                        uid:
                            authenticatedUid,

                        action:
                            "released",

                        amountKobo:
                            amount,

                        balanceBeforeKobo:
                            wallet.balanceKobo,

                        balanceAfterKobo:
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

                        createdAt:
                            now
                    }
                );

                return {
                    released: true,

                    alreadyReleased: false,

                    reservation: {
                        ...reservation,
                        ...releaseUpdate
                    }
                };
            }
        );

    return {
        released:
            result.released,

        alreadyReleased:
            result.alreadyReleased,

        reservationId:
            normalizedReservationId,

        status:
            STATUS_RELEASED
    };
}


// =====================================================
// GET WALLET BALANCE
// =====================================================

async function getWalletBalance(uid) {
    const authenticatedUid =
        requireUid(uid);

    const walletRef =
        getWalletRef(
            authenticatedUid
        );

    const snapshot =
        await walletRef.get();

    if (!snapshot.exists) {
        throw createError(
            "Wallet account not found.",
            404
        );
    }

    const wallet =
        readWalletState(
            snapshot.data()
        );

    return {
        balanceKobo:
            wallet.balanceKobo,

        reservedKobo:
            wallet.reservedKobo,

        availableKobo:
            wallet.availableKobo,

        currency:
            CURRENCY
    };
}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {
    reserveFunds,

    commitReservation,

    releaseReservation,

    getReservation,

    getWalletBalance
};