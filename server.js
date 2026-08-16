// ==========================================
// NOVAPAY BACKEND V2
// Secure Render + Firebase + Monnify + VTU
// ==========================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const {
    db,
    admin,
    verifyFirebaseToken
} = require("./firebase-admin");

const {
    getAccessToken,
    CONTRACT_CODE,
    BASE_URL
} = require("./monnify");

const {
    getVTUToken,
    VTU_BASE_URL
} = require("./vtu");

const app = express();

const PORT =
    process.env.PORT || 10000;

// ==========================================
// BASIC CONFIGURATION
// ==========================================

// Temporary CORS configuration.
// We can restrict this to NovaPay's exact
// domain after testing.
app.use(cors());

// Preserve raw request body because the
// Monnify webhook signature is calculated
// from the original request body.
app.use(
    express.json({
        limit: "1mb",

        verify: (req, res, buffer) => {
            req.rawBody = buffer;
        }
    })
);

// ==========================================
// GENERAL HELPERS
// ==========================================

function normalizeAmount(value) {

    const amount = Number(value);

    if (!Number.isFinite(amount)) {
        return 0;
    }

    return Number(amount.toFixed(2));
}

function isValidAmount(value) {

    const amount = Number(value);

    return (
        Number.isFinite(amount) &&
        amount > 0 &&
        amount <= 100000000
    );
}

function safeProviderError(error) {

    console.error(
        "Provider error:",
        error?.response?.data ||
        error?.message ||
        error
    );
}

// ==========================================
// MONNIFY WEBHOOK SIGNATURE
// ==========================================

function verifyMonnifySignature(req) {

    const receivedSignature =
        req.headers["monnify-signature"];

    const secret =
        process.env.MONNIFY_SECRET_KEY;

    if (
        !receivedSignature ||
        !secret ||
        !req.rawBody
    ) {
        return false;
    }

    const expectedSignature =
        crypto
            .createHmac(
                "sha512",
                secret
            )
            .update(req.rawBody)
            .digest("hex");

    try {

        const received =
            Buffer.from(
                String(receivedSignature),
                "utf8"
            );

        const expected =
            Buffer.from(
                expectedSignature,
                "utf8"
            );

        if (
            received.length !==
            expected.length
        ) {
            return false;
        }

        return crypto.timingSafeEqual(
            received,
            expected
        );

    } catch (error) {

        return false;
    }
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        message:
            "NovaPay Backend V2 is running 🚀"
    });
});

app.get("/health", (req, res) => {

    res.status(200).json({

        success: true,

        status: "healthy",

        service:
            "NovaPay Backend V2"

    });
});

// ==========================================
// CREATE MONNIFY PAYMENT
// ==========================================

app.post(
    "/api/create-payment",
    verifyFirebaseToken,
    async (req, res) => {

        try {

            const {
                amount
            } = req.body;

            // ------------------------------
            // Validate amount
            // ------------------------------

            if (!isValidAmount(amount)) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid payment amount."

                });
            }

            const paymentAmount =
                normalizeAmount(amount);

            // ------------------------------
            // AUTHENTICATED USER
            // ------------------------------

            const uid =
                req.uid;

            const customerEmail =
                req.user.email;

            const customerName =
                req.user.name ||
                req.user.email ||
                "NovaPay User";

            if (
                !uid ||
                !customerEmail
            ) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Authenticated user information is incomplete."

                });
            }

            // ------------------------------
            // CREATE UNIQUE REFERENCE
            // ------------------------------

            const paymentReference =
                `NP-${crypto.randomUUID()}`;

            // ------------------------------
            // SAVE PAYMENT BEFORE CHECKOUT
            // ------------------------------

            await db
                .collection(
                    "paymentReferences"
                )
                .doc(paymentReference)
                .set({

                    uid,

                    customerEmail,

                    customerName,

                    amount:
                        paymentAmount,

                    status:
                        "PENDING",

                    createdAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()

                });

            // ------------------------------
            // MONNIFY ACCESS TOKEN
            // ------------------------------

            const accessToken =
                await getAccessToken();

            // ------------------------------
            // CREATE MONNIFY TRANSACTION
            // ------------------------------

            const response =
                await axios.post(

                    `${BASE_URL}/api/v1/merchant/transactions/init-transaction`,

                    {

                        amount:
                            paymentAmount,

                        customerName,

                        customerEmail,

                        paymentReference,

                        paymentDescription:
                            "NovaPay Wallet Funding",

                        currencyCode:
                            "NGN",

                        contractCode:
                            CONTRACT_CODE,

                        redirectUrl:
                            "https://davidbugliari468-sudo.github.io/NovaPay/payment-success.html",

                        paymentMethods: [

                            "CARD",

                            "ACCOUNT_TRANSFER",

                            "USSD"

                        ]

                    },

                    {

                        headers: {

                            Authorization:
                                `Bearer ${accessToken}`

                        },

                        timeout: 15000

                    }
                );

            const checkoutUrl =
                response.data
                    ?.responseBody
                    ?.checkoutUrl;

            if (!checkoutUrl) {

                await db
                    .collection(
                        "paymentReferences"
                    )
                    .doc(paymentReference)
                    .update({

                        status:
                            "FAILED",

                        failureReason:
                            "Checkout URL was not returned.",

                        updatedAt:
                            admin.firestore
                                .FieldValue
                                .serverTimestamp()

                    });

                return res.status(502).json({

                    success: false,

                    message:
                        "Unable to create payment."

                });
            }

            return res.json({

                success: true,

                paymentReference,

                checkoutUrl

            });

        } catch (error) {

            safeProviderError(error);

            return res.status(502).json({

                success: false,

                message:
                    "Unable to create payment right now. Please try again."

            });
        }
    }
);

