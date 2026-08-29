// add-money/paystack/webhook.js

const crypto = require("crypto");

const { db } = require("../../firebase-admin");
const {
    creditDeposit
} = require("../../wallet.js/wallet");

const paystackProvider =
    require("./provider");


// =====================================================
// PAYSTACK WEBHOOK
// =====================================================
//
// This endpoint receives payment notifications from
// Paystack.
//
// IMPORTANT:
// The wallet is NEVER credited simply because a webhook
// arrived.
//
// We:
// 1. Verify the Paystack signature.
// 2. Confirm the event is successful.
// 3. Verify the transaction directly with Paystack.
// 4. Find the matching NovaPay deposit.
// 5. Check the amount and currency.
// 6. Credit the wallet through wallet.js.
//
// wallet.creditDeposit() provides idempotency protection.
// =====================================================


// =====================================================
// VERIFY PAYSTACK SIGNATURE
// =====================================================

function verifyPaystackSignature(
    req
) {

    const secretKey =
        String(
            process.env.PAYSTACK_SECRET_KEY ||
            ""
        ).trim();


    if (!secretKey) {

        throw new Error(
            "PAYSTACK_SECRET_KEY is not configured."
        );
    }


    const signature =
        req.headers[
            "x-paystack-signature"
        ];


    if (!signature) {

        return false;
    }


    if (!req.rawBody) {

        throw new Error(
            "Raw webhook body is unavailable."
        );
    }


    const expectedSignature =
        crypto
            .createHmac(
                "sha512",
                secretKey
            )
            .update(
                req.rawBody
            )
            .digest(
                "hex"
            );


    const receivedBuffer =
        Buffer.from(
            String(signature),
            "utf8"
        );


    const expectedBuffer =
        Buffer.from(
            expectedSignature,
            "utf8"
        );


    if (
        receivedBuffer.length !==
        expectedBuffer.length
    ) {

        return false;
    }


    return crypto.timingSafeEqual(
        receivedBuffer,
        expectedBuffer
    );
}


// =====================================================
// WEBHOOK HANDLER
// =====================================================

