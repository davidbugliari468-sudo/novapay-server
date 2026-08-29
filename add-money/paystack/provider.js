// add-money/paystack/provider.js

/**
 * NovaPay Paystack Payment Provider
 *
 * Handles all Paystack-specific Add Money operations.
 *
 * IMPORTANT:
 * PAYSTACK_SECRET_KEY must be configured in the
 * Render environment variables.
 *
 * NEVER expose the secret key to the browser.
 */

const PAYSTACK_API_URL =
    "https://api.paystack.co";


// =====================================================
// CONFIGURATION
// =====================================================

const PAYSTACK_REQUEST_TIMEOUT =
    15000;


// =====================================================
// SECRET KEY
// =====================================================

function getPaystackSecretKey() {

    const key =
        String(
            process.env.PAYSTACK_SECRET_KEY || ""
        ).trim();


    if (!key) {

        throw new Error(
            "PAYSTACK_SECRET_KEY is not configured on the backend."
        );

    }


    return key;

}


// =====================================================
// PAYSTACK API REQUEST
// =====================================================

async function paystackRequest(
    endpoint,
    options = {}
) {

    const secretKey =
        getPaystackSecretKey();


    const controller =
        new AbortController();


    const timeoutId =
        setTimeout(
            () => {

                controller.abort();

            },
            PAYSTACK_REQUEST_TIMEOUT
        );


    let response;


    try {

        response =
            await fetch(
                `${PAYSTACK_API_URL}${endpoint}`,
                {

                    method:
                        options.method ||
                        "GET",

                    headers: {

                        "Authorization":
                            `Bearer ${secretKey}`,

                        "Content-Type":
                            "application/json",

                        "Accept":
                            "application/json"

                    },

                    body:
                        options.body !== undefined
                            ? JSON.stringify(
                                options.body
                            )
                            : undefined,

                    signal:
                        controller.signal

                }
            );

    }

    catch (error) {

        if (
            error?.name ===
            "AbortError"
        ) {

            const timeoutError =
                new Error(
                    "Paystack API request timed out."
                );

            timeoutError.code =
                "PAYSTACK_TIMEOUT";

            throw timeoutError;

        }


        const connectionError =
            new Error(
                "Unable to connect to Paystack."
            );

        connectionError.code =
            "PAYSTACK_CONNECTION_ERROR";

        connectionError.cause =
            error;

        throw connectionError;

    }

    finally {

        clearTimeout(
            timeoutId
        );

    }


    let result = null;


    try {

        result =
            await response.json();

    }

    catch {

        result =
            null;

    }


    if (!response.ok) {

        const error =
            new Error(
                result?.message ||
                `Paystack request failed (${response.status}).`
            );


        error.code =
            "PAYSTACK_HTTP_ERROR";


        error.status =
            response.status;


        error.response =
            result;


        throw error;

    }


    if (
        !result ||
        result.status !== true
    ) {

        const error =
            new Error(
                result?.message ||
                "Paystack rejected the request."
            );


        error.code =
            "PAYSTACK_REJECTED";


        error.response =
            result;


        throw error;

    }


    return result;

}


// =====================================================
// CREATE PAYMENT SESSION
// =====================================================
//
// Creates a Paystack Pay-with-Transfer charge.
//
// The resulting temporary bank account is associated
// with the transaction reference.
//
// =====================================================

async function createPaymentSession(
    {
        email,
        amount,
        reference,
        accountExpiresAt
    }
) {

    // -----------------------------------------------
    // Validate email
    // -----------------------------------------------

    const normalizedEmail =
        String(
            email || ""
        )
            .trim()
            .toLowerCase();


    if (!normalizedEmail) {

        throw new Error(
            "Payment email is required."
        );

    }


    // -----------------------------------------------
    // Validate amount
    // -----------------------------------------------

    if (
        !Number.isSafeInteger(
            amount
        ) ||
        amount <= 0
    ) {

        throw new Error(
            "Payment amount must be a valid positive integer in kobo."
        );

    }


    // -----------------------------------------------
    // Validate reference
    // -----------------------------------------------

    const normalizedReference =
        String(
            reference || ""
        ).trim();


    if (!normalizedReference) {

        throw new Error(
            "Payment reference is required."
        );

    }


    // -----------------------------------------------
    // Calculate account expiry
    // -----------------------------------------------

    let expiry =
        accountExpiresAt;


    if (!expiry) {

        expiry =
            new Date(
                Date.now() +
                60 * 60 * 1000
            ).toISOString();

    }


    const expiryDate =
        new Date(
            expiry
        );


    if (
        Number.isNaN(
            expiryDate.getTime()
        )
    ) {

        throw new Error(
            "Invalid temporary account expiry time."
        );

    }


    // -----------------------------------------------
    // Paystack charge request
    // -----------------------------------------------

    const result =
        await paystackRequest(
            "/charge",
            {

                method:
                    "POST",

                body: {

                    email:
                        normalizedEmail,

                    amount:
                        String(
                            amount
                        ),

                    reference:
                        normalizedReference,

                    bank_transfer: {

                        account_expires_at:
                            expiryDate.toISOString()

                    }

                }

            }
        );


    const payment =
        result?.data;


    if (!payment) {

        throw new Error(
            "Paystack returned an empty payment response."
        );

    }


    // -----------------------------------------------
    // Validate temporary account
    // -----------------------------------------------

    const accountNumber =
        String(
            payment.account_number ||
            ""
        ).trim();


    const accountName =
        String(
            payment.account_name ||
            ""
        ).trim();


    const bankName =
        String(
            payment.bank?.name ||
            ""
        ).trim();


    if (
        !accountNumber ||
        !accountName ||
        !bankName
    ) {

        const error =
            new Error(
                "Paystack did not return temporary transfer account details."
            );


        error.code =
            "PAYSTACK_MISSING_TRANSFER_ACCOUNT";


        error.response =
            payment;


        throw error;

    }


    // -----------------------------------------------
    // Return normalized payment object
    // -----------------------------------------------

    return {

        reference:
            payment.reference ||
            normalizedReference,

        status:
            payment.status ||
            "pending_bank_transfer",

        accountName,

        accountNumber,

        bankName,

        bankCode:
            payment.bank?.slug ||
            payment.bank?.code ||
            null,

        accountExpiresAt:
            payment.account_expires_at ||
            expiryDate.toISOString()

    };

}


// =====================================================
// VERIFY PAYMENT
// =====================================================
//
// Used to independently verify a Paystack transaction.
//
// IMPORTANT:
// Verification does NOT itself credit the wallet.
// Wallet crediting must remain idempotent and server-side.
// =====================================================

async function verifyPayment(
    reference
) {

    const normalizedReference =
        String(
            reference || ""
        ).trim();


    if (!normalizedReference) {

        throw new Error(
            "Payment reference is required."
        );

    }


    const encodedReference =
        encodeURIComponent(
            normalizedReference
        );


    const result =
        await paystackRequest(
            `/transaction/verify/${encodedReference}`,
            {

                method:
                    "GET"

            }
        );


    const transaction =
        result?.data;


    if (!transaction) {

        throw new Error(
            "Paystack returned an empty verification response."
        );

    }


    return {

        reference:
            transaction.reference ||
            normalizedReference,

        status:
            transaction.status ||
            "unknown",

        amount:
            Number(
                transaction.amount
            ),

        currency:
            transaction.currency ||
            "NGN",

        paidAt:
            transaction.paid_at ||
            null,

        channel:
            transaction.channel ||
            null,

        gatewayResponse:
            transaction.gateway_response ||
            null

    };

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    createPaymentSession,

    verifyPayment

};