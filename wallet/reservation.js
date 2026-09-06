"use strict";

const crypto = require("crypto");
const { db } = require("../firebase-admin");

const WALLETS_COLLECTION = "wallets";
const RESERVATIONS_COLLECTION = "walletReservations";
const LEDGER_SUBCOLLECTION = "ledger";
const AUDIT_SUBCOLLECTION = "audit";

const CURRENCY_NGN = "NGN";

const RESERVATION_PENDING = "pending";
const RESERVATION_COMMITTED = "committed";
const RESERVATION_RELEASED = "released";

const DEFAULT_MAX_RESERVATION_KOBO = 5_000_000;

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getMaxReservationKobo() {
  const raw = process.env.MAX_WALLET_RESERVATION_KOBO;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_MAX_RESERVATION_KOBO;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createError(
      "MAX_WALLET_RESERVATION_KOBO must be a positive safe integer.",
      "INVALID_RESERVATION_LIMIT"
    );
  }

  return value;
}

function assertUid(uid) {
  const value = String(uid || "").trim();

  if (!value || value.length > 200) {
    throw createError("Invalid user ID.", "INVALID_UID");
  }

  return value;
}

function assertReference(reference) {
  const value = String(reference || "").trim();

  if (!value || value.length > 150) {
    throw createError(
      "Invalid transaction reference.",
      "INVALID_REFERENCE"
    );
  }

  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw createError(
      "Invalid transaction reference.",
      "INVALID_REFERENCE"
    );
  }

  return value;
}

function assertAmountKobo(amountKobo) {
  const value = Number(amountKobo);
  const maxReservationKobo = getMaxReservationKobo();

  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maxReservationKobo
  ) {
    throw createError(
      "Invalid reservation amount.",
      "INVALID_RESERVATION_AMOUNT"
    );
  }

  return value;
}

function assertCurrency(currency) {
  const value = String(currency || "").trim().toUpperCase();

  if (value !== CURRENCY_NGN) {
    throw createError(
      "Unsupported wallet currency.",
      "UNSUPPORTED_CURRENCY"
    );
  }

  return value;
}

function assertService(service) {
  const value = String(service || "").trim().toLowerCase();

  if (!value || value.length > 50) {
    throw createError(
      "Invalid wallet service.",
      "INVALID_SERVICE"
    );
  }

  if (!/^[a-z0-9._:-]+$/.test(value)) {
    throw createError(
      "Invalid wallet service.",
      "INVALID_SERVICE"
    );
  }

  return value;
}

function assertReservationId(reservationId) {
  const value = String(reservationId || "").trim();

  if (!/^NPRES_[a-f0-9]{64}$/.test(value)) {
    throw createError(
      "Invalid reservation ID.",
      "INVALID_RESERVATION_ID"
    );
  }

  return value;
}

function createReservationId(uid, reference) {
  const hash = crypto
    .createHash("sha256")
    .update(`${uid}:${reference}`)
    .digest("hex");

  return `NPRES_${hash}`;
}

function createAuditId() {
  return `AUD_${crypto.randomBytes(18).toString("hex")}`;
}

function walletRef(uid) {
  return db.collection(WALLETS_COLLECTION).doc(uid);
}

function reservationRef(reservationId) {
  return db
    .collection(RESERVATIONS_COLLECTION)
    .doc(reservationId);
}

function ledgerRef(uid, reservationId) {
  return walletRef(uid)
    .collection(LEDGER_SUBCOLLECTION)
    .doc(reservationId);
}

function auditRef(reservationId) {
  return reservationRef(reservationId)
    .collection(AUDIT_SUBCOLLECTION)
    .doc(createAuditId());
}

