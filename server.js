require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const {
    getAccessToken,
    CONTRACT_CODE,
    BASE_URL
} = require("./monnify");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "NovaPay Backend is running 🚀"
    });

});

app.post("/api/create-payment", async (req, res) => {

    try {

        const { amount, customerName, customerEmail } = req.body;

        if (!amount || !customerName || !customerEmail) {

            return res.status(400).json({
                success: false,
                message: "Missing required fields."
            });

        }

        const accessToken = await getAccessToken();

        const paymentReference = uuidv4();

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

        res.json({
            success: true,
            paymentReference,
            checkoutUrl:
                response.data.responseBody.checkoutUrl
        });

    } catch (error) {

        console.error(error.response?.data || error.message);

        res.status(500).json({
            success: false,
            message: "Unable to create payment."
        });

    }

});
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

        res.status(500).json({
            success: false,
            message: "Unable to verify payment."
        });
    }
});
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {

    console.log(`NovaPay running on port ${PORT}`);

});