const express = require("express");

const {
  verifyFirebaseToken
} = require("../middleware/auth");

const {
  createPermanentAccount
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
 * Paystack webhook.
 *
 * IMPORTANT:
 * This route must receive the raw request body.
 * We will configure that correctly in server.js
 * before activating the webhook.
 */
router.post(
  "/webhook",
  express.raw({
    type: "application/json"
  }),
  handlePaystackWebhook
);

module.exports = router;