function validateWalletState(wallet) {
  const balanceKobo = Number(wallet?.balanceKobo);
  const reservedKobo = Number(wallet?.reservedKobo);

  if (
    !Number.isSafeInteger(balanceKobo) ||
    balanceKobo < 0 ||
    !Number.isSafeInteger(reservedKobo) ||
    reservedKobo < 0 ||
    reservedKobo > balanceKobo
  ) {
    throw createError(
      "Wallet state is invalid.",
      "INVALID_WALLET_STATE"
    );
  }

  return {
    balanceKobo,
    reservedKobo,
    availableKobo: balanceKobo - reservedKobo,
  };
}

function validateReservationShape(
  reservation,
  {
    uid = null,
    reference = null,
    service = null,
    currency = null,
    amountKobo = null,
  } = {}
) {
  if (!reservation) {
    throw createError(
      "Reservation not found.",
      "RESERVATION_NOT_FOUND"
    );
  }

  if (uid !== null && reservation.uid !== uid) {
    throw createError(
      "Reservation ownership mismatch.",
      "RESERVATION_OWNERSHIP_MISMATCH"
    );
  }

  if (
    reference !== null &&
    String(reservation.reference || "") !== reference
  ) {
    throw createError(
      "Reservation reference mismatch.",
      "RESERVATION_REFERENCE_MISMATCH"
    );
  }

  if (
    service !== null &&
    String(reservation.service || "").toLowerCase() !== service
  ) {
    throw createError(
      "Reservation service mismatch.",
      "RESERVATION_SERVICE_MISMATCH"
    );
  }

  if (
    currency !== null &&
    String(reservation.currency || "").toUpperCase() !== currency
  ) {
    throw createError(
      "Reservation currency mismatch.",
      "RESERVATION_CURRENCY_MISMATCH"
    );
  }

  if (
    amountKobo !== null &&
    Number(reservation.amountKobo) !== amountKobo
  ) {
    throw createError(
      "Reservation amount mismatch.",
      "RESERVATION_AMOUNT_MISMATCH"
    );
  }

  if (!reservation.uid || !reservation.reference || !reservation.service) {
    throw createError(
      "Reservation data is incomplete.",
      "INVALID_RESERVATION_DATA"
    );
  }

  const reservationCurrency = String(
    reservation.currency || ""
  )
    .trim()
    .toUpperCase();

  if (reservationCurrency !== CURRENCY_NGN) {
    throw createError(
      "Reservation currency is invalid.",
      "INVALID_RESERVATION_CURRENCY"
    );
  }

  const reservationAmount = Number(reservation.amountKobo);

  if (
    !Number.isSafeInteger(reservationAmount) ||
    reservationAmount <= 0
  ) {
    throw createError(
      "Reservation amount is invalid.",
      "INVALID_RESERVATION_AMOUNT"
    );
  }

  if (
    ![
      RESERVATION_PENDING,
      RESERVATION_COMMITTED,
      RESERVATION_RELEASED,
    ].includes(reservation.status)
  ) {
    throw createError(
      "Reservation status is invalid.",
      "INVALID_RESERVATION_STATE"
    );
  }

  return reservation;
}

function buildReservationSnapshot(document) {
  return {
    id: document.id,
    ...document.data(),
  };
}

