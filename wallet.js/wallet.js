// wallet/wallet.js

const crypto = require("crypto");

const { db } = require("../firebase-admin");


// =====================================================
// NOVAPAY WALLET
// =====================================================
//
// Backend-authoritative wallet.
//
// Money is stored in KOBO.
//
// IMPORTANT:
//
// - Frontend never changes wallet balance.
// - Every balance-changing operation creates a ledger entry.
// - Airtime funds are RESERVED before provider fulfillment.
// - Pending Airtime transactions keep their reservation.
// - Failed Airtime transactions can be refunded exactly once.
// - Successful Airtime transactions remain permanently debited.
// - All balance-changing operations use Firestore transactions.
// =====================================================


// =====================================================
// COLLECTIONS
// =====================================================

const WALLETS_COLLECTION = "wallets";

const LEDGER_SUBCOLLECTION = "ledger";

const AIRTIME_RESERVATIONS_COLLECTION =
    "airtimeReservations";


// =====================================================
// CONSTANTS
// =====================================================

const DEFAULT_CURRENCY = "NGN";

const DEPOSIT_TYPE = "deposit";

const CREDIT_DIRECTION = "credit";

const DEBIT_DIRECTION = "debit";

const SUCCESSFUL_STATUS = "successful";

const PENDING_STATUS = "pending";

const REFUNDED_STATUS = "refunded";

const AIRTIME_RESERVATION_TYPE =
    "airtime_reservation";

const AIRTIME_DEBIT_TYPE =
    "airtime";

const AIRTIME_REFUND_TYPE =
    "airtime_refund";


// =====================================================
// WALLET REFERENCE
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
// LEDGER REFERENCE
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
// AIRTIME RESERVATION REFERENCE
// =====================================================

function getAirtimeReservationRef(
    uid,
    reservationId
) {

    if (
        typeof reservationId !== "string" ||
        !reservationId.trim()
    ) {

        throw new Error(
            "Airtime reservation ID is required."
        );

    }

    return db
        .collection(
            AIRTIME_RESERVATIONS_COLLECTION
        )
        .doc(reservationId);

}


// =====================================================
// CREATE DETERMINISTIC DEPOSIT LEDGER ID
// =====================================================

