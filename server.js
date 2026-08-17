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
            //
            // IMPORTANT:
            // This endpoint ONLY verifies.
            //
            // It does NOT credit the wallet.
            //
            // The Monnify webhook is responsible
            // for the authoritative wallet credit.
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
//
// IMPORTANT:
// The webhook is the authoritative place where
// a successful Monnify payment credits the wallet.
//
// /api/verify-payment NEVER credits the wallet.
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


            if (
                error.message ===
                "USER_MISSING"
            ) {

                console.error(
                    "Monnify payment has no associated user."
                );

                return res
                    .status(500)
                    .send(
                        "User missing"
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
// 1. Authenticate Firebase user.
// 2. Validate request.
// 3. Check wallet balance.
// 4. Debit wallet atomically.
// 5. Create PENDING transaction.
// 6. Call VTU provider.
//
// The provider is called ONLY AFTER the wallet
// debit succeeds.
//
// If provider result is uncertain, transaction
// remains PENDING.
//
// The reconciliation worker added later will
// check VTU.ng and resolve the transaction.
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
                    // CREATE PENDING
                    // TRANSACTION
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
            // STORE PROVIDER RESPONSE
            // ------------------------------

            await db
                .collection(
                    "transactions"
                )
                .doc(transactionId)
                .update({

                    providerResponse:
                        result || null,

                    updatedAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()

                });


            // ------------------------------
            // IMPORTANT
            // ------------------------------
            //
            // DO NOT mark SUCCESS merely because
            // VTU returned:
            //
            //     code: "success"
            //
            // VTU can return success while the
            // order is still processing.
            //
            // The next section of the rebuilt
            // backend will inspect the provider
            // status and only finalize the purchase
            // when the provider confirms completion.
            //
            // Otherwise the transaction remains
            // PENDING for reconciliation.
            // ------------------------------


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


            // ------------------------------
            // PROVIDER ERROR
            // ------------------------------
            //
            // IMPORTANT:
            // The wallet was already debited and
            // the transaction is already PENDING.
            //
            // We DO NOT refund here because we do
            // not yet know whether VTU processed
            // the order.
            //
            // The reconciliation worker will
            // requery VTU using transactionId.
            // ------------------------------

            safeProviderError(error);


            if (transactionId) {

                try {

                    await db
                        .collection(
                            "transactions"
                        )
                        .doc(transactionId)
                        .update({

                            status:
                                "PENDING",

                            providerError:
                                error?.response?.data ||
                                error?.message ||
                                "Provider request failed",

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        });

                } catch (
                    updateError
                ) {

                    console.error(
                        "Unable to update pending airtime transaction:",
                        updateError
                    );

                }

            }


            return res.status(202).json({

                success: false,

                pending: true,

                message:
                    "Your airtime request is being processed. Please check your transaction history shortly.",

                reference:
                    transactionId

            });

        }

    }
); 
// ==========================================
// AUTOMATIC AIRTIME RECONCILIATION
// ==========================================
//
// Purpose:
//
// A user's wallet is debited BEFORE the VTU
// provider is called.
//
// If the provider does not give us a definite
// final result, the NovaPay transaction remains
// PENDING.
//
// This worker periodically asks VTU.ng for the
// actual order status using the original
// request_id.
//
// FINAL SUCCESS:
//     completed-api
//
// FINAL FAILURE / REFUND:
//     refunded
//     failed
//     cancelled
//
// STILL PROCESSING:
//     processing-api
//     queued-api
//     initiated-api
//     pending
//     on-hold
//
// We NEVER refund merely because a request
// timed out or because requery temporarily fails.
// ==========================================


const RECONCILIATION_INTERVAL_MS =
    60 * 1000;


const RECONCILIATION_START_DELAY_MS =
    10 * 1000;


const RECONCILIATION_BATCH_SIZE =
    25;


// ==========================================
// PROVIDER STATUS HELPERS
// ==========================================

