// =====================================================
// NovaPay Add Money Routes
// Secure Paystack Version
// =====================================================

const express = require("express");
const crypto = require("crypto");

const { requireAuth } = require("../auth");
const { db } = require("../firebase-admin");

const paymentProvider =
    require("./paystack/provider");

const router =
    express.Router();


// =====================================================
// CONFIGURATION
// =====================================================

const MINIMUM_DEPOSIT_NAIRA = 100;

const MAXIMUM_DEPOSIT_NAIRA = 5000000;


// =====================================================
// MONEY → KOBO
// =====================================================

function nairaToKobo(amount) {

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

function createDepositReference(uid) {

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
// Creates a pending wallet deposit.
//
// IMPORTANT:
//
// This route does NOT credit the wallet.
//
// Wallet crediting happens only after a verified
// Paystack payment/webhook event.
//
// =====================================================

router.post(
    "/create",
    requireAuth,
    async (req, res) => {

        let depositRef = null;

        try {

            // -----------------------------------------
            // AUTHENTICATED USER
            // -----------------------------------------

            const uid =
                req.user.uid;


            if (!uid) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Authentication required.",

                    requestId:
                        req.requestId

                });

            }


            // -----------------------------------------
            // READ AMOUNT
            // -----------------------------------------

            const amount =
                Number(
                    req.body?.amount
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


            // -----------------------------------------
            // CONVERT TO KOBO
            // -----------------------------------------

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
            // GET USER PROFILE
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
                userSnapshot.data() || {};


            // -----------------------------------------
            // PAYMENT EMAIL
            // -----------------------------------------

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


            depositRef =
                db
                    .collection("deposits")
                    .doc(reference);


            // -----------------------------------------
            // CREATE PENDING DEPOSIT
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

                console.error(
                    "NovaPay Paystack provider error:",
                    {

                        message:
                            providerError?.message,

                        status:
                            providerError?.status,

                        response:
                            providerError?.response,

                        stack:
                            providerError?.stack

                    }
                );


                // -------------------------------------
                // MARK DEPOSIT AS FAILED
                // -------------------------------------

                await depositRef.update({

                    status:
                        "provider_error",

                    providerError:
                        String(
                            providerError?.message ||
                            "Paystack provider error."
                        )
                            .slice(
                                0,
                                500
                            ),

                    providerStatusCode:
                        providerError?.status ||
                        null,

                    updatedAt:
                        new Date()

                });


                // -------------------------------------
                // RETURN SAFE ERROR TO FRONTEND
                // -------------------------------------

                const statusCode =
                    Number(
                        providerError?.status
                    );


                const safeStatus =
                    Number.isInteger(
                        statusCode
                    ) &&
                    statusCode >= 400 &&
                    statusCode < 500
                        ? statusCode
                        : 502;


                return res.status(
                    safeStatus
                ).json({

                    success: false,

                    error:
                        providerError?.message ||
                        "Paystack payment service is unavailable.",

                    requestId:
                        req.requestId

                });

            }


            // -----------------------------------------
            // VALIDATE PAYMENT RESPONSE
            // -----------------------------------------

            if (
                !payment ||
                !payment.accountNumber ||
                !payment.accountName ||
                !payment.bankName
            ) {

                console.error(
                    "NovaPay invalid Paystack payment response:",
                    payment
                );


                await depositRef.update({

                    status:
                        "provider_error",

                    providerError:
                        "Paystack did not return valid transfer account details.",

                    updatedAt:
                        new Date()

                });


                return res.status(502).json({

                    success: false,

                    error:
                        "Paystack did not return valid transfer account details.",

                    requestId:
                        req.requestId

                });

            }


            // -----------------------------------------
            // SAVE PAYSTACK DETAILS
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
            // SUCCESS
            // -----------------------------------------

            return res.status(201).json({

                success: true,

                message:
                    "Transfer account created successfully.",

                deposit: {

                    reference,

                    amount,

                    amountNaira:
                        amount,

                    amountKobo,

                    currency:
                        "NGN",

                    status:
                        "pending",

                    accountName:
                        payment.accountName,

                    accountNumber:
                        payment.accountNumber,

                    bankName:
                        payment.bankName,

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
                {

                    message:
                        error?.message,

                    status:
                        error?.status,

                    response:
                        error?.response,

                    stack:
                        error?.stack

                }
            );


            // -----------------------------------------
            // TRY TO MARK DEPOSIT AS FAILED
            // -----------------------------------------

            if (
                depositRef
            ) {

                try {

                    await depositRef.update({

                        status:
                            "provider_error",

                        providerError:
                            String(
                                error?.message ||
                                "Unknown payment error."
                            )
                                .slice(
                                    0,
                                    500
                                ),

                        updatedAt:
                            new Date()

                    });

                }

                catch (updateError) {

                    console.error(
                        "Failed to update deposit after error:",
                        updateError
                    );

                }

            }


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
// Returns the status of a user's own deposit.
//
// This endpoint NEVER credits the wallet.
//
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
                depositSnapshot.data() || {};


            // -----------------------------------------
            // USER OWNERSHIP CHECK
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


            // -----------------------------------------
            // RETURN STATUS
            // -----------------------------------------

            return res.status(200).json({

                success: true,

                deposit: {

                    reference,

                    amountNaira:
                        deposit.amountNaira,

                    amountKobo:
                        deposit.amountKobo,

                    currency:
                        deposit.currency ||
                        "NGN",

                    status:
                        deposit.status ||
                        "pending",

                    provider:
                        deposit.provider ||
                        "paystack",

                    providerReference:
                        deposit.providerReference ||
                        null,

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

                    updatedAt:
                        deposit.updatedAt ||
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


// =====================================================
// EXPORT
// =====================================================

module.exports =
    router;