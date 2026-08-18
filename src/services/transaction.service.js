const { db, admin } = require("../config/firebase");
const {
  debitWalletInTransaction,
  creditWalletInTransaction,
  normalizeAmount
} = require("./wallet.service");

/**
 * Create a pending transaction while reserving wallet funds.
 *
 * Wallet debit + transaction creation happen in ONE Firestore
 * transaction so they cannot get out of sync.
 */
async function createPendingTransaction({
  uid,
  type,
  amount,
  provider,
  reference,
  metadata = {}
}) {
  if (!uid) {
    throw new Error("INVALID_USER");
  }

  if (!type) {
    throw new Error("INVALID_TRANSACTION_TYPE");
  }

  const transactionAmount = normalizeAmount(amount);

  if (transactionAmount <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  if (!reference) {
    throw new Error("INVALID_REFERENCE");
  }

  const transactionRef = db
    .collection("transactions")
    .doc(reference);

  let walletResult;

  await db.runTransaction(async (transaction) => {
    walletResult = await debitWalletInTransaction(
      transaction,
      uid,
      transactionAmount
    );

    transaction.set(transactionRef, {
      uid,
      type,
      amount: transactionAmount,
      status: "PENDING",
      reference,
      provider: provider || null,
      ...metadata,
      createdAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return {
    reference,
    amount: transactionAmount,
    previousBalance: walletResult.previousBalance,
    newBalance: walletResult.newBalance,
    status: "PENDING"
  };
}

/**
 * Mark a pending transaction as successful.
 *
 * If it is already completed, nothing is changed.
 * This protects against duplicate provider callbacks/reconciliation.
 */
async function markTransactionSuccessful(
  reference,
  providerResponse = null
) {
  if (!reference) {
    throw new Error("INVALID_REFERENCE");
  }

  const transactionRef = db
    .collection("transactions")
    .doc(reference);

  let changed = false;

  await db.runTransaction(async (transaction) => {
    const transactionDoc =
      await transaction.get(transactionRef);

    if (!transactionDoc.exists) {
      throw new Error("TRANSACTION_NOT_FOUND");
    }

    const currentTransaction =
      transactionDoc.data();

    if (currentTransaction.status !== "PENDING") {
      return;
    }

    transaction.update(transactionRef, {
      status: "SUCCESS",
      providerResponse,
      completedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    });

    changed = true;
  });

  return {
    reference,
    status: changed ? "SUCCESS" : "UNCHANGED"
  };
}

/**
 * Mark a pending transaction as failed and refund the wallet.
 *
 * The transaction status check prevents double refunds.
 */
async function markTransactionFailed(
  reference,
  providerResponse = null
) {
  if (!reference) {
    throw new Error("INVALID_REFERENCE");
  }

  const transactionRef = db
    .collection("transactions")
    .doc(reference);

  let result = {
    reference,
    status: "UNCHANGED"
  };

  await db.runTransaction(async (transaction) => {
    const transactionDoc =
      await transaction.get(transactionRef);

    if (!transactionDoc.exists) {
      throw new Error("TRANSACTION_NOT_FOUND");
    }

    const currentTransaction =
      transactionDoc.data();

    if (currentTransaction.status !== "PENDING") {
      return;
    }

    const uid = currentTransaction.uid;

    if (!uid) {
      throw new Error("TRANSACTION_USER_MISSING");
    }

    const refundAmount =
      normalizeAmount(currentTransaction.amount);

    const walletResult =
      await creditWalletInTransaction(
        transaction,
        uid,
        refundAmount
      );

    transaction.update(transactionRef, {
      status: "FAILED",
      providerResponse,
      refundAmount,
      refundedAt:
        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    });

    result = {
      reference,
      status: "FAILED",
      refundAmount,
      newBalance: walletResult.newBalance
    };
  });

  return result;
}

module.exports = {
  createPendingTransaction,
  markTransactionSuccessful,
  markTransactionFailed
};