function getProviderOrderStatus(
    providerResponse
) {

    const status =
        providerResponse
            ?.data
            ?.status;

    return String(
        status || ""
    )
        .trim()
        .toLowerCase();

}


function isProviderSuccessStatus(
    status
) {

    return (
        status ===
        "completed-api"
    );

}


function isProviderFailureStatus(
    status
) {

    return [

        "refunded",

        "failed",

        "cancelled"

    ].includes(status);

}


function isProviderStillProcessingStatus(
    status
) {

    return [

        "processing-api",

        "queued-api",

        "initiated-api",

        "pending",

        "on-hold"

    ].includes(status);

}


// ==========================================
// RECONCILE ONE AIRTIME TRANSACTION
// ==========================================

async function reconcileAirtimeTransaction(
    transactionId,
    transactionData,
    providerToken
) {

    try {

        // --------------------------------------
        // The reference used when the order was
        // sent to VTU.ng.
        //
        // We store the same value in `reference`.
        // --------------------------------------

        const requestId =
            transactionData.reference ||
            transactionId;


        if (!requestId) {

            console.error(
                "Cannot reconcile Airtime transaction without request_id:",
                transactionId
            );

            return;

        }


        // --------------------------------------
        // REQUERY VTU
        // --------------------------------------

        const response =
            await axios.post(

                `${VTU_BASE_URL}/api/v2/requery`,

                {
                    request_id:
                        requestId
                },

                {

                    headers: {

                        Authorization:
                            `Bearer ${providerToken}`,

                        "Content-Type":
                            "application/json"

                    },

                    timeout: 15000

                }

            );


        const providerResult =
            response.data;


        const providerStatus =
            getProviderOrderStatus(
                providerResult
            );


        console.log(
            `Airtime reconciliation ${transactionId}: ${providerStatus || "UNKNOWN"}`
        );


        // ======================================
        // SUCCESS
        // ======================================

        if (
            isProviderSuccessStatus(
                providerStatus
            )
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

                        return;

                    }


                    const currentTransaction =
                        transactionDoc.data();


                    // --------------------------------
                    // IDEMPOTENCY
                    //
                    // If another process already
                    // completed it, do nothing.
                    // --------------------------------

                    if (
                        currentTransaction.status !==
                        "PENDING"
                    ) {

                        return;

                    }


                    transaction.update(
                        transactionRef,
                        {

                            status:
                                "SUCCESS",

                            providerResponse:
                                providerResult,

                            completedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp(),

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        }
                    );

                }
            );


            console.log(
                `Airtime transaction ${transactionId} reconciled as SUCCESS.`
            );


            return;

        }


        // ======================================
        // FAILURE / REFUND
        // ======================================

        if (
            isProviderFailureStatus(
                providerStatus
            )
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

                        return;

                    }


                    const currentTransaction =
                        transactionDoc.data();


                    // --------------------------------
                    // DOUBLE-REFUND PROTECTION
                    //
                    // Only a still-PENDING
                    // transaction can be refunded.
                    // --------------------------------

                    if (
                        currentTransaction.status !==
                        "PENDING"
                    ) {

                        return;

                    }


                    const uid =
                        currentTransaction.uid;


                    if (!uid) {

                        throw new Error(
                            "Airtime transaction has no user UID."
                        );

                    }


                    const userRef =
                        db
                            .collection(
                                "users"
                            )
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


                    // --------------------------------
                    // IMPORTANT:
                    //
                    // NovaPay originally debited the
                    // FULL amount from the user's wallet.
                    //
                    // Therefore we return the FULL
                    // amount when the provider confirms
                    // that the order failed/refunded.
                    // --------------------------------

                    const refundAmount =
                        normalizeAmount(
                            currentTransaction.amount
                        );


                    const newBalance =
                        normalizeAmount(
                            currentBalance +
                            refundAmount
                        );


                    // --------------------------------
                    // REFUND WALLET
                    // --------------------------------

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


                    // --------------------------------
                    // MARK TRANSACTION FAILED
                    // --------------------------------

                    transaction.update(
                        transactionRef,
                        {

                            status:
                                "FAILED",

                            providerResponse:
                                providerResult,

                            refundAmount,

                            refundedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp(),

                            updatedAt:
                                admin.firestore
                                    .FieldValue
                                    .serverTimestamp()

                        }
                    );


                }
            );


            console.log(
                `Airtime transaction ${transactionId} reconciled as FAILED and refunded.`
            );


            return;

        }


        // ======================================
        // STILL PROCESSING
        // ======================================

        if (
            isProviderStillProcessingStatus(
                providerStatus
            )
        ) {

            await db
                .collection(
                    "transactions"
                )
                .doc(transactionId)
                .update({

                    status:
                        "PENDING",

                    providerResponse:
                        providerResult,

                    updatedAt:
                        admin.firestore
                            .FieldValue
                            .serverTimestamp()

                });


            return;

        }


        // ======================================
        // UNKNOWN PROVIDER STATUS
        // ======================================
        //
        // Do NOT refund.
        //
        // Keep PENDING and try again during
        // the next reconciliation cycle.
        // ======================================

        console.warn(
            `Unknown VTU status for ${transactionId}:`,
            providerStatus
        );


        await db
            .collection(
                "transactions"
            )
            .doc(transactionId)
            .update({

                status:
                    "PENDING",

                providerResponse:
                    providerResult,

                updatedAt:
                    admin.firestore
                        .FieldValue
                        .serverTimestamp()

            });


    } catch (error) {

        // --------------------------------------
        // IMPORTANT:
        //
        // A requery failure is NOT proof that
        // the Airtime order failed.
        //
        // Therefore:
        //
        // NO REFUND.
        // NO SUCCESS.
        //
        // Leave it PENDING and try again later.
        // --------------------------------------

        console.error(
            `Airtime reconciliation failed for ${transactionId}:`,
            error?.response?.data ||
            error?.message ||
            error
        );

    }

}


