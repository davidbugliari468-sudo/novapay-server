"use strict";

const express = require("express");

const router = express.Router();

const {
  validateTvRequest,
} = require("./validation");

const tvService =
  require("./service");

const vtu =
  require("./vtu");

/* ==========================================
   AUTHENTICATION
========================================== */

const authModule =
  require("../auth");

const authCandidates = [
  "authenticate",
  "authenticateUser",
  "requireAuth",
  "requireAuthentication",
  "verifyToken",
  "verifyFirebaseToken",
  "authMiddleware",
  "auth",
];

let authenticate = null;

for (const name of authCandidates) {

  if (
    typeof authModule?.[name] ===
    "function"
  ) {

    authenticate =
      authModule[name];

    break;

  }

}

if (
  !authenticate &&
  typeof authModule === "function"
) {

  authenticate =
    authModule;

}

if (typeof authenticate !== "function") {

  throw new Error(
    "TV routes could not resolve authentication middleware."
  );

}

/* ==========================================
   USER ID
========================================== */

function getUid(req) {

  const uid =
    req?.user?.uid ||
    req?.auth?.uid ||
    req?.firebaseUser?.uid ||
    req?.user?.localId;

  if (!uid) {

    const error =
      new Error(
        "Authentication required."
      );

    error.code =
      "AUTHENTICATION_REQUIRED";

    throw error;

  }

  return String(uid).trim();

}

/* ==========================================
   SAFE ERROR MESSAGE
========================================== */

function getSafeErrorMessage(error) {

  const code =
    String(error?.code || "")
      .trim()
      .toUpperCase();

  /*
   * Authentication errors
   */

  if (
    code ===
      "AUTHENTICATION_REQUIRED" ||
    code ===
      "UNAUTHENTICATED" ||
    code ===
      "UNAUTHORIZED"
  ) {

    return "Authentication required.";

  }

  /*
   * Customer validation / verification
   */

  if (
    code ===
      "INVALID_CUSTOMER_ID" ||
    code ===
      "INVALID_TV_CUSTOMER_ID"
  ) {

    return "Invalid smartcard number.";

  }

  if (
    code ===
      "INVALID_SERVICE" ||
    code ===
      "INVALID_SERVICE_ID"
  ) {

    return "Invalid TV provider.";

  }

  if (
    code ===
      "INVALID_VARIATION" ||
    code ===
      "INVALID_VARIATION_ID"
  ) {

    return "Invalid TV package.";

  }

  /*
   * Provider explicitly rejected verification.
   */

  if (
    code ===
      "PROVIDER_REJECTION" ||
    code ===
      "PROVIDER_REJECTED"
  ) {

    return (
      error?.message ||
      "The TV provider could not verify this customer."
    );

  }

  /*
   * Provider reported an invalid customer.
   */

  if (
    code ===
      "INVALID_CUSTOMER" ||
    code ===
      "INVALID_CUSTOMER_ID_PROVIDER"
  ) {

    return "The smartcard number could not be verified.";

  }

  /*
   * Known wallet errors.
   */

  if (
    code ===
      "INSUFFICIENT_WALLET_BALANCE"
  ) {

    return "Insufficient wallet balance.";

  }

  /*
   * Unknown provider/network conditions must remain
   * generic. Never expose raw provider responses.
   */

  if (
    code ===
      "UNKNOWN" ||
    code ===
      "PROVIDER_UNKNOWN" ||
    code ===
      "VTU_UNKNOWN" ||
    code ===
      "NETWORK_ERROR" ||
    code ===
      "TIMEOUT"
  ) {

    return (
      "Unable to verify the TV customer right now. Please try again."
    );

  }

  /*
   * Safe application-level validation errors.
   */

  const safeMessages = new Set([
    "Invalid TV provider.",
    "Invalid smartcard number.",
    "Invalid TV package.",
    "Invalid amount.",
    "Invalid subscription type.",
    "Invalid TV request.",
    "TV customer verification failed.",
    "The TV provider could not verify this customer.",
    "The smartcard number could not be verified.",
    "Insufficient wallet balance.",
  ]);

  const message =
    String(error?.message || "").trim();

  if (safeMessages.has(message)) {

    return message;

  }

  /*
   * Never return raw provider errors, stack traces,
   * Firestore errors, or internal implementation details.
   */

  return "Unable to process TV request.";

}

/* ==========================================
   ERROR STATUS
========================================== */

function getErrorStatus(error) {

  const code =
    String(error?.code || "")
      .trim()
      .toUpperCase();

  if (
    code ===
      "AUTHENTICATION_REQUIRED" ||
    code ===
      "UNAUTHENTICATED" ||
    code ===
      "UNAUTHORIZED"
  ) {

    return 401;

  }

  if (
    code.startsWith("INVALID_") ||
    code ===
      "UNSUPPORTED_TV_SERVICE"
  ) {

    return 400;

  }

  if (
    code ===
      "PROVIDER_REJECTION" ||
    code ===
      "PROVIDER_REJECTED" ||
    code ===
      "INVALID_CUSTOMER" ||
    code ===
      "INVALID_CUSTOMER_ID_PROVIDER"
  ) {

    return 400;

  }

  if (
    code ===
      "INSUFFICIENT_WALLET_BALANCE"
  ) {

    return 400;

  }

  return 500;

}

