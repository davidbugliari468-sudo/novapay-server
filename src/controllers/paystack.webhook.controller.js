const crypto = require("crypto");
const { db } = require("../config/firebase");

/**
 * Verify that a webhook request actually came from Paystack.
 */
function verifyPaystackSignature(req) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  const signature = req.headers["x-paystack-signature"];

  if (!signature) {
    return false;
  }

  const payload = JSON.stringify(req.body);

  const expectedSignature = crypto
    .createHmac("sha512", secretKey)
    .update(payload)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Handle Paystack webhook events.
 *
 * IMPORTANT:
 * Do not trust user IDs, wallet IDs, or amounts
 * supplied by the frontend.
 *
 * Paystack is the source of truth for payment events.
 */
async function handlePaystackWebhook(req, res) {
  try {
    // --------------------------------------------------
    // 1. Verify Paystack signature
    // --------------------------------------------------
    const validSignature = verifyPaystackSignature(req);

    if (!validSignature) {
      console.warn("Rejected Paystack webhook: invalid signature");

      return res.status(401).json({
        success: false,
        message: "Invalid webhook signature",
      });
    }

    const event = req.body;

    if (!event || typeof event !== "object") {
      return res.status(400).json({
        success: false,
        message: "Invalid webhook payload",
      });
    }

    const eventType = event.event;
    const data = event.data || {};

    console.log(`Paystack webhook received: ${eventType}`);

    // --------------------------------------------------
    // 2. We only process events we understand
    // --------------------------------------------------
    switch (eventType) {
      /**
       * Successful payment.
       *
       * This is important for future:
       * - Add Money
       * - Dedicated Virtual Account deposits
       */
      case "charge.success": {
        const reference = data.reference;

        if (!reference) {
          console.warn("Paystack charge.success without reference");

          return res.status(400).json({
            success: false,
            message: "Payment reference missing",
          });
        }

        /*
         * IMPORTANT:
         * We use the Paystack reference as the unique
         * transaction identifier.
         *
         * This prevents the same webhook from crediting
         * a wallet twice.
         */
        const transactionRef = db
          .collection("paystack_webhooks")
          .doc(reference);

        const existingTransaction = await transactionRef.get();

        if (existingTransaction.exists) {
          console.log(
            `Paystack webhook already processed: ${reference}`
          );

          return res.status(200).json({
            success: true,
            message: "Webhook already processed",
          });
        }

        /*
         * For now we record the event.
         *
         * The actual wallet-crediting logic will be connected
         * through the transaction/wallet services after we
         * finish the backend structure.
         */
        await transactionRef.set({
          reference,
          event: eventType,
          status: data.status || "success",
          amount: Number(data.amount || 0),
          currency: data.currency || "NGN",
          customerCode: data.customer?.customer_code || null,
          customerEmail: data.customer?.email || null,
          channel: data.channel || null,
          receivedAt: new Date(),
          processed: false,
        });

        console.log(
          `Paystack payment recorded: ${reference}`
        );

        break;
      }

      /**
       * Dedicated Virtual Account events.
       *
       * We will connect the actual wallet-crediting logic
       * after the Paystack account-generation flow is complete.
       */
      case "dedicatedaccount.assign.success": {
        console.log("Paystack dedicated account assigned");

        break;
      }

      case "dedicatedaccount.assign.failed": {
        console.warn("Paystack dedicated account assignment failed");

        break;
      }

      /**
       * Customer identification events.
       */
      case "customeridentification.success": {
        console.log("Paystack customer identification successful");

        break;
      }

      case "customeridentification.failed": {
        console.warn("Paystack customer identification failed");

        break;
      }

      /**
       * Unknown events should not crash the server.
       */
      default:
        console.log(
          `Paystack event received but not handled: ${eventType}`
        );
    }

    // --------------------------------------------------
    // 3. Tell Paystack we received the webhook
    // --------------------------------------------------
    return res.status(200).json({
      success: true,
      received: true,
    });
  } catch (error) {
    console.error(
      "Paystack webhook error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed",
    });
  }
}

module.exports = {
  verifyPaystackSignature,
  handlePaystackWebhook,
};