const crypto = require("crypto");
const { db } = require("../config/firebase");

const walletsCollection = db.collection("wallets");
const reservationsCollection = db.collection("walletReservations");

const CURRENCY = "NGN";
const RESERVATION_STATUS = {
  PENDING: "pending",
  COMMITTED: "committed",
  RELEASED: "released",
};

function nowTimestamp() {
  return new Date();
}

function requireUid(uid) {
  if (!uid || typeof uid !== "string" || uid.trim().length === 0) {
    throw new Error("Authenticated user ID is required.");
  }

  return uid.trim();
}

function requireReference(reference) {
  if (
    !reference ||
    typeof reference !== "string" ||
    reference.trim().length === 0
  ) {
    throw new Error("Transaction reference is required.");
  }

  if (reference.trim().length > 200) {
    throw new Error("Transaction reference is too long.");
  }

  return reference.trim();
}

function requireAmountKobo(amountKobo) {
  if (
    !Number.isInteger(amountKobo) ||
    amountKobo <= 0
  ) {
    throw new Error("A valid amount is required.");
  }

  return amountKobo;
}

function requireCurrency(currency) {
  const normalized = String(currency || CURRENCY)
    .trim()
    .toUpperCase();

  if (normalized !== CURRENCY) {
    throw new Error("Unsupported currency.");
  }

  return normalized;
}

function requireService(service) {
  if (
    !service ||
    typeof service !== "string" ||
    service.trim().length === 0
  ) {
    throw new Error("Service is required.");
  }

  return service.trim().toLowerCase();
}

function requireReservationId(reservationId) {
  if (
    !reservationId ||
    typeof reservationId !== "string" ||
    reservationId.trim().length === 0
  ) {
    throw new Error("Reservation ID is required.");
  }

  return reservationId.trim();
}