function createDepositLedgerId(
    reference
) {

    const normalizedReference =
        String(reference)
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
// ENSURE WALLET
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
                .trim()
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

                const walletSnapshot =
                    await transaction.get(
                        walletRef
                    );


                const ledgerSnapshot =
                    await transaction.get(
                        ledgerRef
                    );


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


                const now =
                    new Date();


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
// RESERVE AIRTIME FUNDS
// =====================================================
//
// IMPORTANT:
//
// This operation does NOT call VTU.
//
// It only protects the user's money.
//
// The wallet balance is reduced immediately and an
// Airtime reservation is created atomically.
//
// If the provider later returns:
// SUCCESS → reservation is finalized.
// FAILURE → reservation is refunded.
// UNKNOWN → reservation remains pending.
// =====================================================

async function reserveAirtimeFunds({
    uid,
    transactionId,
    amountKobo,
    phoneNumber,
    network,
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


    const normalizedTransactionId =
        String(
            transactionId || ""
        )
            .trim();


    if (!normalizedTransactionId) {

        throw new Error(
            "Airtime transaction ID is required."
        );

    }


    const validatedAmountKobo =
        validateAmountKobo(
            amountKobo
        );


    const normalizedPhoneNumber =
        String(
            phoneNumber || ""
        )
            .trim();


    const normalizedNetwork =
        String(
            network || ""
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


    const reservationRef =
        getAirtimeReservationRef(
            uid,
            normalizedTransactionId
        );


    const ledgerId =
        crypto
            .createHash("sha256")
            .update(
                `airtime:${uid}:${normalizedTransactionId}`
            )
            .digest("hex");


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


                const reservationSnapshot =
                    await transaction.get(
                        reservationRef
                    );


                const ledgerSnapshot =
                    await transaction.get(
                        ledgerRef
                    );


                if (
                    reservationSnapshot.exists
                ) {

                    const existing =
                        reservationSnapshot.data();


                    return {

                        duplicate:
                            true,

                        transactionId:
                            normalizedTransactionId,

                        status:
                            existing.status,

                        balanceKobo:
                            existing.balanceAfterKobo,

                        amountKobo:
                            existing.amountKobo

                    };

                }


                if (
                    ledgerSnapshot.exists
                ) {

                    throw new Error(
                        "Airtime transaction already has a wallet ledger entry."
                    );

                }


                let currentBalanceKobo =
                    0;


                let walletCurrency =
                    DEFAULT_CURRENCY;


                if (
                    walletSnapshot.exists
                ) {

                    const wallet =
                        walletSnapshot.data();


                    currentBalanceKobo =
                        validateBalanceKobo(
                            wallet.balanceKobo
                        );


                    walletCurrency =
                        String(
                            wallet.currency ||
                            DEFAULT_CURRENCY
                        )
                            .trim()
                            .toUpperCase();

                }


                if (
                    walletCurrency !==
                    normalizedCurrency
                ) {

                    throw new Error(
                        "Wallet currency mismatch."
                    );

                }


                if (
                    currentBalanceKobo <
                    validatedAmountKobo
                ) {

                    throw new Error(
                        "Insufficient wallet balance."
                    );

                }


                const newBalanceKobo =
                    currentBalanceKobo -
                    validatedAmountKobo;


                if (
                    newBalanceKobo < 0
                ) {

                    throw new Error(
                        "Wallet balance cannot become negative."
                    );

                }


                const now =
                    new Date();


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


                transaction.create(
                    ledgerRef,
                    {

                        uid,

                        type:
                            AIRTIME_RESERVATION_TYPE,

                        direction:
                            DEBIT_DIRECTION,

                        status:
                            PENDING_STATUS,

                        reference:
                            normalizedTransactionId,

                        amountKobo:
                            validatedAmountKobo,

                        currency:
                            normalizedCurrency,

                        balanceBeforeKobo:
                            currentBalanceKobo,

                        balanceAfterKobo:
                            newBalanceKobo,

                        phoneNumber:
                            normalizedPhoneNumber,

                        network:
                            normalizedNetwork,

                        createdAt:
                            now

                    }
                );


                transaction.create(
                    reservationRef,
                    {

                        uid,

                        transactionId:
                            normalizedTransactionId,

                        amountKobo:
                            validatedAmountKobo,

                        currency:
                            normalizedCurrency,

                        phoneNumber:
                            normalizedPhoneNumber,

                        network:
                            normalizedNetwork,

                        status:
                            PENDING_STATUS,

                        balanceBeforeKobo:
                            currentBalanceKobo,

                        balanceAfterKobo:
                            newBalanceKobo,

                        createdAt:
                            now,

                        updatedAt:
                            now

                    }
                );


                return {

                    duplicate:
                        false,

                    transactionId:
                        normalizedTransactionId,

                    status:
                        PENDING_STATUS,

                    balanceKobo:
                        newBalanceKobo,

                    amountKobo:
                        validatedAmountKobo

                };

            }
        );


    return {

        uid,

        transactionId:
            result.transactionId,

        amountKobo:
            result.amountKobo,

        status:
            result.status,

        duplicate:
            result.duplicate,

        balanceKobo:
            result.balanceKobo

    };

}


// =====================================================
// FINALIZE AIRTIME SUCCESS
// =====================================================
//
// The user's wallet has already been debited.
//
// Therefore SUCCESS does NOT debit the wallet again.
//
// It changes the reservation and corresponding ledger
// state to successful.
// =====================================================

async function finalizeAirtimeSuccess({
    uid,
    transactionId,
    provider,
    providerReference
}) {

    const normalizedTransactionId =
        String(
            transactionId || ""
        )
            .trim();


    if (!normalizedTransactionId) {

        throw new Error(
            "Airtime transaction ID is required."
        );

    }


    const reservationRef =
        getAirtimeReservationRef(
            uid,
            normalizedTransactionId
        );


    const ledgerId =
        crypto
            .createHash("sha256")
            .update(
                `airtime:${uid}:${normalizedTransactionId}`
            )
            .digest("hex");


    const ledgerRef =
        getLedgerRef(
            uid,
            ledgerId
        );


    return db.runTransaction(
        async transaction => {

            const reservationSnapshot =
                await transaction.get(
                    reservationRef
                );


            const ledgerSnapshot =
                await transaction.get(
                    ledgerRef
                );


            if (
                !reservationSnapshot.exists
            ) {

                throw new Error(
                    "Airtime reservation not found."
                );

            }


            const reservation =
                reservationSnapshot.data();


            if (
                reservation.status ===
                SUCCESSFUL_STATUS
            ) {

                return {

                    alreadyFinalized:
                        true,

                    status:
                        SUCCESSFUL_STATUS

                };

            }


            if (
                reservation.status !==
                PENDING_STATUS
            ) {

                throw new Error(
                    "Airtime transaction cannot be finalized from its current state."
                );

            }


            if (
                !ledgerSnapshot.exists
            ) {

                throw new Error(
                    "Airtime wallet ledger entry not found."
                );

            }


            const now =
                new Date();


            transaction.update(
                reservationRef,
                {

                    status:
                        SUCCESSFUL_STATUS,

                    provider:
                        String(
                            provider ||
                            "unknown"
                        )
                            .trim()
                            .toLowerCase(),

                    providerReference:
                        providerReference
                            ? String(
                                providerReference
                            ).trim()
                            : null,

                    updatedAt:
                        now,

                    completedAt:
                        now

                }
            );


            transaction.update(
                ledgerRef,
                {

                    type:
                        AIRTIME_DEBIT_TYPE,

                    status:
                        SUCCESSFUL_STATUS,

                    provider:
                        String(
                            provider ||
                            "unknown"
                        )
                            .trim()
                            .toLowerCase(),

                    providerReference:
                        providerReference
                            ? String(
                                providerReference
                            ).trim()
                            : null,

                    updatedAt:
                        now,

                    completedAt:
                        now

                }
            );


            return {

                alreadyFinalized:
                    false,

                status:
                    SUCCESSFUL_STATUS

            };

        }
    );

}


// =====================================================
// REFUND AIRTIME
// =====================================================
//
// Used ONLY after the provider definitively confirms
// that Airtime was not delivered.
//
// Refund is idempotent.
//
// A second refund attempt does nothing.
// =====================================================

async function refundAirtimeFunds({
    uid,
    transactionId,
    reason,
    provider,
    providerReference
}) {

    const normalizedTransactionId =
        String(
            transactionId || ""
        )
            .trim();


    if (!normalizedTransactionId) {

        throw new Error(
            "Airtime transaction ID is required."
        );

    }


    const reservationRef =
        getAirtimeReservationRef(
            uid,
            normalizedTransactionId
        );


    const ledgerId =
        crypto
            .createHash("sha256")
            .update(
                `airtime:${uid}:${normalizedTransactionId}`
            )
            .digest("hex");


    const originalLedgerRef =
        getLedgerRef(
            uid,
            ledgerId
        );


    const refundLedgerId =
        crypto
            .createHash("sha256")
            .update(
                `airtime-refund:${uid}:${normalizedTransactionId}`
            )
            .digest("hex");


    const refundLedgerRef =
        getLedgerRef(
            uid,
            refundLedgerId
        );


    const walletRef =
        getWalletRef(uid);


    return db.runTransaction(
        async transaction => {

            const reservationSnapshot =
                await transaction.get(
                    reservationRef
                );


            const walletSnapshot =
                await transaction.get(
                    walletRef
                );


            const originalLedgerSnapshot =
                await transaction.get(
                    originalLedgerRef
                );


            const refundLedgerSnapshot =
                await transaction.get(
                    refundLedgerRef
                );


            if (
                !reservationSnapshot.exists
            ) {

                throw new Error(
                    "Airtime reservation not found."
                );

            }


            const reservation =
                reservationSnapshot.data();


            if (
                reservation.status ===
                REFUNDED_STATUS
            ) {

                return {

                    alreadyRefunded:
                        true,

                    status:
                        REFUNDED_STATUS,

                    balanceKobo:
                        validateBalanceKobo(
                            walletSnapshot.data()
                                ?.balanceKobo
                        )

                };

            }


            if (
                reservation.status ===
                SUCCESSFUL_STATUS
            ) {

                throw new Error(
                    "Successful Airtime cannot be refunded through the failure path."
                );

            }


            if (
                !originalLedgerSnapshot.exists
            ) {

                throw new Error(
                    "Original Airtime ledger entry not found."
                );

            }


            if (
                refundLedgerSnapshot.exists
            ) {

                throw new Error(
                    "Airtime refund already exists."
                );

            }


            if (
                !walletSnapshot.exists
            ) {

                throw new Error(
                    "Wallet not found."
                );

            }


            const wallet =
                walletSnapshot.data();


            const currentBalanceKobo =
                validateBalanceKobo(
                    wallet.balanceKobo
                );


            const amountKobo =
                validateAmountKobo(
                    reservation.amountKobo
                );


            const newBalanceKobo =
                currentBalanceKobo +
                amountKobo;


            if (
                !Number.isSafeInteger(
                    newBalanceKobo
                )
            ) {

                throw new Error(
                    "Refund would exceed supported wallet balance."
                );

            }


            const now =
                new Date();


            transaction.update(
                walletRef,
                {

                    balanceKobo:
                        newBalanceKobo,

                    updatedAt:
                        now

                }
            );


            transaction.update(
                reservationRef,
                {

                    status:
                        REFUNDED_STATUS,

                    refundReason:
                        String(
                            reason ||
                            "Provider confirmed failure."
                        ).trim(),

                    provider:
                        provider
                            ? String(
                                provider
                            ).trim().toLowerCase()
                            : null,

                    providerReference:
                        providerReference
                            ? String(
                                providerReference
                            ).trim()
                            : null,

                    updatedAt:
                        now,

                    refundedAt:
                        now

                }
            );


            transaction.update(
                originalLedgerRef,
                {

                    status:
                        REFUNDED_STATUS,

                    updatedAt:
                        now

                }
            );


            transaction.create(
                refundLedgerRef,
                {

                    uid,

                    type:
                        AIRTIME_REFUND_TYPE,

                    direction:
                        CREDIT_DIRECTION,

                    status:
                        REFUNDED_STATUS,

                    reference:
                        `${normalizedTransactionId}:refund`,

                    originalTransactionId:
                        normalizedTransactionId,

                    amountKobo,

                    currency:
                        String(
                            reservation.currency ||
                            DEFAULT_CURRENCY
                        )
                            .trim()
                            .toUpperCase(),

                    balanceBeforeKobo:
                        currentBalanceKobo,

                    balanceAfterKobo:
                        newBalanceKobo,

                    provider:
                        provider
                            ? String(
                                provider
                            ).trim().toLowerCase()
                            : null,

                    providerReference:
                        providerReference
                            ? String(
                                providerReference
                            ).trim()
                            : null,

                    reason:
                        String(
                            reason ||
                            "Provider confirmed failure."
                        ).trim(),

                    createdAt:
                        now

                }
            );


            return {

                alreadyRefunded:
                    false,

                status:
                    REFUNDED_STATUS,

                balanceKobo:
                    newBalanceKobo,

                amountKobo

            };

        }
    );

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    ensureWallet,

    getWallet,

    creditDeposit,

    reserveAirtimeFunds,

    finalizeAirtimeSuccess,

    refundAirtimeFunds

};