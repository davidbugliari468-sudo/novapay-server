"use strict";

const crypto = require("crypto");
const { db } = require("../firebase-admin");

const WALLETS_COLLECTION = "wallets";
const RESERVATIONS_COLLECTION = "walletReservations";

const CURRENCY_NGN = "NGN";

const RESERVATION_PENDING = "pending";
const RESERVATION_COMMITTED = "committed";
const RESERVATION_RELEASED = "released";

const DEFAULT_MAX_RESERVATION_KOBO = 5_000_000;

function getMaxReservationKobo() {
  const raw = process.env.MAX_WALLET_RESERVATION_KOBO;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_MAX_RESERVATION_KOBO;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error(
      "MAX_WALLET_RESERVATION_KOBO must be a positive safe integer."
    );
    error.code = "INVALID_RESERVATION_LIMIT";
    throw error;
  }

  return value;
}

function assertUid(uid) {
  const value = String(uid || "").trim();

  if (!value || value.length > 200) {
    const error = new Error("Invalid user ID.");
    error.code = "INVALID_UID";
    throw error;
  }

  return value;
}

function assertReference(reference) {
  const value = String(reference || "").trim();

  if (!value || value.length > 150) {
    const error = new Error("Invalid transaction reference.");
    error.code = "INVALID_REFERENCE";
    throw error;
  }

  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    const error = new Error("Invalid transaction reference.");
    error.code = "INVALID_REFERENCE";
    throw error;
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
    const error = new Error("Invalid reservation amount.");
    error.code = "INVALID_RESERVATION_AMOUNT";
    throw error;
  }

  return value;
}

function assertCurrency(currency) {
  const value = String(currency || "").trim().toUpperCase();

  if (value !== CURRENCY_NGN) {
    const error = new Error("Unsupported wallet currency.");
    error.code = "UNSUPPORTED_CURRENCY";
    throw error;
  }

  return value;
}

function assertService(service) {
  const value = String(service || "").trim().toLowerCase();

  if (!value || value.length > 50) {
    const error = new Error("Invalid wallet service.");
    error.code = "INVALID_SERVICE";
    throw error;
  }

  if (!/^[a-z0-9._:-]+$/.test(value)) {
    const error = new Error("Invalid wallet service.");
    error.code = "INVALID_SERVICE";
    throw error;
  }

  return value;
}

function assertReservationId(reservationId) {
  const value = String(reservationId || "").trim();

  if (!/^NPRES_[a-f0-9]{64}$/.test(value)) {
    const error = new Error("Invalid reservation ID.");
    error.code = "INVALID_RESERVATION_ID";
    throw error;
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
    .collection("ledger")
    .doc(reservationId);
}

function auditRef(reservationId) {
  return reservationRef(reservationId)
    .collection("audit")
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
    const error = new Error("Wallet state is invalid.");
    error.code = "INVALID_WALLET_STATE";
    throw error;
  }

  return {
    balanceKobo,
    reservedKobo,
    availableKobo: balanceKobo - reservedKobo,
  };
}

function validateReservationAmount(reservation, amountKobo) {
  if (Number(reservation.amountKobo) !== amountKobo) {
    const error = new Error("Reservation amount mismatch.");
    error.code = "RESERVATION_AMOUNT_MISMATCH";
    throw error;
  }
}

function validateReservationOwnership(
  reservation,
  uid,
  reference = null,
  service = null
) {
  if (!reservation) {
    const error = new Error("Reservation not found.");
    error.code = "RESERVATION_NOT_FOUND";
    throw error;
  }

  if (reservation.uid !== uid) {
    const error = new Error("Reservation ownership mismatch.");
    error.code = "RESERVATION_OWNERSHIP_MISMATCH";
    throw error;
  }

  if (
    reference !== null &&
    String(reservation.reference || "") !== reference
  ) {
    const error = new Error("Reservation reference mismatch.");
    error.code = "RESERVATION_REFERENCE_MISMATCH";
    throw error;
  }

  if (
    service !== null &&
    String(reservation.service || "").toLowerCase() !== service
  ) {
    const error = new Error("Reservation service mismatch.");
    error.code = "RESERVATION_SERVICE_MISMATCH";
    throw error;
  }
}

