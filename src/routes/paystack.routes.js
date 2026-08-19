const express = require("express");

const {
  verifyFirebaseToken
} = require("../middleware/auth");

const {
  createPermanentAccount,
  initializePayment
} = require("../controllers/paystack.controller");

const {
  handlePaystackWebhook
} = require("../controllers/paystack.webhook.controller");

const router = express.Router();


/**
 * Authenticated NovaPay user:
 * Create or retrieve permanent Paystack deposit account.
 */
router.post(
  "/account",
  verifyFirebaseToken,
  createPermanentAccount
);


/**
 * Authenticated NovaPay user:
 * Initialize a Paystack wallet-funding payment.
 */
router.post(
  "/initialize",
  verifyFirebaseToken,
  initializePayment
);


/**
 * Paystack webhook.
 *
 * IMPORTANT:
 * This route receives the raw request body
 * so the webhook signature can be verified.
 */
router.post(
  "/webhook",
  express.raw({
    type: "application/json"
  }),
  handlePaystackWebhook
);


module.exports = router;