async function reserveFunds({
  uid,
  amountKobo,
  currency = CURRENCY_NGN,
  service,
  reference,
}) {
  const normalizedUid = assertUid(uid);
  const normalizedAmountKobo = assertAmountKobo(amountKobo);
  const normalizedCurrency = assertCurrency(currency);
  const normalizedService = assertService(service);
  const normalizedReference = assertReference(reference);

  const reservationId = createReservationId(
    normalizedUid,
    normalizedReference
  );

  assertReservationId(reservationId);

  const walletDocument = walletRef(normalizedUid);
  const reservationDocument = reservationRef(reservationId);

  return db.runTransaction(async (transaction) => {
    const walletSnapshot = await transaction.get(walletDocument);
    const reservationSnapshot = await transaction.get(
      reservationDocument
    );

    if (reservationSnapshot.exists) {
      const existingReservation =
        buildReservationSnapshot(reservationSnapshot);

      validateReservationShape(existingReservation, {
        uid: normalizedUid,
        reference: normalizedReference,
        service: normalizedService,
        currency: normalizedCurrency,
        amountKobo: normalizedAmountKobo,
      });

      return existingReservation;
    }

    if (!walletSnapshot.exists) {
      throw createError(
        "Wallet not found.",
        "WALLET_NOT_FOUND"
      );
    }

    const walletState = validateWalletState(
      walletSnapshot.data()
    );

    if (walletState.availableKobo < normalizedAmountKobo) {
      throw createError(
        "Insufficient wallet balance.",
        "INSUFFICIENT_WALLET_BALANCE"
      );
    }

    const now = new Date().toISOString();

    const reservedAfterKobo =
      walletState.reservedKobo + normalizedAmountKobo;

    const availableAfterKobo =
      walletState.balanceKobo - reservedAfterKobo;

    const reservation = {
      id: reservationId,
      uid: normalizedUid,
      reference: normalizedReference,
      service: normalizedService,
      currency: normalizedCurrency,
      amountKobo: normalizedAmountKobo,
      status: RESERVATION_PENDING,

      createdAt: now,
      updatedAt: now,

      walletBalanceBeforeKobo:
        walletState.balanceKobo,
      walletReservedBeforeKobo:
        walletState.reservedKobo,
      walletAvailableBeforeKobo:
        walletState.availableKobo,

      walletBalanceAfterKobo:
        walletState.balanceKobo,
      walletReservedAfterKobo:
        reservedAfterKobo,
      walletAvailableAfterKobo:
        availableAfterKobo,
    };

    transaction.update(walletDocument, {
      reservedKobo: reservedAfterKobo,
      updatedAt: now,
    });

    transaction.create(
      reservationDocument,
      reservation
    );

    transaction.create(
      auditRef(reservationId),
      {
        event: "reservation_created",
        reservationId,
        uid: normalizedUid,
        reference: normalizedReference,
        service: normalizedService,
        currency: normalizedCurrency,
        amountKobo: normalizedAmountKobo,
        status: RESERVATION_PENDING,

        balanceKobo: walletState.balanceKobo,
        reservedKobo: reservedAfterKobo,
        availableKobo: availableAfterKobo,

        createdAt: now,
      }
    );

    return reservation;
  });
}

async function getReservation(reservationId) {
  const normalizedReservationId =
    assertReservationId(reservationId);

  const snapshot = await reservationRef(
    normalizedReservationId
  ).get();

  if (!snapshot.exists) {
    throw createError(
      "Reservation not found.",
      "RESERVATION_NOT_FOUND"
    );
  }

  const reservation =
    buildReservationSnapshot(snapshot);

  return validateReservationShape(reservation);
}

