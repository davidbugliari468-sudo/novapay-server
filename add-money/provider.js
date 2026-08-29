// add-money/provider.js

const paystackProvider =
    require("./paystack/provider");


// =====================================================
// ACTIVE PAYMENT PROVIDER
// =====================================================
//
// The Add Money system communicates through this file.
//
// Routes do not need to know which provider is active.
//
// When another provider is ready in the future,
// this is the provider-selection layer that can be
// changed without rebuilding the Add Money routes.
// =====================================================

const activeProvider =
    paystackProvider;


// =====================================================
// CREATE PAYMENT SESSION
// =====================================================

async function createPaymentSession(
    paymentData
) {

    return activeProvider.createPaymentSession(
        paymentData
    );

}


// =====================================================
// VERIFY PAYMENT
// =====================================================

async function verifyPayment(
    reference
) {

    return activeProvider.verifyPayment(
        reference
    );

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {
    createPaymentSession,
    verifyPayment
};