async function handlePaystackWebhook(
    req,
    res
) {

    try {

        // ---------------------------------------------
        // SIGNATURE
        // ---------------------------------------------

        const validSignature =
            verifyPaystackSignature(
                req
            );


        if (!validSignature) {

            return res.status(401).json({

                success: false,

                error:
                    "Invalid webhook signature."

            });

        }


        const event =
            req.body;


        // ---------------------------------------------
        // ONLY PROCESS SUCCESSFUL CHARGES
        // ---------------------------------------------

        if (
            event?.event !==
            "charge.success"
        ) {

            return res.status(200).json({

                success: true,

                message:
                    "Event received."

            });

        }


        const transaction =
            event.data;


        if (!transaction) {

            return res.status(400).json({

                success: false,

                error:
                    "Webhook transaction data is missing."

            });

        }


        const reference =
            String(
                transaction.reference ||
                ""
            ).trim();


        if (!reference) {

            return res.status(400).json({

                success: false,

                error:
                    "Payment reference is missing."

            });

        }


        // ---------------------------------------------
        // FIND NOVAPAY DEPOSIT
        // ---------------------------------------------

        const depositRef =
            db
                .collection("deposits")
                .doc(reference);


        const depositSnapshot =
            await depositRef.get();


        if (
            !depositSnapshot.exists
        ) {

            /*
             * Do not credit an unknown transaction.
             *
             * Return 200 so Paystack does not repeatedly
             * retry an event that NovaPay cannot match.
             */

            console.error(
                "Paystack webhook deposit not found:",
                reference
            );


            return res.status(200).json({

                success: true,

                message:
                    "Payment received but no matching NovaPay deposit was found."

            });

        }


        const deposit =
            depositSnapshot.data();


        // ---------------------------------------------
        // BASIC DEPOSIT VALIDATION
        // ---------------------------------------------

        if (
            !deposit.uid
        ) {

            console.error(
                "Deposit has no user ID:",
                reference
            );


            return res.status(200).json({

                success: true,

                message:
                    "Deposit record is invalid."

            });

        }


        if (
            deposit.status ===
            "credited"
        ) {

            /*
             * Already credited.
             *
             * This also makes repeated webhooks safe.
             */

            return res.status(200).json({

                success: true,

                message:
                    "Deposit already credited."

            });

        }


        // ---------------------------------------------
        // VERIFY DIRECTLY WITH PAYSTACK
        // ---------------------------------------------

        const verifiedPayment =
            await paystackProvider
                .verifyPayment(
                    reference
                );


        // ---------------------------------------------
        // PAYMENT MUST BE SUCCESSFUL
        // ---------------------------------------------

        if (
            verifiedPayment.status !==
            "success"
        ) {

            return res.status(200).json({

                success: true,

                message:
                    "Payment is not successful."

            });

        }


        // ---------------------------------------------
        // VERIFY CURRENCY
        // ---------------------------------------------

        if (
            String(
                verifiedPayment.currency ||
                ""
            ).toUpperCase() !==
            String(
                deposit.currency ||
                "NGN"
            ).toUpperCase()
        ) {

            console.error(
                "Payment currency mismatch:",
                reference
            );


            return res.status(200).json({

                success: true,

                message:
                    "Payment currency mismatch."

            });

        }


        // ---------------------------------------------
        // VERIFY AMOUNT
        // ---------------------------------------------

        const verifiedAmountKobo =
            Number(
                verifiedPayment.amount
            );


        const depositAmountKobo =
            Number(
                deposit.amountKobo
            );


        if (
            !Number.isSafeInteger(
                verifiedAmountKobo
            ) ||
            !Number.isSafeInteger(
                depositAmountKobo
            )
        ) {

            console.error(
                "Invalid payment amount:",
                reference
            );


            return res.status(200).json({

                success: true,

                message:
                    "Invalid payment amount."

            });

        }


        if (
            verifiedAmountKobo !==
            depositAmountKobo
        ) {

            console.error(
                "Payment amount mismatch:",
                {
                    reference,
                    expected:
                        depositAmountKobo,
                    received:
                        verifiedAmountKobo
                }
            );


            return res.status(200).json({

                success: true,

                message:
                    "Payment amount mismatch."

            });

        }


        // ---------------------------------------------
        // CREDIT WALLET
        // ---------------------------------------------

        const creditResult =
            await creditDeposit({

                uid:
                    deposit.uid,

                reference,

                amountKobo:
                    depositAmountKobo,

                provider:
                    "paystack"

            });


        // ---------------------------------------------
        // MARK DEPOSIT AS CREDITED
        // ---------------------------------------------

        if (
            creditResult.credited ||
            creditResult.duplicate
        ) {

            await depositRef.update({

                status:
                    "credited",

                providerStatus:
                    "success",

                providerReference:
                    verifiedPayment.reference,

                paidAt:
                    verifiedPayment.paidAt
                        ? new Date(
                            verifiedPayment.paidAt
                        )
                        : new Date(),

                creditedAt:
                    new Date(),

                updatedAt:
                    new Date()

            });

        }


        // ---------------------------------------------
        // SUCCESS
        // ---------------------------------------------

        return res.status(200).json({

            success: true,

            credited:
                creditResult.credited,

            duplicate:
                creditResult.duplicate,

            reference

        });

    }

    catch (error) {

        console.error(
            "Paystack webhook processing error:",
            error
        );


        /*
         * Return 500 when NovaPay could not safely
         * finish processing the payment.
         *
         * Paystack can retry the webhook.
         */

        return res.status(500).json({

            success: false,

            error:
                "Webhook processing failed."

        });

    }

}


// =====================================================
// EXPORT
// =====================================================

module.exports = {
    handlePaystackWebhook
};