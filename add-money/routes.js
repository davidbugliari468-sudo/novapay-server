// add-money/routes.js

const express = require("express");
const crypto = require("crypto");

const { requireAuth } = require("../auth");
const { db } = require("../firebase-admin");

const paymentProvider =
    require("./paystack/provider");

const router = express.Router();


// =====================================================
// CONFIGURATION
// =====================================================

const MINIMUM_DEPOSIT_NAIRA = 100;

const MAXIMUM_DEPOSIT_NAIRA = 5000000;


// =====================================================
// MONEY → KOBO
// =====================================================

function nairaToKobo(
    amount
) {

    const numericAmount =
        Number(amount);


    if (
        !Number.isFinite(
            numericAmount
        )
    ) {

        return null;

    }


    const kobo =
        Math.round(
            numericAmount * 100
        );


    if (
        !Number.isSafeInteger(
            kobo
        )
    ) {

        return null;

    }


    return kobo;

}


// =====================================================
// UNIQUE DEPOSIT REFERENCE
// =====================================================

function createDepositReference(
    uid
) {

    const uidPart =
        String(uid)
            .replace(
                /[^a-zA-Z0-9]/g,
                ""
            )
            .slice(
                0,
                12
            );


    const randomPart =
        crypto
            .randomBytes(12)
            .toString("hex");


    return (
        `NPDEP_${uidPart}_${Date.now()}_${randomPart}`
    );

}


// =====================================================
// POST /api/add-money/create
// =====================================================
//
// Creates a pending deposit and then requests
// temporary transfer account details from Paystack.
//
// =====================================================