async function commitReservation({
  uid,
  reservationId,
}) {
  const normalizedUid = assertUid(uid);
  const normalizedReservationId =
    assertReservationId(reservationId);

  const walletDocument = walletRef(normalizedUid);
  const reservationDocument = reservationRef(
    normalizedReservationId
  );

  return db.runTransaction(async (transaction) => {
    const walletSnapshot = await transaction.get(
      walletDocument
    );

    const reservationSnapshot =
      await transaction.get(reservationDocument);

    if (!walletSnapshot.exists) {
      throw createError(
        "Wallet not found.",
        "WALLET_NOT_FOUND"
      );
    }

    if (!reservationSnapshot.exists) {
      throw createError(
        "Reservation not found.",
        "RESERVATION_NOT_FOUND"
      );
    }

    const reservation =
      buildReservationSnapshot(reservationSnapshot);

    validateReservationShape(reservation, {
      uid: normalizedUid,
    });

    if (reservation.status === RESERVATION_COMMITTED) {
      return reservation;
    }

    if (reservation.status === RESERVATION_RELEASED) {
      throw createError(
        "Released reservation cannot be committed.",
        "RESERVATION_ALREADY_RELEASED"
      );
    }

    if (reservation.status !== RESERVATION_PENDING) {
      throw createError(
        "Reservation is not in a committable state.",
        "INVALID_RESERVATION_STATE"
      );
    }

    const amountKobo =
      assertAmountKobo(reservation.amountKobo);

    const walletState = validateWalletState(
      walletSnapshot.data()
    );

    if (walletState.reservedKobo < amountKobo) {
      throw createError(
        "Reserved wallet balance is insufficient.",
        "INSUFFICIENT_RESERVED_BALANCE"
      );
    }

    if (walletState.balanceKobo < amountKobo) {
      throw createError(
        "Wallet balance is insufficient for commitment.",
        "INSUFFICIENT_WALLET_BALANCE"
      );
    }

    const balanceAfterKobo =
      walletState.balanceKobo - amountKobo;

    const reservedAfterKobo =
      walletState.reservedKobo - amountKobo;

    const availableAfterKobo =
      balanceAfterKobo - reservedAfterKobo;

    const now = new Date().toISOString();

    const updatedReservation = {
      ...reservation,
      status: RESERVATION_COMMITTED,
      updatedAt: now,
      committedAt: now,

      walletBalanceBeforeKobo:
        walletState.balanceKobo,
      walletReservedBeforeKobo:
        walletState.reservedKobo,
      walletAvailableBeforeKobo:
        walletState.availableKobo,

      walletBalanceAfterKobo:
        balanceAfterKobo,
      walletReservedAfterKobo:
        reservedAfterKobo,
      walletAvailableAfterKobo:
        availableAfterKobo,
    };

    transaction.update(walletDocument, {
      balanceKobo: balanceAfterKobo,
      reservedKobo: reservedAfterKobo,
      updatedAt: now,
    });

    transaction.update(
      reservationDocument,
      updatedReservation
    );

    transaction.set(
      ledgerRef(
        normalizedUid,
        normalizedReservationId
      ),
      {
        reservationId: normalizedReservationId,
        uid: normalizedUid,
        reference: reservation.reference,

        service: reservation.service,
        type: reservation.service,

        status: "successful",
        direction: "debit",
        currency: reservation.currency,
        amountKobo,

        balanceBeforeKobo:
          walletState.balanceKobo,
        balanceAfterKobo:
          balanceAfterKobo,

        reservedBeforeKobo:
          walletState.reservedKobo,
        reservedAfterKobo:
          reservedAfterKobo,

        availableBeforeKobo:
          walletState.availableKobo,
        availableAfterKobo:
          availableAfterKobo,

        provider: reservation.provider || null,

        createdAt:
          reservation.createdAt || now,
        updatedAt: now,
        completedAt: now,
      },
      { merge: true }
    );

    transaction.create(
      auditRef(normalizedReservationId),
      {
        event: "reservation_committed",
        reservationId: normalizedReservationId,
        uid: normalizedUid,
        reference: reservation.reference,
        service: reservation.service,
        currency: reservation.currency,
        amountKobo,

        status: RESERVATION_COMMITTED,

        balanceBeforeKobo:
          walletState.balanceKobo,
        balanceAfterKobo:
          balanceAfterKobo,

        reservedBeforeKobo:
          walletState.reservedKobo,
        reservedAfterKobo:
          reservedAfterKobo,

        availableBeforeKobo:
          walletState.availableKobo,
        availableAfterKobo:
          availableAfterKobo,

        createdAt: now,
      }
    );

    return updatedReservation;
  });
}

