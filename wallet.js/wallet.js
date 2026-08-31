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
//
// - Frontend must never directly change balance.
// - All money amounts are stored in KOBO.
// - Every balance-changing operation creates a ledger
//   entry inside the user's wallet.
// - Ledger entries are immutable from the client.
// - Deposit credits use a deterministic idempotency ID.
// - Wallet balance + ledger entry are written atomically.
// =====================================================


// =====================================================
// COLLECTIONS
// =====================================================

const WALLETS_COLLECTION =
    "wallets";

const LEDGER_SUBCOLLECTION =
    "ledger";


// =====================================================
// CONSTANTS
// =====================================================

const DEFAULT_CURRENCY =
    "NGN";

const DEPOSIT_TYPE =
    "deposit";

const CREDIT_DIRECTION =
    "credit";

const SUCCESSFUL_STATUS =
    "successful";


// =====================================================
// GET WALLET REFERENCE
// =====================================================

function getWalletRef(uid) {

    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {

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

    if (
        typeof ledgerId !== "string" ||
        !ledgerId.trim()
    ) {

        throw new Error(
            "Ledger ID is required."
        );

    }

    return getWalletRef(uid)
        .collection(
            LEDGER_SUBCOLLECTION
        )
        .doc(ledgerId);

}


// =====================================================
// CREATE DETERMINISTIC DEPOSIT LEDGER ID
// =====================================================
//
// The same payment reference always generates the same
// Firestore ledger document ID.
//
// This gives us idempotency protection.
//
// Example:
//
// deposit reference:
// NPDEP_12345
//
// becomes a SHA-256 ledger document ID.
// =====================================================

function createDepositLedgerId(
    reference
) {

    const normalizedReference =
        String(
            reference
        )
            .trim();


    if (!normalizedReference) {

        throw new Error(
            "Deposit reference is required."
        );

    }


    return crypto
        .createHash("sha256")
        .update(
            `deposit:${normalizedReference}`
        )
        .digest("hex");

}


// =====================================================
// VALIDATE MONEY AMOUNT
// =====================================================

function validateAmountKobo(
    amountKobo
) {

    if (
        !Number.isSafeInteger(
            amountKobo
        ) ||
        amountKobo <= 0
    ) {

        throw new Error(
            "Amount must be a positive integer in kobo."
        );

    }


    return amountKobo;

}


// =====================================================
// VALIDATE BALANCE
// =====================================================

function validateBalanceKobo(
    balanceKobo
) {

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


    return balanceKobo;

}


// =====================================================
// ENSURE WALLET EXISTS
// =====================================================
//
// Creates an empty wallet if the user does not already
// have one.
//
// Existing wallets are NEVER reset.
// =====================================================

async function ensureWallet(
    uid
) {

    const walletRef =
        getWalletRef(uid);


    const snapshot =
        await walletRef.get();


    if (
        snapshot.exists
    ) {

        const data =
            snapshot.data();


        const balanceKobo =
            validateBalanceKobo(
                data.balanceKobo
            );


        return {

            uid,

            balanceKobo,

            currency:
                String(
                    data.currency ||
                    DEFAULT_CURRENCY
                )
                    .toUpperCase()

        };

    }


    const now =
        new Date();


    await walletRef.create({

        uid,

        balanceKobo:
            0,

        currency:
            DEFAULT_CURRENCY,

        createdAt:
            now,

        updatedAt:
            now

    });


    return {

        uid,

        balanceKobo:
            0,

        currency:
            DEFAULT_CURRENCY

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


    if (
        !snapshot.exists
    ) {

        return {

            uid,

            balanceKobo:
                0,

            currency:
                DEFAULT_CURRENCY,

            createdAt:
                null,

            updatedAt:
                null

        };

    }


    const wallet =
        snapshot.data();


    const balanceKobo =
        validateBalanceKobo(
            wallet.balanceKobo
        );


    return {

        uid,

        balanceKobo,

        currency:
            String(
                wallet.currency ||
                DEFAULT_CURRENCY
            )
                .toUpperCase(),

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
// This is the controlled backend operation used after a
// payment provider confirms a successful deposit.
//
// ATOMIC OPERATION:
//
// 1. Read wallet.
// 2. Read deterministic ledger document.
// 3. If ledger exists → duplicate, do nothing.
// 4. Validate current balance.
// 5. Calculate new balance.
// 6. Update wallet.
// 7. Create immutable ledger entry.
//
// Firestore transaction guarantees the wallet update and
// ledger creation happen together.
// =====================================================

async function creditDeposit({
    uid,
    reference,
    amountKobo,
    provider,
    currency
}) {

    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {

        throw new Error(
            "Wallet user ID is required."
        );

    }


    const normalizedReference =
        String(
            reference || ""
        )
            .trim();


    if (!normalizedReference) {

        throw new Error(
            "Deposit reference is required."
        );

    }


    const validatedAmountKobo =
        validateAmountKobo(
            amountKobo
        );


    const normalizedProvider =
        String(
            provider ||
            "unknown"
        )
            .trim()
            .toLowerCase();


    const normalizedCurrency =
        String(
            currency ||
            DEFAULT_CURRENCY
        )
            .trim()
            .toUpperCase();


    if (
        normalizedCurrency !==
        DEFAULT_CURRENCY
    ) {

        throw new Error(
            "Unsupported wallet currency."
        );

    }


    const walletRef =
        getWalletRef(uid);


    const ledgerId =
        createDepositLedgerId(
            normalizedReference
        );


    const ledgerRef =
        getLedgerRef(
            uid,
            ledgerId
        );


    const result =
        await db.runTransaction(
            async transaction => {

                // -----------------------------------------
                // READ WALLET
                // -----------------------------------------

                const walletSnapshot =
                    await transaction.get(
                        walletRef
                    );


                // -----------------------------------------
                // READ LEDGER
                // -----------------------------------------

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


                    const existingBalance =
                        validateBalanceKobo(
                            existingLedger
                                .balanceAfterKobo
                        );


                    return {

                        credited:
                            false,

                        duplicate:
                            true,

                        balanceKobo:
                            existingBalance

                    };

                }


                // -----------------------------------------
                // CURRENT BALANCE
                // -----------------------------------------

                let currentBalanceKobo =
                    0;


                if (
                    walletSnapshot.exists
                ) {

                    const wallet =
                        walletSnapshot.data();


                    currentBalanceKobo =
                        validateBalanceKobo(
                            wallet.balanceKobo
                        );


                    const walletCurrency =
                        String(
                            wallet.currency ||
                            DEFAULT_CURRENCY
                        )
                            .trim()
                            .toUpperCase();


                    if (
                        walletCurrency !==
                        normalizedCurrency
                    ) {

                        throw new Error(
                            "Wallet currency mismatch."
                        );

                    }

                }


                // -----------------------------------------
                // CALCULATE NEW BALANCE
                // -----------------------------------------

                const newBalanceKobo =
                    currentBalanceKobo +
                    validatedAmountKobo;


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
                // TRANSACTION TIME
                // -----------------------------------------

                const now =
                    new Date();


                // -----------------------------------------
                // UPDATE WALLET
                // -----------------------------------------

                transaction.set(
                    walletRef,
                    {

                        uid,

                        balanceKobo:
                            newBalanceKobo,

                        currency:
                            normalizedCurrency,

                        updatedAt:
                            now

                    },
                    {
                        merge:
                            true
                    }
                );


                // -----------------------------------------
                // CREATE LEDGER ENTRY
                // -----------------------------------------
                //
                // This is the permanent financial history
                // record for the wallet credit.
                // -----------------------------------------

                transaction.create(
                    ledgerRef,
                    {

                        uid,

                        type:
                            DEPOSIT_TYPE,

                        direction:
                            CREDIT_DIRECTION,

                        status:
                            SUCCESSFUL_STATUS,

                        provider:
                            normalizedProvider,

                        reference:
                            normalizedReference,

                        amountKobo:
                            validatedAmountKobo,

                        currency:
                            normalizedCurrency,

                        balanceBeforeKobo:
                            currentBalanceKobo,

                        balanceAfterKobo:
                            newBalanceKobo,

                        createdAt:
                            now

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

        reference:
            normalizedReference,

        amountKobo:
            validatedAmountKobo,

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