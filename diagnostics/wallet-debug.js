"use strict";

const express = require("express");
const { db } = require("../firebase-admin");

const WALLETS_COLLECTION = "wallets";
const LEDGER_SUBCOLLECTION = "ledger";
const RESERVATIONS_SUBCOLLECTION = "reservations";

function normalizeKobo(value, fieldName) {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${fieldName} is invalid.`);
  }

  return amount;
}

function koboToNaira(kobo) {
  return Number((kobo / 100).toFixed(2));
}

function serializeTimestamp(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    return new Date(value).toISOString();
  }

  return null;
}

function sanitizeReservation(id, data) {
  const amountKobo = normalizeKobo(
    data.amountKobo ?? 0,
    "reservation.amountKobo"
  );

  return {
    id,
    service: data.service || null,
    status: data.status || null,
    reference: data.reference || null,
    uid: data.uid || null,
    amountKobo,
    amountNaira: koboToNaira(amountKobo),
    currency: data.currency || "NGN",
    createdAt: serializeTimestamp(data.createdAt),
    updatedAt: serializeTimestamp(data.updatedAt),
    expiresAt: serializeTimestamp(data.expiresAt),
    provider: data.provider || null,
  };
}

function createDiagnosticRouter(requireAuth) {
  const router = express.Router();

  router.get("/wallet", requireAuth, async (req, res) => {
    try {
      const uid = req.user && req.user.uid;

      if (!uid || typeof uid !== "string") {
        return res.status(401).json({
          ok: false,
          error: "Authenticated user is required.",
        });
      }

      const walletRef = db
        .collection(WALLETS_COLLECTION)
        .doc(uid);

      const walletSnap = await walletRef.get();

      if (!walletSnap.exists) {
        return res.json({
          ok: true,
          diagnostic: {
            uid,
            walletExists: false,
            balanceKobo: 0,
            balanceNaira: 0,
            reservedKobo: 0,
            reservedNaira: 0,
            availableKobo: 0,
            availableNaira: 0,
            reservationCount: 0,
            reservations: [],
            purchaseChecks: {
              50: {
                amountNaira: 50,
                amountKobo: 5000,
                sufficient: false,
                reason: "Wallet does not exist.",
              },
              100: {
                amountNaira: 100,
                amountKobo: 10000,
                sufficient: false,
                reason: "Wallet does not exist.",
              },
              150: {
                amountNaira: 150,
                amountKobo: 15000,
                sufficient: false,
                reason: "Wallet does not exist.",
              },
            },
          },
        });
      }

      const wallet = walletSnap.data();

      const balanceKobo = normalizeKobo(
        wallet.balanceKobo ?? 0,
        "wallet.balanceKobo"
      );

      const reservedKobo = normalizeKobo(
        wallet.reservedKobo ?? 0,
        "wallet.reservedKobo"
      );

      if (reservedKobo > balanceKobo) {
        return res.status(500).json({
          ok: false,
          error: "Wallet reserved balance exceeds total balance.",
          diagnostic: {
            uid,
            balanceKobo,
            balanceNaira: koboToNaira(balanceKobo),
            reservedKobo,
            reservedNaira: koboToNaira(reservedKobo),
          },
        });
      }

      const availableKobo = balanceKobo - reservedKobo;

      const reservationsSnap = await walletRef
        .collection(RESERVATIONS_SUBCOLLECTION)
        .get();

      const reservations = [];

      reservationsSnap.forEach((reservationDoc) => {
        const data = reservationDoc.data();

        const status = String(data.status || "").toLowerCase();

        if (
          status === "pending" ||
          status === "reserved" ||
          status === "processing"
        ) {
          reservations.push(
            sanitizeReservation(
              reservationDoc.id,
              data
            )
          );
        }
      });

      const purchaseAmounts = [50, 100, 150, 200, 500];

      const purchaseChecks = {};

      for (const amountNaira of purchaseAmounts) {
        const amountKobo = amountNaira * 100;
        const sufficient = availableKobo >= amountKobo;

        purchaseChecks[amountNaira] = {
          amountNaira,
          amountKobo,
          sufficient,
          reason: sufficient
            ? "Enough available wallet balance."
            : reservedKobo > 0
              ? `Only ₦${koboToNaira(
                  availableKobo
                ).toFixed(2)} is available because ₦${koboToNaira(
                  reservedKobo
                ).toFixed(2)} is reserved.`
              : `Available balance is below ₦${amountNaira}.`,
        };
      }

      const ledgerSnap = await walletRef
        .collection(LEDGER_SUBCOLLECTION)
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();

      const recentLedger = [];

      ledgerSnap.forEach((ledgerDoc) => {
        const data = ledgerDoc.data();

        recentLedger.push({
          id: ledgerDoc.id,
          type: data.type || null,
          status: data.status || null,
          amountKobo: data.amountKobo ?? null,
          amountNaira:
            data.amountKobo != null
              ? koboToNaira(
                  normalizeKobo(
                    data.amountKobo,
                    "ledger.amountKobo"
                  )
                )
              : null,
          balanceBeforeKobo:
            data.balanceBeforeKobo ?? null,
          balanceAfterKobo:
            data.balanceAfterKobo ?? null,
          reference: data.reference || null,
          provider: data.provider || null,
          createdAt: serializeTimestamp(data.createdAt),
        });
      });

      return res.json({
        ok: true,
        diagnostic: {
          uid,
          walletExists: true,

          wallet: {
            balanceKobo,
            balanceNaira: koboToNaira(balanceKobo),

            reservedKobo,
            reservedNaira: koboToNaira(reservedKobo),

            availableKobo,
            availableNaira: koboToNaira(availableKobo),

            currency: wallet.currency || "NGN",
          },

          reservationCount: reservations.length,
          reservations,

          purchaseChecks,

          recentLedger,
        },
      });
    } catch (error) {
      console.error(
        "Wallet diagnostic error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to inspect wallet diagnostic.",
      });
    }
  });

  return router;
}

module.exports = {
  createDiagnosticRouter,
};