// ==========================================
// RUN AIRTIME RECONCILIATION
// ==========================================

async function runAirtimeReconciliation() {

    try {

        console.log(
            "🔄 Starting Airtime reconciliation cycle..."
        );


        // --------------------------------------
        // GET VTU TOKEN ONCE FOR THIS CYCLE
        // --------------------------------------

        const providerToken =
            await getVTUToken();


        // --------------------------------------
        // FIND PENDING AIRTIME TRANSACTIONS
        // --------------------------------------

        const snapshot =
            await db
                .collection(
                    "transactions"
                )
                .where(
                    "type",
                    "==",
                    "AIRTIME"
                )
                .where(
                    "status",
                    "==",
                    "PENDING"
                )
                .limit(
                    RECONCILIATION_BATCH_SIZE
                )
                .get();


        if (
            snapshot.empty
        ) {

            console.log(
                "🔄 No pending Airtime transactions to reconcile."
            );

            return;

        }


        console.log(
            `🔄 Found ${snapshot.size} pending Airtime transaction(s).`
        );


        // --------------------------------------
        // PROCESS EACH TRANSACTION
        // --------------------------------------

        for (
            const document
            of snapshot.docs
        ) {

            const transactionId =
                document.id;


            const transactionData =
                document.data();


            await reconcileAirtimeTransaction(

                transactionId,

                transactionData,

                providerToken

            );

        }


        console.log(
            "✅ Airtime reconciliation cycle completed."
        );


    } catch (error) {

        console.error(
            "AIRTIME RECONCILIATION ERROR:",
            error?.response?.data ||
            error?.message ||
            error
        );

    }

}


// ==========================================
// START RECONCILIATION WORKER
// ==========================================
//
// Wait briefly after server startup so Render
// has time to finish starting the application.
//
// Then run once immediately and every 60 seconds.
// ==========================================