/* ==========================================
   VERIFY TV CUSTOMER
========================================== */

router.post(
  "/verify",
  authenticate,
  async (req, res) => {

    try {

      const uid =
        getUid(req);

      const provider =
        String(
          req.body?.provider || ""
        )
          .trim()
          .toLowerCase();

      const smartcardNumber =
        String(
          req.body?.smartcardNumber || ""
        ).trim();

      if (!provider) {

        return res.status(400).json({
          success: false,
          error: "Invalid TV provider.",
        });

      }

      if (!smartcardNumber) {

        return res.status(400).json({
          success: false,
          error: "Invalid smartcard number.",
        });

      }

      const result =
        await tvService.verifyTvCustomer({
          uid,
          provider,
          customerId:
            smartcardNumber,
          providerClient:
            vtu,
        });

      if (
        result?.status ===
        "success"
      ) {

        return res.status(200).json({
          success: true,
          data:
            result.data ||
            result,
        });

      }

      if (
        result?.status ===
        "failure"
      ) {

        return res.status(400).json({
          success: false,
          error:
            result.message ||
            "The smartcard number could not be verified.",
        });

      }

      return res.status(202).json({
        success: false,
        pending: true,
        error:
          "Unable to verify the TV customer right now. Please try again.",
      });

    } catch (error) {

      console.error(
        "TV customer verification error:",
        {
          code:
            error?.code || null,
          message:
            error?.message || null,
        }
      );

      return res
        .status(
          getErrorStatus(error)
        )
        .json({
          success: false,
          error:
            getSafeErrorMessage(error),
        });

    }

  }
);

/* ==========================================
   PURCHASE TV
========================================== */

router.post(
  "/purchase",
  authenticate,
  async (req, res) => {

    try {

      const uid =
        getUid(req);

      const validation =
        validateTvRequest(
          req.body
        );

      if (
        !validation ||
        validation.valid !== true
      ) {

        return res.status(400).json({
          success: false,
          error:
            validation?.error ||
            "Invalid TV request.",
        });

      }

      const result =
        await tvService.purchaseTv({
          uid,

          provider:
            validation.data.provider,

          customerId:
            validation.data.customerId,

          serviceId:
            validation.data.serviceId,

          variationId:
            validation.data.variationId,

          amountKobo:
            validation.data.amountKobo,

          subscriptionType:
            validation.data.subscriptionType,

          providerClient:
            vtu,
        });

      if (
        result?.status ===
        "successful"
      ) {

        return res.status(200).json({
          success: true,
          data:
            result.data ||
            result,
        });

      }

      if (
        result?.status ===
        "failed"
      ) {

        return res.status(400).json({
          success: false,
          error:
            result.message ||
            "TV subscription purchase failed.",
        });

      }

      return res.status(202).json({
        success: false,
        pending: true,
        error:
          "TV subscription is still being processed.",
        data:
          result.data ||
          result,
      });

    } catch (error) {

      console.error(
        "TV purchase error:",
        {
          code:
            error?.code || null,
          message:
            error?.message || null,
        }
      );

      return res
        .status(
          getErrorStatus(error)
        )
        .json({
          success: false,
          error:
            getSafeErrorMessage(error),
        });

    }

  }
);

/* ==========================================
   GET TV TRANSACTION
========================================== */

router.get(
  "/transaction/:transactionId",
  authenticate,
  async (req, res) => {

    try {

      const uid =
        getUid(req);

      const transactionId =
        String(
          req.params?.transactionId ||
          ""
        ).trim();

      if (!transactionId) {

        return res.status(400).json({
          success: false,
          error:
            "Invalid transaction ID.",
        });

      }

      const transaction =
        await tvService.getTvTransaction(
          transactionId
        );

      if (!transaction) {

        return res.status(404).json({
          success: false,
          error:
            "TV transaction not found.",
        });

      }

      if (
        String(transaction.uid) !==
        uid
      ) {

        return res.status(404).json({
          success: false,
          error:
            "TV transaction not found.",
        });

      }

      return res.status(200).json({
        success: true,

        data: {
          id:
            transaction.id,

          uid:
            transaction.uid,

          service:
            transaction.service,

          provider:
            transaction.provider,

          customerId:
            transaction.customerId,

          serviceId:
            transaction.serviceId,

          variationId:
            transaction.variationId,

          subscriptionType:
            transaction.subscriptionType,

          amountKobo:
            transaction.amountKobo,

          currency:
            transaction.currency,

          status:
            transaction.status,

          providerReference:
            transaction.providerReference ||
            null,

          providerRequestId:
            transaction.providerRequestId ||
            null,

          providerStatus:
            transaction.providerStatus ||
            null,

          providerCode:
            transaction.providerCode ||
            null,

          failureReason:
            transaction.failureReason ||
            "",

          reconciliationRequired:
            Boolean(
              transaction.reconciliationRequired
            ),

          createdAt:
            transaction.createdAt ||
            null,

          updatedAt:
            transaction.updatedAt ||
            null,
        },

      });

    } catch (error) {

      console.error(
        "TV transaction lookup error:",
        {
          code:
            error?.code || null,
          message:
            error?.message || null,
        }
      );

      return res
        .status(
          getErrorStatus(error)
        )
        .json({
          success: false,
          error:
            getSafeErrorMessage(error),
        });

    }

  }
);

module.exports = router;