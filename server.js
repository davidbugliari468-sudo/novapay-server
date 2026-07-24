require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { db, admin } = require("./firebase-admin");
const {
    getAccessToken,
    CONTRACT_CODE,
    BASE_URL
} = require("./monnify");

console.log("BASE_URL:", BASE_URL);
console.log("CONTRACT_CODE:", CONTRACT_CODE);

const app = express();

app.use(cors());
app.use(express.json());

/*
|--------------------------------------------------------------------------
| Home Route
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "NovaPay Backend is running 🚀"
    });

});

/*
|--------------------------------------------------------------------------
| Create Payment
|--------------------------------------------------------------------------
*/

app.post("/api/create-payment", async (req, res) => {

    try {

        const {
            amount,
            customerName,
            customerEmail,
            uid
        } = req.body;

        if (!amount || !customerName || !customerEmail || !uid) {

            return res.status(400).json({
                success: false,
                message: "Missing required fields."
            });

        }

        const accessToken = await getAccessToken();

        const paymentReference = uuidv4();

        await db.collection("paymentReferences")
            .doc(paymentReference)
            .set({
                uid,
                customerEmail,
                amount: Number(amount),
                status: "PENDING",
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

        const response = await axios.post(

            `${BASE_URL}/api/v1/merchant/transactions/init-transaction`,

            {
                amount: Number(amount),
                customerName,
                customerEmail,
                paymentReference,
                paymentDescription: "NovaPay Wallet Funding",
                currencyCode: "NGN",
                contractCode: CONTRACT_CODE,
                redirectUrl: "https://example.com/payment-success",
                paymentMethods: [
                    "CARD",
                    "ACCOUNT_TRANSFER",
                    "USSD"
                ]
            },

            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }

        );

        return res.json({
            success: true,
            paymentReference,
            checkoutUrl: response.data.responseBody.checkoutUrl
        });

    } catch (error) {

        console.error(error.response?.data || error.message);

        return res.status(500).json({
            success: false,
            message: JSON.stringify(
                error.response?.data || error.message,
                null,
                2
            )
        });

    }

});

/*
|--------------------------------------------------------------------------
| Verify Payment
|--------------------------------------------------------------------------
*/

app.post("/api/verify-payment", async (req, res) => {

    try {

        const { paymentReference } = req.body;

        if (!paymentReference) {

            return res.status(400).json({
                success: false,
                message: "Payment reference is required."
            });

        }

        const accessToken = await getAccessToken();

        const response = await axios.get(

            `${BASE_URL}/api/v2/transactions/${paymentReference}`,

            {
                headers: {
                    Authorization: `Bearer ${accessToken}`
                }
            }

        );

        const transaction = response.data.responseBody;

        if (transaction.paymentStatus === "PAID") {

            return res.json({
                success: true,
                transaction
            });

        }

        return res.json({
            success: false,
            message: "Payment not completed.",
            transaction
        });

    } catch (error) {

        console.error(error.response?.data || error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to verify payment."
        });

    }

});

/*
|--------------------------------------------------------------------------
| Monnify Webhook
|--------------------------------------------------------------------------
*/

app.post("/api/monnify/webhook", async (req, res) => {

    try {

        console.log("========================================");
        console.log("MONNIFY WEBHOOK RECEIVED");
        console.log(JSON.stringify(req.body, null, 2));
        console.log("========================================");

        const { eventType, eventData } = req.body;

        if (eventType !== "SUCCESSFUL_TRANSACTION") {
            return res.status(200).send("IGNORED");
        }

        if (!eventData || eventData.paymentStatus !== "PAID") {
            return res.status(200).send("IGNORED");
        }

        const paymentReference = eventData.paymentReference;

        console.log("Webhook paymentReference:", paymentReference);

        const paymentDoc = await db
            .collection("paymentReferences")
            .doc(paymentReference)
            .get();

        console.log("Payment doc exists:", paymentDoc.exists);

        if (!paymentDoc.exists) {

            console.log("Payment reference not found.");

            return res.status(200).send("NOT FOUND");

        }

        const paymentData = paymentDoc.data();

        console.log("Payment data:", paymentData);

        if (paymentData.status === "COMPLETED") {

            console.log("Payment already processed.");

            return res.status(200).send("ALREADY PROCESSED");

        }

        const uid = paymentData.uid;

        console.log("UID:", uid);

        const amount = Number(eventData.amountPaid);

        const userRef = db.collection("users").doc(uid);

        const userDoc = await userRef.get();

        console.log("User exists:", userDoc.exists);

        if (!userDoc.exists) {

            console.log("User not found.");

            return res.status(200).send("USER NOT FOUND");

        }

        const userData = userDoc.data();

        const currentBalance =
            Number(userData.walletBalance || 0);

        const newBalance =
            currentBalance + amount;

        await userRef.update({

            walletBalance: newBalance,

            updatedAt:
                admin.firestore.FieldValue.serverTimestamp()

        });

        await paymentDoc.ref.update({

            status: "COMPLETED",

            completedAt:
                admin.firestore.FieldValue.serverTimestamp(),

            transactionReference:
                eventData.transactionReference

        });

        await db.collection("transactions").add({

            uid,

            type: "DEPOSIT",

            amount,

            status: "SUCCESS",

            paymentReference,

            transactionReference:
                eventData.transactionReference,

            paymentMethod:
                eventData.paymentMethod,

            createdAt:
                admin.firestore.FieldValue.serverTimestamp()

        });

        console.log("Wallet updated successfully.");

        return res.status(200).send("OK");

    } catch (error) {

        console.error("WEBHOOK ERROR:", error);

        return res.status(500).send("Webhook Error");

    }

});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {

    console.log(`🚀 NovaPay Backend running on port ${PORT}`);

});