async function findReservationByReference(uid, reference) {
  const snapshot = await db
    .collection(RESERVATIONS_COLLECTION)
    .where("uid", "==", uid)
    .where("reference", "==", reference)
    .limit(2)
    .get();

  if (snapshot.empty) {
    return null;
  }

  if (snapshot.size > 1) {
    const error = new Error(
      "Multiple reservations exist for this transaction reference."
    );
    error.code = "DUPLICATE_RESERVATIONS";
    throw error;
  }

  const document = snapshot.docs[0];

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

  const existing = await findReservationByReference(
    normalizedUid,
    normalizedReference
  );

  if (existing) {
    validateReservationOwnership(
      existing,
      normalizedUid,
      normalizedReference,
      normalizedService
    );

    validateReservationAmount(existing, normalizedAmountKobo);

    if (
      String(existing.currency || "").toUpperCase() !==
      normalizedCurrency
    ) {
      const error = new Error("Reservation currency mismatch.");
      error.code = "RESERVATION_CURRENCY_MISMATCH";
      throw error;
    }

    return existing;
  }

  const reservationId = createReservationId(
    normalizedUid,
    normalizedReference
  );

  const walletDocument = walletRef(normalizedUid);
  const reservationDocument = reservationRef(reservationId);

  const result = await db.runTransaction(async (transaction) => {
    const walletSnapshot = await transaction.get(walletDocument);
    const reservationSnapshot = await transaction.get(
      reservationDocument
    );

    if (reservationSnapshot.exists) {
      const existingReservation = {
        id: reservationSnapshot.id,
        ...reservationSnapshot.data(),
      };

      validateReservationOwnership(
        existingReservation,
        normalizedUid,
        normalizedReference,
        normalizedService
      );

      validateReservationAmount(
        existingReservation,
        normalizedAmountKobo
      );

      if (
        String(existingReservation.currency || "").toUpperCase() !==
        normalizedCurrency
      ) {
        const error = new Error("Reservation currency mismatch.");
        error.code = "RESERVATION_CURRENCY_MISMATCH";
        throw error;
      }

      return existingReservation;
    }

    if (!walletSnapshot.exists) {
      const error = new Error("Wallet not found.");
      error.code = "WALLET_NOT_FOUND";
      throw error;
    }

    const wallet = walletSnapshot.data();
    const walletState = validateWalletState(wallet);

    if (walletState.availableKobo < normalizedAmountKobo) {
      const error = new Error("Insufficient wallet balance.");
      error.code = "INSUFFICIENT_WALLET_BALANCE";
      throw error;
    }

    const now = new Date().toISOString();

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
      walletBalanceBeforeKobo: walletState.balanceKobo,
      walletReservedBeforeKobo: walletState.reservedKobo,
      walletAvailableBeforeKobo: walletState.availableKobo,
      walletBalanceAfterKobo: walletState.balanceKobo,
      walletReservedAfterKobo:
        walletState.reservedKobo + normalizedAmountKobo,
      walletAvailableAfterKobo:
        walletState.availableKobo - normalizedAmountKobo,
    };

    transaction.update(walletDocument, {
      reservedKobo:
        walletState.reservedKobo + normalizedAmountKobo,
      updatedAt: now,
    });

    transaction.create(reservationDocument, reservation);

    transaction.create(auditRef(reservationId), {
      event: "reservation_created",
      reservationId,
      uid: normalizedUid,
      reference: normalizedReference,
      service: normalizedService,
      currency: normalizedCurrency,
      amountKobo: normalizedAmountKobo,
      status: RESERVATION_PENDING,
      balanceKobo: walletState.balanceKobo,
      reservedKobo:
        walletState.reservedKobo + normalizedAmountKobo,
      availableKobo:
        walletState.availableKobo - normalizedAmountKobo,
      createdAt: now,
    });

    return reservation;
  });

  return result;
}