function createReservationId() {
  return `NPRES_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

function createAuditId() {
  return `NPAUD_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeProvider(provider) {
  if (!provider || typeof provider !== "string") {
    return null;
  }

  const normalized = provider.trim().toLowerCase();

  return normalized || null;
}

/**
 * Reserve wallet funds for a service transaction.
 *
 * IMPORTANT:
 * - This does NOT reduce balanceKobo.
 * - It increases reservedKobo so the funds cannot be spent twice.
 * - The actual wallet debit happens only when commitReservation() succeeds.
 */
async function reserveFunds({
  uid,
  reference,
  amountKobo,
  currency = CURRENCY,
  service,
}) {
  const authenticatedUid = requireUid(uid);
  const normalizedReference = requireReference(reference);
  const normalizedAmountKobo = requireAmountKobo(amountKobo);
  const normalizedCurrency = requireCurrency(currency);
  const normalizedService = requireService(service);

  const walletRef = walletsCollection.doc(authenticatedUid);

  const existingSnapshot = await reservationsCollection
    .where("uid", "==", authenticatedUid)
    .where("reference", "==", normalizedReference)
    .limit(1)
    .get();

  if (!existingSnapshot.empty) {
    const existingDoc = existingSnapshot.docs[0];
    const existingReservation = {
      id: existingDoc.id,
      ...existingDoc.data(),
    };

    if (existingReservation.amountKobo !== normalizedAmountKobo) {
      throw new Error(
        "A reservation already exists with a different amount."
      );
    }

    if (existingReservation.currency !== normalizedCurrency) {
      throw new Error(
        "A reservation already exists with a different currency."
      );
    }

    if (existingReservation.service !== normalizedService) {
      throw new Error(
        "A reservation already exists for a different service."
      );
    }

    return {
      success: true,
      alreadyReserved: true,
      reservation: existingReservation,
    };
  }

  const reservationId = createReservationId();
  const reservationRef = reservationsCollection.doc(reservationId);

  const reservationCreatedAt = nowTimestamp();

  const result = await db.runTransaction(async (transaction) => {
    const walletSnapshot = await transaction.get(walletRef);

    if (!walletSnapshot.exists) {
      throw new Error("Wallet not found.");
    }

    const wallet = walletSnapshot.data() || {};

    const balanceKobo = Number(wallet.balanceKobo || 0);
    const reservedKobo = Number(wallet.reservedKobo || 0);

    if (
      !Number.isInteger(balanceKobo) ||
      balanceKobo < 0
    ) {
      throw new Error("Wallet balance is invalid.");
    }

    if (
      !Number.isInteger(reservedKobo) ||
      reservedKobo < 0
    ) {
      throw new Error("Wallet reserved balance is invalid.");
    }

    const availableKobo = balanceKobo - reservedKobo;

    if (availableKobo < normalizedAmountKobo) {
      throw new Error("Insufficient wallet balance.");
    }

    const newReservedKobo =
      reservedKobo + normalizedAmountKobo;

    const reservation = {
      uid: authenticatedUid,
      reference: normalizedReference,
      amountKobo: normalizedAmountKobo,
      currency: normalizedCurrency,
      service: normalizedService,
      status: RESERVATION_STATUS.PENDING,
      createdAt: reservationCreatedAt,
      updatedAt: reservationCreatedAt,
      walletBalanceBeforeKobo: balanceKobo,
      reservedBeforeKobo: reservedKobo,
      reservedAfterKobo: newReservedKobo,
    };

    transaction.update(walletRef, {
      reservedKobo: newReservedKobo,
      updatedAt: reservationCreatedAt,
    });

    transaction.create(reservationRef, reservation);

    const auditRef = reservationRef
      .collection("audit")
      .doc(createAuditId());

    transaction.create(auditRef, {
      uid: authenticatedUid,
      reservationId,
      reference: normalizedReference,
      action: "reserved",
      amountKobo: normalizedAmountKobo,
      currency: normalizedCurrency,
      service: normalizedService,
      status: RESERVATION_STATUS.PENDING,
      balanceKobo: balanceKobo,
      reservedKoboBefore: reservedKobo,
      reservedKoboAfter: newReservedKobo,
      createdAt: reservationCreatedAt,
    });

    return {
      id: reservationId,
      ...reservation,
    };
  });

  return {
    success: true,
    alreadyReserved: false,
    reservation: result,
  };
}

async function getReservation({
  uid,
  reservationId,
}) {
  const authenticatedUid = requireUid(uid);
  const normalizedReservationId =
    requireReservationId(reservationId);

  const reservationRef =
    reservationsCollection.doc(normalizedReservationId);

  const snapshot = await reservationRef.get();

  if (!snapshot.exists) {
    throw new Error("Reservation not found.");
  }

  const reservation = snapshot.data() || {};

  if (reservation.uid !== authenticatedUid) {
    throw new Error("Unauthorized reservation access.");
  }

  return {
    id: snapshot.id,
    ...reservation,
  };
}

/**
 * Commit a reservation after the provider has explicitly succeeded.
 *
 * IMPORTANT:
 * - Wallet debit happens atomically.
 * - Reserved funds are released from reservedKobo.
 * - A ledger record is created in the SAME Firestore transaction.
 * - The ledger document uses reservationId as its deterministic ID,
 *   preventing duplicate transaction-history entries on retries.
 */
async function commitReservation({
  uid,
  reservationId,
  provider,
}) {
  const authenticatedUid = requireUid(uid);
  const normalizedReservationId =
    requireReservationId(reservationId);
  const normalizedProvider = normalizeProvider(provider);

  const reservationRef =
    reservationsCollection.doc(normalizedReservationId);

  const walletRef =
    walletsCollection.doc(authenticatedUid);

  const ledgerRef = walletRef
    .collection("ledger")
    .doc(normalizedReservationId);

  const committedAt = nowTimestamp();

  const result = await db.runTransaction(async (transaction) => {
    /*
     * ALL READS happen before writes.
     */
    const reservationSnapshot =
      await transaction.get(reservationRef);

    if (!reservationSnapshot.exists) {
      throw new Error("Reservation not found.");
    }

    const reservation = reservationSnapshot.data() || {};

    if (reservation.uid !== authenticatedUid) {
      throw new Error("Unauthorized reservation access.");
    }

    const walletSnapshot =
      await transaction.get(walletRef);

    if (!walletSnapshot.exists) {
      throw new Error("Wallet not found.");
    }

    const wallet = walletSnapshot.data() || {};

    /*
     * Idempotent retry:
     * If this reservation was already committed, do not debit again.
     */
    if (
      reservation.status ===
      RESERVATION_STATUS.COMMITTED
    ) {
      return {
        committed: true,
        alreadyCommitted: true,
        reservation: {
          id: reservationSnapshot.id,
          ...reservation,
        },
      };
    }

    if (
      reservation.status ===
      RESERVATION_STATUS.RELEASED
    ) {
      throw new Error(
        "Reservation has already been released."
      );
    }

    if (
      reservation.status !==
      RESERVATION_STATUS.PENDING
    ) {
      throw new Error("Reservation is not pending.");
    }

    const amountKobo =
      Number(reservation.amountKobo || 0);

    if (
      !Number.isInteger(amountKobo) ||
      amountKobo <= 0
    ) {
      throw new Error(
        "Reservation amount is invalid."
      );
    }

    const reservationCurrency =
      requireCurrency(
        reservation.currency || CURRENCY
      );

    const balanceKobo =
      Number(wallet.balanceKobo || 0);

    const reservedKobo =
      Number(wallet.reservedKobo || 0);

    if (
      !Number.isInteger(balanceKobo) ||
      balanceKobo < 0
    ) {
      throw new Error(
        "Wallet balance is invalid."
      );
    }

    if (
      !Number.isInteger(reservedKobo) ||
      reservedKobo < 0
    ) {
      throw new Error(
        "Wallet reserved balance is invalid."
      );
    }

    if (reservedKobo < amountKobo) {
      throw new Error(
        "Reserved wallet balance is insufficient."
      );
    }

    if (balanceKobo < amountKobo) {
      throw new Error(
        "Wallet balance is insufficient."
      );
    }

    const newBalanceKobo =
      balanceKobo - amountKobo;

    const newReservedKobo =
      reservedKobo - amountKobo;

    const availableAfterKobo =
      newBalanceKobo - newReservedKobo;

    /*
     * Keep the wallet debit and reservation release
     * atomic with the transaction-history ledger entry.
     */
    transaction.update(walletRef, {
      balanceKobo: newBalanceKobo,
      reservedKobo: newReservedKobo,
      updatedAt: committedAt,
    });

    transaction.update(reservationRef, {
      status: RESERVATION_STATUS.COMMITTED,
      committedAt,
      updatedAt: committedAt,
      provider: normalizedProvider,
    });

    /*
     * NEW FIX:
     * Create the financial ledger record in the SAME
     * Firestore transaction as the wallet debit.
     *
     * Using reservationId as the document ID makes this
     * ledger entry deterministic and idempotent.
     */
    transaction.create(ledgerRef, {
      uid: authenticatedUid,
      reservationId: normalizedReservationId,
      amountKobo,
      balanceBeforeKobo: balanceKobo,
      balanceAfterKobo: newBalanceKobo,
      availableAfterKobo,
      reservedBeforeKobo: reservedKobo,
      reservedAfterKobo: newReservedKobo,
      createdAt: committedAt,
      type: "airtime",
      service: reservation.service || "airtime",
      reference: reservation.reference,
      status: "successful",
      direction: "debit",
      currency: reservationCurrency,
      provider: normalizedProvider,
    });

    const auditRef = reservationRef
      .collection("audit")
      .doc(createAuditId());

    transaction.create(auditRef, {
      uid: authenticatedUid,
      reservationId: normalizedReservationId,
      reference: reservation.reference,
      action: "committed",
      amountKobo,
      currency: reservationCurrency,
      service: reservation.service || "airtime",
      status: RESERVATION_STATUS.COMMITTED,
      provider: normalizedProvider,
      balanceBeforeKobo: balanceKobo,
      balanceAfterKobo: newBalanceKobo,
      reservedBeforeKobo: reservedKobo,
      reservedAfterKobo: newReservedKobo,
      createdAt: committedAt,
    });

    return {
      committed: true,
      alreadyCommitted: false,
      reservation: {
        id: reservationSnapshot.id,
        ...reservation,
        status: RESERVATION_STATUS.COMMITTED,
        committedAt,
        updatedAt: committedAt,
        provider: normalizedProvider,
      },
    };
  });

  return {
    success: true,
    ...result,
  };
}

async function releaseReservation({
  uid,
  reservationId,
  reason,
}) {
  const authenticatedUid = requireUid(uid);
  const normalizedReservationId =
    requireReservationId(reservationId);

  const reservationRef =
    reservationsCollection.doc(normalizedReservationId);

  const walletRef =
    walletsCollection.doc(authenticatedUid);

  const releasedAt = nowTimestamp();

  const result = await db.runTransaction(async (transaction) => {
    const reservationSnapshot =
      await transaction.get(reservationRef);

    if (!reservationSnapshot.exists) {
      throw new Error("Reservation not found.");
    }

    const reservation = reservationSnapshot.data() || {};

    if (reservation.uid !== authenticatedUid) {
      throw new Error("Unauthorized reservation access.");
    }

    if (
      reservation.status ===
      RESERVATION_STATUS.RELEASED
    ) {
      return {
        released: true,
        alreadyReleased: true,
        reservation: {
          id: reservationSnapshot.id,
          ...reservation,
        },
      };
    }

    if (
      reservation.status ===
      RESERVATION_STATUS.COMMITTED
    ) {
      throw new Error(
        "Committed reservation cannot be released."
      );
    }

    if (
      reservation.status !==
      RESERVATION_STATUS.PENDING
    ) {
      throw new Error("Reservation is not pending.");
    }

    const amountKobo =
      Number(reservation.amountKobo || 0);

    if (
      !Number.isInteger(amountKobo) ||
      amountKobo <= 0
    ) {
      throw new Error(
        "Reservation amount is invalid."
      );
    }

    const walletSnapshot =
      await transaction.get(walletRef);

    if (!walletSnapshot.exists) {
      throw new Error("Wallet not found.");
    }

    const wallet = walletSnapshot.data() || {};

    const balanceKobo =
      Number(wallet.balanceKobo || 0);

    const reservedKobo =
      Number(wallet.reservedKobo || 0);

    if (
      !Number.isInteger(balanceKobo) ||
      balanceKobo < 0
    ) {
      throw new Error(
        "Wallet balance is invalid."
      );
    }

    if (
      !Number.isInteger(reservedKobo) ||
      reservedKobo < 0
    ) {
      throw new Error(
        "Wallet reserved balance is invalid."
      );
    }

    if (reservedKobo < amountKobo) {
      throw new Error(
        "Reserved wallet balance is insufficient."
      );
    }

    const newReservedKobo =
      reservedKobo - amountKobo;

    transaction.update(walletRef, {
      reservedKobo: newReservedKobo,
      updatedAt: releasedAt,
    });

    transaction.update(reservationRef, {
      status: RESERVATION_STATUS.RELEASED,
      releasedAt,
      updatedAt: releasedAt,
      releaseReason:
        typeof reason === "string"
          ? reason.trim().slice(0, 500)
          : null,
    });

    const auditRef = reservationRef
      .collection("audit")
      .doc(createAuditId());

    transaction.create(auditRef, {
      uid: authenticatedUid,
      reservationId: normalizedReservationId,
      reference: reservation.reference,
      action: "released",
      amountKobo,
      currency:
        reservation.currency || CURRENCY,
      service:
        reservation.service || null,
      status: RESERVATION_STATUS.RELEASED,
      reason:
        typeof reason === "string"
          ? reason.trim().slice(0, 500)
          : null,
      balanceKobo,
      reservedBeforeKobo: reservedKobo,
      reservedAfterKobo: newReservedKobo,
      createdAt: releasedAt,
    });

    return {
      released: true,
      alreadyReleased: false,
      reservation: {
        id: reservationSnapshot.id,
        ...reservation,
        status: RESERVATION_STATUS.RELEASED,
        releasedAt,
        updatedAt: releasedAt,
      },
    };
  });

  return {
    success: true,
    ...result,
  };
}

async function getWalletBalance(uid) {
  const authenticatedUid = requireUid(uid);

  const walletRef =
    walletsCollection.doc(authenticatedUid);

  const snapshot = await walletRef.get();

  if (!snapshot.exists) {
    throw new Error("Wallet not found.");
  }

  const wallet = snapshot.data() || {};

  const balanceKobo =
    Number(wallet.balanceKobo || 0);

  const reservedKobo =
    Number(wallet.reservedKobo || 0);

  if (
    !Number.isInteger(balanceKobo) ||
    balanceKobo < 0
  ) {
    throw new Error(
      "Wallet balance is invalid."
    );
  }

  if (
    !Number.isInteger(reservedKobo) ||
    reservedKobo < 0
  ) {
    throw new Error(
      "Wallet reserved balance is invalid."
    );
  }

  return {
    balanceKobo,
    reservedKobo,
    availableKobo:
      balanceKobo - reservedKobo,
    currency:
      wallet.currency || CURRENCY,
  };
}

module.exports = {
  reserveFunds,
  getReservation,
  commitReservation,
  releaseReservation,
  getWalletBalance,
};