// ==========================================
// VERIFY MONNIFY PAYMENT
// ==========================================

app.post(
    "/api/verify-payment",
    verifyFirebaseToken,
    async (req, res) => {

        try {

            const {
                paymentReference
            } = req.body;

            if (
                !paymentReference ||
                typeof paymentReference !==
                    "string"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Payment reference is required."

                });
            }

            // ------------------------------
            // FIND OUR PAYMENT
            // ------------------------------

            const paymentRef =
                db
                    .collection(
                        "paymentReferences"
                    )
                    .doc(paymentReference);

            const paymentDoc =
                await paymentRef.get();

            if (!paymentDoc.exists) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Payment not found."

                });
            }

            const paymentData =
                paymentDoc.data();

            // ------------------------------
            // OWNERSHIP CHECK
            // ------------------------------

            if (
                paymentData.uid !==
                req.uid
            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        "You are not authorized to access this payment."

                });
            }

            // ------------------------------
            // ALREADY COMPLETED
            // ------------------------------

            if (
                paymentData.status ===
                "COMPLETED"
            ) {

                return res.json({

                    success: true,

                    paymentReference,

                    paymentStatus:
                        "PAID",

                    alreadyProcessed:
                        true

                });
            }

            // ------------------------------
            // VERIFY WITH MONNIFY
            // ------------------------------

            const accessToken =
                await getAccessToken();

            const response =
                await axios.get(

                    `${BASE_URL}/api/v2/transactions/${paymentReference}`,

                    {

                        headers: {

                            Authorization:
                                `Bearer ${accessToken}`

                        },

                        timeout: 15000

                    }
                );

            const transaction =
                response.data
                    ?.responseBody;

            if (!transaction) {

                return res.status(502).json({

                    success: false,

                    message:
                        "Unable to verify payment."

                });
            }

            const paidAmount =
                normalizeAmount(
                    transaction.amountPaid
                );

            const expectedAmount =
                normalizeAmount(
                    paymentData.amount
                );

            // ------------------------------
            // PAYMENT MUST BE PAID
            // AND AMOUNT MUST MATCH
            // ------------------------------

            if (
                transaction.paymentStatus ===
                    "PAID" &&
                paidAmount ===
                    expectedAmount
            ) {

                return res.json({

                    success: true,

                    paymentReference,

                    paymentStatus:
                        "PAID",

                    transaction

                });
            }

            return res.json({

                success: false,

                paymentReference,

                paymentStatus:
                    transaction.paymentStatus,

                message:
                    "Payment has not been completed."

            });

        } catch (error) {

            safeProviderError(error);

            return res.status(502).json({

                success: false,

                message:
                    "Unable to verify payment right now."

            });
        }
    }
);

// ==========================================
// MONNIFY WEBHOOK
// ==========================================
//
// This route is called by Monnify.
// Firebase authentication is NOT used here.
//
// Instead we verify Monnify's signature.
// ==========================================