setTimeout(
    async () => {

        await runAirtimeReconciliation();


        setInterval(
            runAirtimeReconciliation,
            RECONCILIATION_INTERVAL_MS
        );

    },

    RECONCILIATION_START_DELAY_MS
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
// SECURE TRANSACTION HISTORY
// ==========================================
//
// Security:
// - Firebase authentication is required.
// - UID comes ONLY from the verified Firebase
//   token.
// - Frontend does NOT provide a UID.
// - Backend returns ONLY transactions belonging
//   to the authenticated user.
//
// Query:
//   GET /api/transactions?limit=50
//
// Maximum:
//   100 transactions per request.
// ==========================================

app.get(
    "/api/transactions",
    verifyFirebaseToken,
    async (req, res) => {

        try {

            // --------------------------------------
            // AUTHENTICATED USER
            // --------------------------------------

            const uid =
                req.uid;


            if (!uid) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Authentication required."

                });

            }


            // --------------------------------------
            // SAFE LIMIT
            // --------------------------------------

            let limit =
                Number(
                    req.query.limit || 50
                );


            if (
                !Number.isInteger(limit)
            ) {

                limit = 50;

            }


            limit =
                Math.min(
                    Math.max(
                        limit,
                        1
                    ),
                    100
                );


            // --------------------------------------
            // QUERY ONLY THIS USER
            // --------------------------------------

            const snapshot =
                await db
                    .collection(
                        "transactions"
                    )
                    .where(
                        "uid",
                        "==",
                        uid
                    )
                    .limit(
                        limit
                    )
                    .get();


            // --------------------------------------
            // BUILD RESPONSE
            // --------------------------------------

            const transactions = [];


            snapshot.forEach(
                (doc) => {

                    transactions.push({

                        id:
                            doc.id,

                        ...doc.data()

                    });

                }
            );


            // --------------------------------------
            // NEWEST FIRST
            // --------------------------------------

            transactions.sort(
                (a, b) => {

                    const getTime =
                        (transaction) => {

                            const timestamp =
                                transaction.completedAt ||
                                transaction.createdAt;


                            if (!timestamp) {

                                return 0;

                            }


                            if (
                                typeof timestamp.toMillis ===
                                "function"
                            ) {

                                return timestamp.toMillis();

                            }


                            if (
                                typeof timestamp.toDate ===
                                "function"
                            ) {

                                return timestamp
                                    .toDate()
                                    .getTime();

                            }


                            if (
                                timestamp.seconds !==
                                undefined
                            ) {

                                return (
                                    timestamp.seconds *
                                    1000
                                );

                            }


                            const date =
                                new Date(
                                    timestamp
                                );


                            return isNaN(
                                date.getTime()
                            )
                                ? 0
                                : date.getTime();

                        };


                    return (
                        getTime(b) -
                        getTime(a)
                    );

                }
            );


            // --------------------------------------
            // SUCCESS
            // --------------------------------------

            return res.json({

                success: true,

                count:
                    transactions.length,

                transactions

            });


        } catch (error) {

            console.error(
                "TRANSACTION HISTORY ERROR:",
                error?.message ||
                error
            );


            return res.status(500).json({

                success: false,

                message:
                    "Unable to load transaction history."

            });

        }

    }
);


// ==========================================
// START SERVER
// ==========================================
//
// IMPORTANT:
// All routes and background workers are
// registered BEFORE app.listen().
// ==========================================

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 NovaPay Backend V3 running on port ${PORT}`
        );

        console.log(
            `BASE_URL: ${BASE_URL}`
        );

        console.log(
            `CONTRACT_CODE: ${CONTRACT_CODE}`
        );

        console.log(
            "🔐 Secure transaction history enabled."
        );

        console.log(
            "🔄 Automatic Airtime reconciliation enabled."
        );

    }
);