async function releaseReservation({
  uid,
  reservationId,
}) {
  const normalizedUid = assertUid(uid);
  const normalizedReservationId =
    assertReservationId(reservationId);

  const walletDocument = walletRef(normalizedUid);
  const reservationDocument = reservationRef(
    normalizedReservationId
  );

  return db.runTransaction(async (transaction) => {
    const walletSnapshot = await transaction.get(
      walletDocument
    );

    const reservationSnapshot =
      await transaction.get(reservationDocument);

    if (!walletSnapshot.exists) {
      throw createError(
        "Wallet not found.",
        "WALLET_NOT_FOUND"
      );
    }

    if (!reservationSnapshot.exists) {
      throw createError(
        "Reservation not found.",
        "RESERVATION_NOT_FOUND"
      );
    }

    const reservation =
      buildReservationSnapshot(reservationSnapshot);

    validateReservationShape(reservation, {
      uid: normalizedUid,
    });

    if (reservation.status === RESERVATION_RELEASED) {
      return reservation;
    }

    if (reservation.status === RESERVATION_COMMITTED) {
      throw createError(
        "Committed reservation cannot be released.",
        "RESERVATION_ALREADY_COMMITTED"
      );
    }

    if (reservation.status !== RESERVATION_PENDING) {
      throw createError(
        "Reservation is not in a releasable state.",
        "INVALID_RESERVATION_STATE"
      );
    }

    const amountKobo =
      assertAmountKobo(reservation.amountKobo);

    const walletState = validateWalletState(
      walletSnapshot.data()
    );

    if (walletState.reservedKobo < amountKobo) {
      throw createError(
        "Reserved wallet balance is insufficient for release.",
        "INSUFFICIENT_RESERVED_BALANCE"
      );
    }

    const balanceAfterKobo =
      walletState.balanceKobo;

    const reservedAfterKobo =
      walletState.reservedKobo - amountKobo;

    const availableAfterKobo =
      balanceAfterKobo - reservedAfterKobo;

    const now = new Date().toISOString();

    const updatedReservation = {
      ...reservation,
      status: RESERVATION_RELEASED,
      updatedAt: now,
      releasedAt: now,

      walletBalanceBeforeKobo:
        walletState.balanceKobo,
      walletReservedBeforeKobo:
        walletState.reservedKobo,
      walletAvailableBeforeKobo:
        walletState.availableKobo,

      walletBalanceAfterKobo:
        balanceAfterKobo,
      walletReservedAfterKobo:
        reservedAfterKobo,
      walletAvailableAfterKobo:
        availableAfterKobo,
    };

    transaction.update(walletDocument, {
      reservedKobo: reservedAfterKobo,
      updatedAt: now,
    });

    transaction.update(
      reservationDocument,
      updatedReservation
    );

    transaction.create(
      auditRef(normalizedReservationId),
      {
        event: "reservation_released",
        reservationId: normalizedReservationId,
        uid: normalizedUid,
        reference: reservation.reference,
        service: reservation.service,
        currency: reservation.currency,
        amountKobo,

        status: RESERVATION_RELEASED,

        balanceBeforeKobo:
          walletState.balanceKobo,
        balanceAfterKobo:
          balanceAfterKobo,

        reservedBeforeKobo:
          walletState.reservedKobo,
        reservedAfterKobo:
          reservedAfterKobo,

        availableBeforeKobo:
          walletState.availableKobo,
        availableAfterKobo:
          availableAfterKobo,

        createdAt: now,
      }
    );

    return updatedReservation;
  });
}

async function getWalletBalance(uid) {
  const normalizedUid = assertUid(uid);

  const snapshot =
    await walletRef(normalizedUid).get();

  if (!snapshot.exists) {
    throw createError(
      "Wallet not found.",
      "WALLET_NOT_FOUND"
    );
  }

  const wallet = snapshot.data();
  const walletState =
    validateWalletState(wallet);

  return {
    balanceKobo: walletState.balanceKobo,
    reservedKobo: walletState.reservedKobo,
    availableKobo: walletState.availableKobo,
    currency: String(
      wallet.currency || CURRENCY_NGN
    )
      .trim()
      .toUpperCase(),
  };
}

module.exports = {
  reserveFunds,
  getReservation,
  commitReservation,
  releaseReservation,
  getWalletBalance,
};