router.post(
    "/create",
    requireAuth,
    async (req, res) => {

        try {

            const uid =
                req.user.uid;


            // -----------------------------------------
            // READ AMOUNT
            // -----------------------------------------

            const amount =
                Number(
                    req.body.amount
                );


            // -----------------------------------------
            // VALIDATE AMOUNT
            // -----------------------------------------

            if (
                !Number.isFinite(
                    amount
                )
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Please enter a valid amount.",

                    requestId:
                        req.requestId

                });

            }


            if (
                amount < MINIMUM_DEPOSIT_NAIRA
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        `Minimum deposit is ₦${MINIMUM_DEPOSIT_NAIRA.toLocaleString("en-NG")}.`,

                    requestId:
                        req.requestId

                });

            }


            if (
                amount > MAXIMUM_DEPOSIT_NAIRA
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        `Maximum deposit is ₦${MAXIMUM_DEPOSIT_NAIRA.toLocaleString("en-NG")}.`,

                    requestId:
                        req.requestId

                });

            }


            const amountKobo =
                nairaToKobo(
                    amount
                );


            if (
                amountKobo === null ||
                amountKobo <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid payment amount.",

                    requestId:
                        req.requestId

                });

            }


            // -----------------------------------------
            // GET USER
            // -----------------------------------------

            const userRef =
                db
                    .collection("users")
                    .doc(uid);


            const userSnapshot =
                await userRef.get();


            if (
                !userSnapshot.exists
            ) {

                return res.status(404).json({

                    success: false,

                    error:
                        "User account could not be found.",

                    requestId:
                        req.requestId

                });

            }


            const userData =
                userSnapshot.data();


            const email =
                String(
                    userData.email ||
                    req.user.email ||
                    ""
                )
                    .trim()
                    .toLowerCase();


            if (
                !email
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "A valid email address is required for this payment.",

                    requestId:
                        req.requestId

                });

            }


            // -----------------------------------------
            // CREATE UNIQUE REFERENCE
            // -----------------------------------------

            const reference =
                createDepositReference(
                    uid
                );


            const depositRef =
                db
                    .collection("deposits")
                    .doc(reference);


            // -----------------------------------------
            // CREATE PENDING DEPOSIT
            // -----------------------------------------
            //
            // IMPORTANT:
            //
            // Balance is NOT changed here.
            //
            // This is only a pending deposit record.
            //
            // -----------------------------------------

            await depositRef.create({

                uid,

                reference,

                provider:
                    "paystack",

                amountNaira:
                    amount,

                amountKobo,

                currency:
                    "NGN",

                status:
                    "pending",

                type:
                    "wallet_deposit",

                createdAt:
                    new Date(),

                updatedAt:
                    new Date(),

                creditedAt:
                    null

            });


            // -----------------------------------------
            // CREATE PAYSTACK PAYMENT
            // -----------------------------------------

            let payment;

            try {

                payment =
    await paymentProvider
        .createPaymentSession({

                            email,

                            amount:
                                amountKobo,

                            reference

                        });

            }

            catch (providerError) {

                // -------------------------------------
                // MARK FAILED
                // -------------------------------------

                await depositRef.update({

                    status:
                        "provider_error",

                    providerError:
                        providerError.message,

                    updatedAt:
                        new Date()

                });


                throw providerError;

            }


            // -----------------------------------------
            // SAVE PROVIDER DETAILS
            // -----------------------------------------

            await depositRef.update({

                providerReference:
                    payment.reference ||
                    reference,

                providerStatus:
                    payment.status ||
                    "pending_bank_transfer",

                accountName:
                    payment.accountName ||
                    null,

                accountNumber:
                    payment.accountNumber ||
                    null,

                bankName:
                    payment.bankName ||
                    null,

                bankCode:
                    payment.bankCode ||
                    null,

                accountExpiresAt:
                    payment.accountExpiresAt ||
                    null,

                updatedAt:
                    new Date()

            });


            // -----------------------------------------
            // RETURN PAYMENT DETAILS
            // -----------------------------------------

            return res.status(201).json({

                success: true,

                message:
                    "Transfer account created successfully.",

                deposit: {

                    reference,

                    amount,

                    currency:
                        "NGN",

                    status:
                        "pending",

                    accountName:
                        payment.accountName ||
                        null,

                    accountNumber:
                        payment.accountNumber ||
                        null,

                    bankName:
                        payment.bankName ||
                        null,

                    accountExpiresAt:
                        payment.accountExpiresAt ||
                        null

                },

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay Add Money creation error:",
                error
            );


            return res.status(500).json({

                success: false,

                error:
                    "Unable to create your transfer payment.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// GET /api/add-money/status/:reference
// =====================================================
//
// Returns the current state of a deposit.
//
// This endpoint does NOT credit the wallet.
//
// Wallet crediting will be handled separately with
// idempotency protection.
// =====================================================

router.get(
    "/status/:reference",
    requireAuth,
    async (req, res) => {

        try {

            const uid =
                req.user.uid;


            const reference =
                String(
                    req.params.reference ||
                    ""
                )
                    .trim();


            if (
                !reference
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Deposit reference is required.",

                    requestId:
                        req.requestId

                });

            }


            const depositRef =
                db
                    .collection("deposits")
                    .doc(reference);


            const depositSnapshot =
                await depositRef.get();


            if (
                !depositSnapshot.exists
            ) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Deposit not found.",

                    requestId:
                        req.requestId

                });

            }


            const deposit =
                depositSnapshot.data();


            // -----------------------------------------
            // NEVER expose another user's deposit
            // -----------------------------------------

            if (
                deposit.uid !== uid
            ) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Deposit not found.",

                    requestId:
                        req.requestId

                });

            }


            return res.status(200).json({

                success: true,

                deposit: {

                    reference,

                    amountNaira:
                        deposit.amountNaira,

                    currency:
                        deposit.currency ||
                        "NGN",

                    status:
                        deposit.status,

                    accountName:
                        deposit.accountName ||
                        null,

                    accountNumber:
                        deposit.accountNumber ||
                        null,

                    bankName:
                        deposit.bankName ||
                        null,

                    accountExpiresAt:
                        deposit.accountExpiresAt ||
                        null,

                    createdAt:
                        deposit.createdAt ||
                        null,

                    creditedAt:
                        deposit.creditedAt ||
                        null

                },

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay Add Money status error:",
                error
            );


            return res.status(500).json({

                success: false,

                error:
                    "Unable to retrieve deposit status.",

                requestId:
                    req.requestId

            });

        }

    }
);


module.exports = router;