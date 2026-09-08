"use strict";

const express = require("express");

const router = express.Router();

const tvService = require("./service");
const vtu = require("./vtu");
const { validateTvRequest } = require("./validation");

function resolveAuthMiddleware() {
  const authModule = require("../auth");

  if (typeof authModule === "function") {
    return authModule;
  }

  const candidates = [
    "authenticate",
    "authenticateUser",
    "requireAuth",
    "requireAuthentication",
    "verifyToken",
    "verifyFirebaseToken",
    "authMiddleware",
    "auth",
  ];

  for (const name of candidates) {
    if (typeof authModule[name] === "function") {
      return authModule[name];
    }
  }

  throw new Error("Authentication middleware is unavailable");
}

const authenticate = resolveAuthMiddleware();

function getUid(req) {
  return (
    req.user?.uid ||
    req.auth?.uid ||
    req.firebaseUser?.uid ||
    req.user?.localId ||
    null
  );
}

function getSafeErrorMessage(error) {
  const message =
    error && typeof error.message === "string"
      ? error.message
      : "";

  const safeMessages = new Set([
    "Authenticated user is required",
    "Unsupported TV provider",
    "Invalid customer or smartcard number",
    "Invalid TV variation",
    "Invalid TV purchase amount",
    "TV service ID is required",
    "TV verification provider is unavailable",
    "TV purchase provider is unavailable",
    "Invalid transaction ID",
    "Transaction not found",
    "You are not authorized to access this transaction",
    "Transaction ID already exists with different details",
  ]);

  if (safeMessages.has(message)) {
    return message;
  }

  return "Unable to process TV request";
}

function getErrorStatus(error) {
  const message =
    error && typeof error.message === "string"
      ? error.message
      : "";

  if (
    message === "Authenticated user is required" ||
    message.includes("Invalid") ||
    message === "Unsupported TV provider" ||
    message.includes("required")
  ) {
    return 400;
  }

  if (
    message.includes("not authorized") ||
    message.includes("Unauthorized")
  ) {
    return 403;
  }

  if (message === "Transaction not found") {
    return 404;
  }

  return 500;
}

/**
 * POST /api/tv/verify
 *
 * Verifies a customer's TV smartcard/account number.
 *
 * IMPORTANT:
 * - Authentication is required.
 * - Verification does not touch the wallet.
 * - The provider is called through tv/service.js.
 * - The route never calls VTU directly.
 */
router.post("/verify", authenticate, async (req, res) => {
  try {
    const uid = getUid(req);

    if (!uid) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const provider =
      typeof req.body?.provider === "string"
        ? req.body.provider.trim().toLowerCase()
        : "";

    const smartcardNumber =
      typeof req.body?.smartcardNumber === "string"
        ? req.body.smartcardNumber.trim()
        : "";

    if (!provider || !smartcardNumber) {
      return res.status(400).json({
        success: false,
        message:
          "Provider and smartcard number are required",
      });
    }

    const result = await tvService.verifyTvCustomer({
      uid,
      provider,
      customerId: smartcardNumber,
      providerClient: vtu,
    });

    if (result.outcome === "success") {
      return res.status(200).json({
        success: true,
        verified: true,
        provider: result.provider,
        customerId: result.customerId,
        providerReference:
          result.providerReference || "",
        customer: result.customer || null,
        message:
          result.message ||
          "Customer verified successfully",
      });
    }

    if (result.outcome === "failure") {
      return res.status(400).json({
        success: false,
        verified: false,
        provider: result.provider,
        customerId: result.customerId,
        message:
          result.message ||
          "Customer verification failed",
      });
    }

    /*
     * Unknown verification is deliberately not treated as
     * "customer does not exist".
     *
     * A timeout/network failure can mean the provider simply
     * did not answer us.
     */
    return res.status(202).json({
      success: false,
      verified: false,
      pending: true,
      provider: result.provider,
      customerId: result.customerId,
      message:
        result.message ||
        "Customer verification could not be confirmed",
    });
  } catch (error) {
    console.error("TV verification error:", {
      uid: getUid(req) || null,
      message: error?.message || "unknown error",
    });

    return res.status(getErrorStatus(error)).json({
      success: false,
      message: getSafeErrorMessage(error),
    });
  }
});