async function getReservation(reservationId) {
  const normalizedReservationId = assertReservationId(reservationId);

  const snapshot = await reservationRef(
    normalizedReservationId
  ).get();

  if (!snapshot.exists) {
    const error = new Error("Reservation not found.");
    error.code = "RESERVATION_NOT_FOUND";
    throw error;
  }

  return {
    id: snapshot.id,
    ...snapshot.data(),
  };
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
    const walletSnapshot = await transaction.get(walletDocument);
    const reservationSnapshot = await transaction.get(
      reservationDocument
    );

    if (!walletSnapshot.exists) {
      const error = new Error("Wallet not found.");
      error.code = "WALLET_NOT_FOUND";
      throw error;
    }

    if (!reservationSnapshot.exists) {
      const error = new Error("Reservation not found.");
      error.code = "RESERVATION_NOT_FOUND";
      throw error;
    }

    const reservation = {
      id: reservationSnapshot.id,
      ...reservationSnapshot.data(),
    };

    validateReservationOwnership(reservation, normalizedUid);

    if (reservation.status === RESERVATION_COMMITTED) {
      return reservation;
    }

    if (reservation.status === RESERVATION_RELEASED) {
      const error = new Error(
        "Released reservation cannot be committed."
      );
      error.code = "RESERVATION_ALREADY_RELEASED";
      throw error;
    }

    if (reservation.status !== RESERVATION_PENDING) {
      const error = new Error(
        "Reservation is not in a committable state."
      );
      error.code = "INVALID_RESERVATION_STATE";
      throw error;
    }

    const amountKobo = assertAmountKobo(
      reservation.amountKobo
    );

    const wallet = walletSnapshot.data();
    const walletState = validateWalletState(wallet);

    if (walletState.reservedKobo < amountKobo) {
      const error = new Error(
        "Reserved wallet balance is insufficient."
      );
      error.code = "INSUFFICIENT_RESERVED_BALANCE";
      throw error;
    }

    if (walletState.balanceKobo < amountKobo) {
      const error = new Error(
        "Wallet balance is insufficient for commitment."
      );
      error.code = "INSUFFICIENT_WALLET_BALANCE";
      throw error;
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
      walletBalanceBeforeKobo: walletState.balanceKobo,
      walletReservedBeforeKobo: walletState.reservedKobo,
      walletAvailableBeforeKobo: walletState.availableKobo,
      walletBalanceAfterKobo: balanceAfterKobo,
      walletReservedAfterKobo: reservedAfterKobo,
      walletAvailableAfterKobo: availableAfterKobo,
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
      ledgerRef(normalizedUid, normalizedReservationId),
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
        balanceBeforeKobo: walletState.balanceKobo,
        balanceAfterKobo: balanceAfterKobo,
        reservedBeforeKobo: walletState.reservedKobo,
        reservedAfterKobo: reservedAfterKobo,
        availableBeforeKobo: walletState.availableKobo,
        availableAfterKobo: availableAfterKobo,
        provider: reservation.provider || null,
        createdAt: reservation.createdAt || now,
        updatedAt: now,
        completedAt: now,
      },
      { merge: true }
    );

    transaction.create(auditRef(normalizedReservationId), {
      event: "reservation_committed",
      reservationId: normalizedReservationId,
      uid: normalizedUid,
      reference: reservation.reference,
      service: reservation.service,
      currency: reservation.currency,
      amountKobo,
      status: RESERVATION_COMMITTED,
      balanceBeforeKobo: walletState.balanceKobo,
      balanceAfterKobo,
      reservedBeforeKobo: walletState.reservedKobo,
      reservedAfterKobo: reservedAfterKobo,
      availableBeforeKobo: walletState.availableKobo,
      availableAfterKobo,
      createdAt: now,
    });

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
    const walletSnapshot = await transaction.get(walletDocument);
    const reservationSnapshot = await transaction.get(
      reservationDocument
    );

    if (!walletSnapshot.exists) {
      const error = new Error("Wallet not found.");
      error.code = "WALLET_NOT_FOUND";
      throw error;
    }

    if (!reservationSnapshot.exists) {
      const error = new Error("Reservation not found.");
      error.code = "RESERVATION_NOT_FOUND";
      throw error;
    }

    const reservation = {
      id: reservationSnapshot.id,
      ...reservationSnapshot.data(),
    };

    validateReservationOwnership(reservation, normalizedUid);

    if (reservation.status === RESERVATION_RELEASED) {
      return reservation;
    }

    if (reservation.status === RESERVATION_COMMITTED) {
      const error = new Error(
        "Committed reservation cannot be released."
      );
      error.code = "RESERVATION_ALREADY_COMMITTED";
      throw error;
    }

    if (reservation.status !== RESERVATION_PENDING) {
      const error = new Error(
        "Reservation is not in a releasable state."
      );
      error.code = "INVALID_RESERVATION_STATE";
      throw error;
    }

    const amountKobo = assertAmountKobo(
      reservation.amountKobo
    );

    const wallet = walletSnapshot.data();
    const walletState = validateWalletState(wallet);

    if (walletState.reservedKobo < amountKobo) {
      const error = new Error(
        "Reserved wallet balance is insufficient for release."
      );
      error.code = "INSUFFICIENT_RESERVED_BALANCE";
      throw error;
    }

    const balanceAfterKobo = walletState.balanceKobo;

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
      walletBalanceBeforeKobo: walletState.balanceKobo,
      walletReservedBeforeKobo: walletState.reservedKobo,
      walletAvailableBeforeKobo: walletState.availableKobo,
      walletBalanceAfterKobo: balanceAfterKobo,
      walletReservedAfterKobo: reservedAfterKobo,
      walletAvailableAfterKobo: availableAfterKobo,
    };

    transaction.update(walletDocument, {
      reservedKobo: reservedAfterKobo,
      updatedAt: now,
    });

    transaction.update(
      reservationDocument,
      updatedReservation
    );

    transaction.create(auditRef(normalizedReservationId), {
      event: "reservation_released",
      reservationId: normalizedReservationId,
      uid: normalizedUid,
      reference: reservation.reference,
      service: reservation.service,
      currency: reservation.currency,
      amountKobo,
      status: RESERVATION_RELEASED,
      balanceBeforeKobo: walletState.balanceKobo,
      balanceAfterKobo,
      reservedBeforeKobo: walletState.reservedKobo,
      reservedAfterKobo,
      availableBeforeKobo: walletState.availableKobo,
      availableAfterKobo,
      createdAt: now,
    });

    return updatedReservation;
  });
}

async function getWalletBalance(uid) {
  const normalizedUid = assertUid(uid);

  const snapshot = await walletRef(normalizedUid).get();

  if (!snapshot.exists) {
    const error = new Error("Wallet not found.");
    error.code = "WALLET_NOT_FOUND";
    throw error;
  }

  const wallet = snapshot.data();
  const walletState = validateWalletState(wallet);

  return {
    balanceKobo: walletState.balanceKobo,
    reservedKobo: walletState.reservedKobo,
    availableKobo: walletState.availableKobo,
    currency: String(wallet.currency || CURRENCY_NGN)
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