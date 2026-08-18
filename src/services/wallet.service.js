const { db, admin } = require("../config/firebase");

function normalizeAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    throw new Error("INVALID_AMOUNT");
  }

  return Math.round(amount * 100) / 100;
}

function getUserRef(uid) {
  if (!uid || typeof uid !== "string") {
    throw new Error("INVALID_USER");
  }

  return db.collection("users").doc(uid);
}

/**
 * Read the current wallet balance.
 */
async function getWalletBalance(uid) {
  const userRef = getUserRef(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    throw new Error("USER_NOT_FOUND");
  }

  const userData = userDoc.data();

  return normalizeAmount(
    userData.walletBalance || 0
  );
}

/**
 * Debit wallet inside an existing Firestore transaction.
 *
 * IMPORTANT:
 * This function does not create the Firestore transaction itself.
 * The caller supplies the transaction so wallet changes can remain
 * atomic with creation/update of the NovaPay transaction record.
 */
async function debitWalletInTransaction(
  firestoreTransaction,
  uid,
  amount
) {
  const debitAmount = normalizeAmount(amount);

  if (debitAmount <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  const userRef = getUserRef(uid);
  const userDoc = await firestoreTransaction.get(userRef);

  if (!userDoc.exists) {
    throw new Error("USER_NOT_FOUND");
  }

  const userData = userDoc.data();

  const currentBalance = normalizeAmount(
    userData.walletBalance || 0
  );

  if (currentBalance < debitAmount) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  const newBalance = normalizeAmount(
    currentBalance - debitAmount
  );

  firestoreTransaction.update(userRef, {
    walletBalance: newBalance,
    updatedAt:
      admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    previousBalance: currentBalance,
    amount: debitAmount,
    newBalance
  };
}

/**
 * Credit wallet inside an existing Firestore transaction.
 *
 * Used for deposits and refunds.
 */
async function creditWalletInTransaction(
  firestoreTransaction,
  uid,
  amount
) {
  const creditAmount = normalizeAmount(amount);

  if (creditAmount <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  const userRef = getUserRef(uid);
  const userDoc = await firestoreTransaction.get(userRef);

  if (!userDoc.exists) {
    throw new Error("USER_NOT_FOUND");
  }

  const userData = userDoc.data();

  const currentBalance = normalizeAmount(
    userData.walletBalance || 0
  );

  const newBalance = normalizeAmount(
    currentBalance + creditAmount
  );

  firestoreTransaction.update(userRef, {
    walletBalance: newBalance,
    updatedAt:
      admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    previousBalance: currentBalance,
    amount: creditAmount,
    newBalance
  };
}

module.exports = {
  normalizeAmount,
  getWalletBalance,
  debitWalletInTransaction,
  creditWalletInTransaction
};