/**
 * POST /api/tv/purchase
 *
 * Creates and processes a TV subscription purchase.
 */
router.post(
  "/purchase",
  authenticate,
  async (req, res) => {
    try {
      const uid = getUid(req);

      if (!uid) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const validation = validateTvRequest(req.body);

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message:
            validation.message ||
            "Invalid TV purchase request",
        });
      }

      const result = await tvService.purchaseTv({
        uid,

        transactionId:
          req.body.transactionId || undefined,

        provider: req.body.provider,

        customerId:
          req.body.smartcardNumber ||
          req.body.customerId,

        serviceId: req.body.serviceId,

        variationId: req.body.variationId,

        subscriptionType:
          req.body.subscriptionType || "change",

        amountKobo: req.body.amountKobo,

        providerClient: vtu,
      });

      if (result.status === "successful") {
        return res.status(200).json({
          success: true,
          status: "successful",
          transactionId: result.transactionId,
          providerReference:
            result.providerReference || "",
          gainKobo: result.gainKobo || 0,
          message: "TV purchase successful",
        });
      }

      if (result.status === "failed") {
        return res.status(400).json({
          success: false,
          status: "failed",
          transactionId: result.transactionId,
          message:
            result.message ||
            "TV purchase failed",
        });
      }

      return res.status(202).json({
        success: false,
        status: "pending",
        transactionId: result.transactionId,
        reconciliationRequired:
          result.reconciliationRequired === true,
        message:
          "TV purchase is pending confirmation",
      });
    } catch (error) {
      console.error("TV purchase error:", {
        uid: getUid(req) || null,
        message: error?.message || "unknown error",
      });

      return res.status(getErrorStatus(error)).json({
        success: false,
        message: getSafeErrorMessage(error),
      });
    }
  }
);

/**
 * GET /api/tv/transaction/:transactionId
 *
 * Returns only the authenticated user's TV transaction.
 */
router.get(
  "/transaction/:transactionId",
  authenticate,
  async (req, res) => {
    try {
      const uid = getUid(req);

      if (!uid) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const transactionId =
        typeof req.params.transactionId === "string"
          ? req.params.transactionId.trim()
          : "";

      if (!transactionId) {
        return res.status(400).json({
          success: false,
          message: "Invalid transaction ID",
        });
      }

      const transaction =
        await tvService.getTvTransaction(
          transactionId
        );

      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      if (transaction.uid !== uid) {
        return res.status(403).json({
          success: false,
          message:
            "You are not authorized to access this transaction",
        });
      }

      /*
       * Do not expose internal wallet reservation data,
       * reconciliation internals, or provider internals.
       */
      return res.status(200).json({
        success: true,
        transaction: {
          id: transaction.id,
          provider: transaction.provider,
          customerId: transaction.customerId,
          serviceId: transaction.serviceId,
          variationId: transaction.variationId,
          subscriptionType:
            transaction.subscriptionType,
          amountKobo: transaction.amountKobo,
          currency: transaction.currency,
          status: transaction.status,
          providerReference:
            transaction.providerReference || "",
          providerStatus:
            transaction.providerStatus || "",
          providerCode:
            transaction.providerCode || "",
          costKobo:
            transaction.costKobo || 0,
          gainKobo:
            transaction.gainKobo || 0,
          rewardPoints:
            transaction.rewardPoints || 0,
          failureReason:
            transaction.failureReason || "",
          reconciliationRequired:
            transaction.reconciliationRequired === true,
          createdAt: transaction.createdAt || null,
          updatedAt: transaction.updatedAt || null,
        },
      });
    } catch (error) {
      console.error("TV transaction lookup error:", {
        uid: getUid(req) || null,
        message: error?.message || "unknown error",
      });

      return res.status(getErrorStatus(error)).json({
        success: false,
        message: getSafeErrorMessage(error),
      });
    }
  }
);

module.exports = router;