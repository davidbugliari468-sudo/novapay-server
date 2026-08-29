// wallet/wallet.js

const crypto = require("crypto");

const { db } = require("../firebase-admin");


// =====================================================
// NOVAPAY WALLET
// =====================================================
//
// The backend is the authority for wallet balances.
//
// IMPORTANT:
// - Frontend must never directly change balance.
// - All money amounts are stored in KOBO.
// - Every balance-changing operation must have a
//   corresponding immutable ledger entry.
// - Deposit credits use an idempotency key/reference.
// =====================================================


// =====================================================
// WALLET COLLECTION
// =====================================================

const WALLETS_COLLECTION = "wallets";


// =====================================================
// LEDGER COLLECTION
// =====================================================

const LEDGER_SUBCOLLECTION = "ledger";


// =====================================================
// GET WALLET REFERENCE
// =====================================================

function getWalletRef(uid) {

    if (!uid) {

        throw new Error(
            "Wallet user ID is required."
        );

    }


    return db
        .collection(WALLETS_COLLECTION)
        .doc(uid);

}


// =====================================================
// GET LEDGER REFERENCE
// =====================================================

function getLedgerRef(
    uid,
    ledgerId
) {

    return getWalletRef(uid)
        .collection(LEDGER_SUBCOLLECTION)
        .doc(ledgerId);

}


// =====================================================
// CREATE DETERMINISTIC LEDGER ID
// =====================================================
//
// The same payment reference always produces the
// same ledger ID.
//
// This gives us another layer of duplicate protection.
// =====================================================

function createDepositLedgerId(
    reference
) {

    return crypto
        .createHash("sha256")
        .update(
            `deposit:${String(reference)}`
        )
        .digest("hex");

}


// =====================================================
// ENSURE WALLET EXISTS
// =====================================================
//
// Creates an empty wallet when one does not exist.
//
// Existing wallets are never reset.
// =====================================================

async function ensureWallet(
    uid
) {

    const walletRef =
        getWalletRef(uid);


    const snapshot =
        await walletRef.get();


    if (snapshot.exists) {

        const data =
            snapshot.data();


        if (
            !Number.isSafeInteger(
                data.balanceKobo
            ) ||
            data.balanceKobo < 0
        ) {

            throw new Error(
                "Wallet contains an invalid balance."
            );

        }


        return {

            uid,

            balanceKobo:
                data.balanceKobo

        };

    }


    await walletRef.create({

        uid,

        balanceKobo:
            0,

        currency:
            "NGN",

        createdAt:
            new Date(),

        updatedAt:
            new Date()

    });


    return {

        uid,

        balanceKobo:
            0

    };

}


// =====================================================
// GET WALLET
// =====================================================

async function getWallet(
    uid
) {

    const walletRef =
        getWalletRef(uid);


    const snapshot =
        await walletRef.get();


    if (!snapshot.exists) {

        return {

            uid,

            balanceKobo:
                0,

            currency:
                "NGN"

        };

    }


    const wallet =
        snapshot.data();


    if (
        !Number.isSafeInteger(
            wallet.balanceKobo
        ) ||
        wallet.balanceKobo < 0
    ) {

        throw new Error(
            "Wallet contains an invalid balance."
        );

    }


    return {

        uid,

        balanceKobo:
            wallet.balanceKobo,

        currency:
            wallet.currency ||
            "NGN",

        createdAt:
            wallet.createdAt ||
            null,

        updatedAt:
            wallet.updatedAt ||
            null

    };

}


// =====================================================
// CREDIT DEPOSIT
// =====================================================
//
// This is the ONLY function we will use to credit money
// from a verified Add Money deposit.
//
// The operation is atomic:
//
// 1. Read wallet.
// 2. Read ledger.
// 3. If ledger already exists → do nothing.
// 4. Increase wallet balance.
// 5. Create ledger entry.
//
// Firestore transaction guarantees these changes happen
// together.
// =====================================================

async function creditDeposit({
    uid,
    reference,
    amountKobo,
    provider
}) {

    if (!uid) {

        throw new Error(
            "Wallet user ID is required."
        );

    }


    if (!reference) {

        throw new Error(
            "Deposit reference is required."
        );

    }


    if (
        !Number.isSafeInteger(
            amountKobo
        ) ||
        amountKobo <= 0
    ) {

        throw new Error(
            "Deposit amount must be a positive integer in kobo."
        );

    }


    const walletRef =
        getWalletRef(uid);


    const ledgerId =
        createDepositLedgerId(
            reference
        );


    const ledgerRef =
        getLedgerRef(
            uid,
            ledgerId
        );


    const result =
        await db.runTransaction(
            async transaction => {

                const walletSnapshot =
                    await transaction.get(
                        walletRef
                    );


                const ledgerSnapshot =
                    await transaction.get(
                        ledgerRef
                    );


                // -----------------------------------------
                // DUPLICATE PROTECTION
                // -----------------------------------------

                if (
                    ledgerSnapshot.exists
                ) {

                    const existingLedger =
                        ledgerSnapshot.data();


                    return {

                        credited:
                            false,

                        duplicate:
                            true,

                        balanceKobo:
                            existingLedger
                                .balanceAfterKobo

                    };

                }


                // -----------------------------------------
                // INITIAL BALANCE
                // -----------------------------------------

                let currentBalanceKobo =
                    0;


                if (
                    walletSnapshot.exists
                ) {

                    const wallet =
                        walletSnapshot.data();


                    currentBalanceKobo =
                        wallet.balanceKobo;


                    if (
                        !Number.isSafeInteger(
                            currentBalanceKobo
                        ) ||
                        currentBalanceKobo < 0
                    ) {

                        throw new Error(
                            "Wallet contains an invalid balance."
                        );

                    }

                }


                // -----------------------------------------
                // CALCULATE NEW BALANCE
                // -----------------------------------------

                const newBalanceKobo =
                    currentBalanceKobo +
                    amountKobo;


                if (
                    !Number.isSafeInteger(
                        newBalanceKobo
                    )
                ) {

                    throw new Error(
                        "Wallet balance exceeds the supported amount."
                    );

                }


                // -----------------------------------------
                // CREATE WALLET IF NEEDED
                // -----------------------------------------

                transaction.set(
                    walletRef,
                    {

                        uid,

                        balanceKobo:
                            newBalanceKobo,

                        currency:
                            "NGN",

                        updatedAt:
                            new Date()

                    },
                    {
                        merge:
                            true
                    }
                );


                // -----------------------------------------
                // CREATE LEDGER ENTRY
                // -----------------------------------------

                transaction.create(
                    ledgerRef,
                    {

                        uid,

                        type:
                            "deposit",

                        provider:
                            provider ||
                            "unknown",

                        reference:
                            String(
                                reference
                            ),

                        amountKobo,

                        balanceBeforeKobo:
                            currentBalanceKobo,

                        balanceAfterKobo:
                            newBalanceKobo,

                        createdAt:
                            new Date()

                    }
                );


                return {

                    credited:
                        true,

                    duplicate:
                        false,

                    balanceKobo:
                        newBalanceKobo

                };

            }
        );


    return {

        uid,

        reference,

        amountKobo,

        credited:
            result.credited,

        duplicate:
            result.duplicate,

        balanceKobo:
            result.balanceKobo

    };

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    ensureWallet,

    getWallet,

    creditDeposit

};