app.post(
    "/api/monnify/webhook",
    async (req, res) => {

        try {

            // ------------------------------
            // VERIFY WEBHOOK SIGNATURE
            // ------------------------------

            if (
                !verifyMonnifySignature(req)
            ) {

                console.warn(
                    "Rejected Monnify webhook: invalid signature."
                );

                return res
                    .status(401)
                    .send(
                        "Invalid signature"
                    );
            }

            const {
                eventType,
                eventData
            } = req.body;

            // ------------------------------
            // ONLY PROCESS SUCCESS EVENTS
            // ------------------------------

            if (
                eventType !==
                "SUCCESSFUL_TRANSACTION"
            ) {

                return res
                    .status(200)
                    .send("IGNORED");
            }

            if (
                !eventData ||
                eventData.paymentStatus !==
                    "PAID"
            ) {

                return res
                    .status(200)
                    .send("IGNORED");
            }

            const paymentReference =
                eventData.paymentReference;

            if (!paymentReference) {

                return res
                    .status(400)
                    .send(
                        "Missing payment reference"
                    );
            }

            const paymentRef =
                db
                    .collection(
                        "paymentReferences"
                    )
                    .doc(paymentReference);

            // ------------------------------
            // ATOMIC PAYMENT PROCESSING
            // ------------------------------

            await db.runTransaction(
                async (transaction) => {

                    const paymentDoc =
                        await transaction.get(
                            paymentRef
                        );

                    if (
                        !paymentDoc.exists
                    ) {

                        throw new Error(
                            "PAYMENT_NOT_FOUND"
                        );
                    }

                    const paymentData =
                        paymentDoc.data();

                    // --------------------------
                    // DUPLICATE PROTECTION
                    // --------------------------

                    if (
                        paymentData.status ===
                        "COMPLETED"
                    ) {

                        return;
                    }

                    // --------------------------
                    // VERIFY AMOUNT
                    // --------------------------

                    const expectedAmount =
                        normalizeAmount(
                            paymentData.amount
                        );

                    const paidAmount =
                        normalizeAmount(
                            eventData.amountPaid
                        );

                    if (
                        paidAmount !==
                        expectedAmount
                    ) {

                        throw new Error(
                            "AMOUNT_MISMATCH"
                        );
                    }

                    const uid =
                        paymentData.uid;

                    if (!uid) {

                        throw new Error(
                            "USER_MISSING"
                        );
                    }

                    const userRef =
                        db
                            .collection("users")
                            .doc(uid);

                    const userDoc =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !userDoc.exists
                    ) {

                        throw new Error(
                            "USER_NOT_FOUND"
                        );
                    }

                    const userData =
                        userDoc.data();

                    const currentBalance =
                        normalizeAmount(
                            userData.walletBalance ||
                            0
                        );

                    const newBalance =
                        normalizeAmount(
                            currentBalance +
                            paidAmount
                        );

                    // --------------------------
                    // CREDIT WALLET
                    // --------------------------

                    transaction.update(
                        userRef,
                        {

                            walletBalance:
                                newBalance,

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        }
                    );

                    // --------------------------
                    // MARK PAYMENT COMPLETED
                    // --------------------------

                    transaction.update(
                        paymentRef,
                        {

                            status:
                                "COMPLETED",

                            amountPaid:
                                paidAmount,

                            transactionReference:
                                eventData
                                    .transactionReference,

                            paymentMethod:
                                eventData
                                    .paymentMethod,

                            completedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        }
                    );

                    // --------------------------
                    // CREATE DETERMINISTIC
                    // DEPOSIT TRANSACTION
                    // --------------------------

                    const depositRef =
                        db
                            .collection(
                                "transactions"
                            )
                            .doc(
                                `deposit_${paymentReference}`
                            );

                    transaction.set(
                        depositRef,
                        {

                            uid,

                            type:
                                "DEPOSIT",

                            amount:
                                paidAmount,

                            status:
                                "SUCCESS",

                            paymentReference,

                            transactionReference:
                                eventData
                                    .transactionReference,

                            paymentMethod:
                                eventData
                                    .paymentMethod,

                            createdAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        },
                        {
                            merge: false
                        }
                    );
                }
            );

            return res
                .status(200)
                .send("OK");

        } catch (error) {

            if (
                error.message ===
                "PAYMENT_NOT_FOUND"
            ) {

                return res
                    .status(200)
                    .send("NOT FOUND");
            }

            if (
                error.message ===
                "AMOUNT_MISMATCH"
            ) {

                console.error(
                    "Monnify payment amount mismatch."
                );

                return res
                    .status(400)
                    .send(
                        "Amount mismatch"
                    );
            }

            if (
                error.message ===
                "USER_NOT_FOUND"
            ) {

                return res
                    .status(200)
                    .send(
                        "USER NOT FOUND"
                    );
            }

            console.error(
                "MONNIFY WEBHOOK ERROR:",
                error.message
            );

            return res
                .status(500)
                .send(
                    "Webhook Error"
                );
        }
    }
);

