const { db } = require("../firebase-admin");

const WALLETS_COLLECTION = "wallets";
const LEDGER_SUBCOLLECTION = "ledger";

/**
 * Normalize an amount to a safe non-negative integer number of kobo.
 *
 * Financial amounts must always be stored as integer kobo values.
 */
function normalizeKobo(value, fieldName = "amountKobo") {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${fieldName} must be a non-negative integer kobo amount.`);
  }

  return amount;
}

/**
 * Ensure a wallet exists for a user.
 *
 * This function does not modify an existing wallet.
 */
async function ensureWallet(uid) {
  if (!uid || typeof uid !== "string") {
    throw new Error("A valid uid is required.");
  }

  const walletRef = db.collection(WALLETS_COLLECTION).doc(uid);
  const walletSnap = await walletRef.get();

  if (walletSnap.exists) {
    return {
      id: walletSnap.id,
      ...walletSnap.data(),
    };
  }

  const walletData = {
    balanceKobo: 0,
    currency: "NGN",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await walletRef.create(walletData);

  return {
    id: uid,
    ...walletData,
  };
}

/**
 * Get a user's wallet.
 *
 * If the wallet does not exist, create it with a zero balance.
 */
async function getWallet(uid) {
  if (!uid || typeof uid !== "string") {
    throw new Error("A valid uid is required.");
  }

  const walletRef = db.collection(WALLETS_COLLECTION).doc(uid);
  const walletSnap = await walletRef.get();

  if (!walletSnap.exists) {
    return ensureWallet(uid);
  }

  const data = walletSnap.data();

  return {
    id: walletSnap.id,
    ...data,
    balanceKobo: normalizeKobo(
      data.balanceKobo ?? 0,
      "wallet.balanceKobo"
    ),
    currency: data.currency || "NGN",
  };
}

/**
 * Credit a wallet from a confirmed deposit.
 *
 * This is intended for trusted backend payment flows such as the
 * Paystack webhook after payment verification.
 *
 * The operation is idempotent using the ledger reference.
 */
async function creditDeposit({
  uid,
  amountKobo,
  reference,
  provider = "paystack",
  metadata = {},
}) {
  if (!uid || typeof uid !== "string") {
    throw new Error("A valid uid is required.");
  }

  const amount = normalizeKobo(amountKobo, "amountKobo");

  if (amount <= 0) {
    throw new Error("Deposit amount must be greater than zero.");
  }

  if (!reference || typeof reference !== "string") {
    throw new Error("A valid deposit reference is required.");
  }

  const walletRef = db.collection(WALLETS_COLLECTION).doc(uid);
  const ledgerRef = walletRef
    .collection(LEDGER_SUBCOLLECTION)
    .doc(reference);

  return db.runTransaction(async (transaction) => {
    const [walletSnap, ledgerSnap] = await Promise.all([
      transaction.get(walletRef),
      transaction.get(ledgerRef),
    ]);

    /*
     * Idempotency:
     * If this payment reference has already produced a ledger entry,
     * do not credit the wallet again.
     */
    if (ledgerSnap.exists) {
      const existingLedger = ledgerSnap.data();

      return {
        alreadyProcessed: true,
        balanceKobo: normalizeKobo(
          existingLedger.balanceAfterKobo ?? 0,
          "balanceAfterKobo"
        ),
        ledgerId: ledgerSnap.id,
      };
    }

    let balanceBeforeKobo = 0;

    if (walletSnap.exists) {
      const walletData = walletSnap.data();

      balanceBeforeKobo = normalizeKobo(
        walletData.balanceKobo ?? 0,
        "wallet.balanceKobo"
      );
    }

    const balanceAfterKobo = balanceBeforeKobo + amount;

    if (!Number.isSafeInteger(balanceAfterKobo)) {
      throw new Error("Wallet balance exceeds the supported safe integer range.");
    }

    const now = new Date();

    const walletData = {
      balanceKobo: balanceAfterKobo,
      currency: walletSnap.exists
        ? walletSnap.data().currency || "NGN"
        : "NGN",
      updatedAt: now,
    };

    if (!walletSnap.exists) {
      walletData.createdAt = now;
      transaction.create(walletRef, walletData);
    } else {
      transaction.update(walletRef, walletData);
    }

    const ledgerData = {
      type: "deposit",
      status: "successful",
      amountKobo: amount,
      balanceBeforeKobo,
      balanceAfterKobo,
      reference,
      provider,
      currency: "NGN",
      metadata,
      createdAt: now,
    };

    transaction.create(ledgerRef, ledgerData);

    return {
      alreadyProcessed: false,
      balanceKobo: balanceAfterKobo,
      ledgerId: ledgerRef.id,
    };
  });
}

module.exports = {
  ensureWallet,
  getWallet,
  creditDeposit,
};