// ==========================================
// BUY AIRTIME
// ==========================================
//
// IMPORTANT:
//
// We reserve/debit the user's wallet BEFORE
// calling the provider.
//
// If the provider response is unknown,
// we keep the transaction PENDING instead
// of automatically refunding.
//
// This prevents us from accidentally giving
// airtime and refunding the user when the
// provider actually completed the purchase.
//
// A reconciliation system can resolve
// PENDING transactions later.
// ==========================================

app.post(
    "/api/buy-airtime",
    verifyFirebaseToken,
    async (req, res) => {

        let transactionId = null;
        let userRef = null;

        try {

            const {
                phone,
                network,
                amount
            } = req.body;

            const cleanPhone =
                String(phone || "")
                    .trim();

            const cleanNetwork =
                String(network || "")
                    .trim()
                    .toLowerCase();

            const purchaseAmount =
                normalizeAmount(amount);

            // ------------------------------
            // VALIDATE PHONE
            // ------------------------------

            if (
                !/^0\d{10}$/.test(
                    cleanPhone
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Enter a valid Nigerian phone number."

                });
            }

            // ------------------------------
            // VALIDATE NETWORK
            // ------------------------------

            const allowedNetworks = [
                "mtn",
                "glo",
                "airtel",
                "9mobile"
            ];

            if (
                !allowedNetworks.includes(
                    cleanNetwork
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Unsupported network."

                });
            }

            // ------------------------------
            // VALIDATE AMOUNT
            // ------------------------------

            if (
                !isValidAmount(
                    purchaseAmount
                ) ||
                purchaseAmount < 50
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Minimum airtime amount is ₦50."

                });
            }

            const uid =
                req.uid;

            userRef =
                db
                    .collection("users")
                    .doc(uid);

            // ------------------------------
            // CREATE UNIQUE REFERENCE
            // ------------------------------

            transactionId =
                `airtime_${crypto.randomUUID()}`;

            // ------------------------------
            // RESERVE WALLET FUNDS
            // ------------------------------

            await db.runTransaction(
                async (transaction) => {

                    const userDoc =
                        await transaction.get(
                            userRef
                        );

                    if (
                        !userDoc.exists
                    ) {

                        throw new Error(
                            "USER_NOT_FOUND"
                        );
                    }

                    const userData =
                        userDoc.data();

                    const balance =
                        normalizeAmount(
                            userData.walletBalance ||
                            0
                        );

                    if (
                        balance <
                        purchaseAmount
                    ) {

                        throw new Error(
                            "INSUFFICIENT_BALANCE"
                        );
                    }

                    const newBalance =
                        normalizeAmount(
                            balance -
                            purchaseAmount
                        );

                    // --------------------------
                    // DEBIT WALLET
                    // --------------------------

                    transaction.update(
                        userRef,
                        {

                            walletBalance:
                                newBalance,

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        }
                    );

                    // --------------------------
                    // CREATE PENDING TRANSACTION
                    // --------------------------

                    const transactionRef =
                        db
                            .collection(
                                "transactions"
                            )
                            .doc(
                                transactionId
                            );

                    transaction.set(
                        transactionRef,
                        {

                            uid,

                            type:
                                "AIRTIME",

                            network:
                                cleanNetwork,

                            phone:
                                cleanPhone,

                            amount:
                                purchaseAmount,

                            status:
                                "PENDING",

                            reference:
                                transactionId,

                            provider:
                                "VTU.ng",

                            createdAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        }
                    );
                }
            );

            // ------------------------------
            // CALL VTU PROVIDER
            // ------------------------------

            const token =
                await getVTUToken();

            const providerResponse =
                await axios.post(

                    `${VTU_BASE_URL}/api/v2/airtime`,

                    {

                        request_id:
                            transactionId,

                        phone:
                            cleanPhone,

                        service_id:
                            cleanNetwork,

                        amount:
                            purchaseAmount

                    },

                    {

                        headers: {

                            Authorization:
                                `Bearer ${token}`,

                            "Content-Type":
                                "application/json"

                        },

                        timeout: 20000

                    }
                );

            const result =
                providerResponse.data;

            // ------------------------------
            // PROVIDER SUCCESS
            // ------------------------------

            if (
                result?.code ===
                "success"
            ) {

                await db.runTransaction(
                    async (transaction) => {

                        const transactionRef =
                            db
                                .collection(
                                    "transactions"
                                )
                                .doc(
                                    transactionId
                                );

                        const transactionDoc =
                            await transaction.get(
                                transactionRef
                            );

                        if (
                            !transactionDoc.exists
                        ) {

                            throw new Error(
                                "TRANSACTION_NOT_FOUND"
                            );
                        }

                        const transactionData =
                            transactionDoc.data();

                        /*
                         * Idempotency:
                         * if already successful,
                         * don't process again.
                         */
                        if (
                            transactionData.status ===
                            "SUCCESS"
                        ) {

                            return;
                        }

                        transaction.update(
                            transactionRef,
                            {

                                status:
                                    "SUCCESS",

                                providerResponse:
                                    {
                                        code:
                                            result.code
                                    },

                                completedAt:
                                    admin.firestore
                                        .FieldValue
                                        .serverTimestamp()

                            }
                        );
                    }
                );

                /*
                 * Wallet was already safely
                 * reserved before provider call.
                 *
                 * Return success.
                 */
                const latestUser =
                    await userRef.get();

                const latestBalance =
                    normalizeAmount(
                        latestUser.data()
                            ?.walletBalance || 0
                    );

                return res.json({

                    success: true,

                    message:
                        "Airtime purchase successful.",

                    walletBalance:
                        latestBalance,

                    reference:
                        transactionId

                });
            }

            // ------------------------------
            // UNKNOWN / NON-SUCCESS RESPONSE
            // ------------------------------
            //
            // We DO NOT automatically refund here.
            //
            // We don't have enough information from
            // the provider module to safely classify
            // every non-success response as a final
            // failure.
            //
            // Keep the transaction PENDING for
            // reconciliation.
            // ------------------------------

            await db
                .collection("transactions")
                .doc(transactionId)
                .update({

                    status:
                        "PENDING",

                    providerResponse:
                        {
                            code:
                                result?.code ||
                                null
                        },

                    updatedAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()

                });

            return res.status(202).json({

                success: false,

                pending: true,

                message:
                    "Your airtime request is being processed. Please check your transaction history shortly.",

                reference:
                    transactionId

            });

        } catch (error) {

            // ------------------------------
            // USER NOT FOUND
            // ------------------------------

            if (
                error.message ===
                "USER_NOT_FOUND"
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "User account not found."

                });
            }

            // ------------------------------
            // INSUFFICIENT BALANCE
            // ------------------------------

            if (
                error.message ===
                "INSUFFICIENT_BALANCE"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Insufficient wallet balance."

                });
            }

            /*
             * IMPORTANT:
             *
             * If transactionId exists, the wallet
             * may already have been reserved.
             *
             * We DO NOT automatically refund here
             * because the provider request may have
             * reached VTU before a timeout/error.
             *
             * Keep it PENDING for reconciliation.
             */
            if (
                transactionId
            ) {

                try {

                    await db
                        .collection(
                            "transactions"
                        )
                        .doc(transactionId)
                        .update({

                            status:
                                "PENDING",

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        });

                } catch (
                    transactionUpdateError
                ) {

                    console.error(
                        "Unable to mark transaction pending:",
                        transactionUpdateError.message
                    );
                }

                safeProviderError(error);

                return res.status(202).json({

                    success: false,

                    pending: true,

                    message:
                        "Your airtime request is being processed. Please check your transaction history shortly.",

                    reference:
                        transactionId

                });
            }

            safeProviderError(error);

            return res.status(500).json({

                success: false,

                message:
                    "Unable to complete airtime purchase."

            });
        }
    }
);

// ==========================================
// VTU PROVIDER BALANCE
// ==========================================
//
// Authentication required.
// The provider token is NEVER returned.
// ==========================================

app.get(
    "/api/vtu/wallet",
    verifyFirebaseToken,
    async (req, res) => {

        try {

            const token =
                await getVTUToken();

            const response =
                await axios.get(

                    `${VTU_BASE_URL}/api/v2/balance`,

                    {

                        headers: {

                            Authorization:
                                `Bearer ${token}`

                        },

                        timeout: 15000

                    }
                );

            return res.json(
                response.data
            );

        } catch (error) {

            safeProviderError(error);

            return res.status(502).json({

                success: false,

                message:
                    "Unable to retrieve provider balance."

            });
        }
    }
);

// ==========================================
// START SERVER
// ==========================================

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 NovaPay Backend V2 running on port ${PORT}`
        );

    }
);