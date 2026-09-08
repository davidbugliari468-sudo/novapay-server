"use strict";

const express = require("express");

const router = express.Router();

const {
  validateBettingRequest,
} = require("./validation");

const {
  verifyBettingCustomer,
  purchaseBettingAccount,
  getBettingTransaction,
  STATUS_PENDING,
  STATUS_SUCCESSFUL,
  STATUS_FAILED,
} = require("./service");

const vtu = require("./vtu");

/*
 * Resolve the project's existing authentication middleware
 * without creating a second authentication system.
 */
const authModule = require("../auth");

const authenticate =
  authModule.authenticate ||
  authModule.authenticateUser ||
  authModule.requireAuth ||
  authModule.requireAuthentication ||
  authModule.verifyToken ||
  authModule.verifyFirebaseToken ||
  authModule.authMiddleware ||
  authModule.auth ||
  (typeof authModule === "function"
    ? authModule
    : null);

if (typeof authenticate !== "function") {
  throw new Error(
    "Betting routes could not find the existing authentication middleware"
  );
}

function getAuthenticatedUid(req) {
  return (
    req?.user?.uid ||
    req?.auth?.uid ||
    req?.firebaseUser?.uid ||
    req?.user?.localId ||
    ""
  );
}

function getSafeErrorMessage(error) {
  const message =
    typeof error?.message === "string"
      ? error.message.trim()
      : "";

  const safeMessages = new Set([
    "Authentication required",
    "User ID is required",
    "Invalid betting request",
    "Invalid betting provider",
    "Unsupported betting service",
    "Invalid betting customer ID",
    "Invalid betting amount",
    "Invalid transaction ID",
    "Transaction does not belong to this user",
    "Transaction details do not match",
    "Betting provider verification client is unavailable",
    "Betting provider funding client is unavailable",
    "Betting transaction reservation could not be found",
    "Betting transaction reservation does not belong to this user",
    "Existing betting transaction reservation could not be found",
    "Betting transaction does not belong to this user",
  ]);

  if (safeMessages.has(message)) {
    return message;
  }

  return "Unable to process the betting request right now.";
}

function getErrorStatus(error) {
  const message =
    typeof error?.message === "string"
      ? error.message.toLowerCase()
      : "";

  if (
    message.includes("authentication") ||
    message.includes("user id")
  ) {
    return 401;
  }

  if (
    message.includes("invalid") ||
    message.includes("unsupported") ||
    message.includes("does not match")
  ) {
    return 400;
  }

  if (
    error?.kind === "provider_rejection" ||
    error?.type === "provider_rejection"
  ) {
    return 400;
  }

  return 500;
}

function sendTransactionResponse(res, transaction) {
  if (!transaction) {
    return res.status(404).json({
      success: false,
      error: "Transaction not found",
    });
  }

  const status = transaction.status;

  if (status === STATUS_SUCCESSFUL) {
    return res.status(200).json({
      success: true,
      status: STATUS_SUCCESSFUL,
      transaction: {
        id: transaction.id,
        service: transaction.service,
        provider: transaction.provider,
        customerId: transaction.customerId,
        serviceId: transaction.serviceId,
        amountKobo: transaction.amountKobo,
        currency: transaction.currency,
        status: transaction.status,
        providerReference:
          transaction.providerReference || "",
        providerRequestId:
          transaction.providerRequestId || "",
        providerStatus:
          transaction.providerStatus || "",
        providerCode:
          transaction.providerCode || "",
        providerMessage:
          transaction.providerMessage || "",
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
      },
    });
  }

  if (status === STATUS_FAILED) {
    return res.status(400).json({
      success: false,
      status: STATUS_FAILED,
      error:
        transaction.failureReason ||
        transaction.providerMessage ||
        "Betting account funding failed.",
      transaction: {
        id: transaction.id,
        service: transaction.service,
        provider: transaction.provider,
        customerId: transaction.customerId,
        serviceId: transaction.serviceId,
        amountKobo: transaction.amountKobo,
        currency: transaction.currency,
        status: transaction.status,
        providerReference:
          transaction.providerReference || "",
        providerRequestId:
          transaction.providerRequestId || "",
        providerStatus:
          transaction.providerStatus || "",
        providerCode:
          transaction.providerCode || "",
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
      },
    });
  }

  return res.status(202).json({
    success: true,
    status: STATUS_PENDING,
    message:
      "Betting account funding is still being confirmed.",
    transaction: {
      id: transaction.id,
      service: transaction.service,
      provider: transaction.provider,
      customerId: transaction.customerId,
      serviceId: transaction.serviceId,
      amountKobo: transaction.amountKobo,
      currency: transaction.currency,
      status: transaction.status,
      providerReference:
        transaction.providerReference || "",
      providerRequestId:
        transaction.providerRequestId || "",
      providerStatus:
        transaction.providerStatus || "",
      providerCode:
        transaction.providerCode || "",
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    },
  });
}

/*
 * Verify betting customer
 *
 * POST /api/betting/verify
 *
 * Body:
 * {
 *   "provider": "bet9ja",
 *   "customerId": "12345678"
 * }
 */
router.post(
  "/verify",
  authenticate,
  async (req, res) => {
    const uid = getAuthenticatedUid(req);

    if (!uid) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
      });
    }

    try {
      const provider =
        typeof req.body?.provider === "string"
          ? req.body.provider.trim().toLowerCase()
          : "";

      const customerId =
        typeof req.body?.customerId === "string"
          ? req.body.customerId.trim()
          : "";

      const accountId =
        typeof req.body?.accountId === "string"
          ? req.body.accountId.trim()
          : "";

      const serviceId = provider;

      const normalizedCustomerId =
        customerId || accountId;

      if (!provider) {
        return res.status(400).json({
          success: false,
          error: "Invalid betting provider",
        });
      }

      if (!normalizedCustomerId) {
        return res.status(400).json({
          success: false,
          error: "Invalid betting customer ID",
        });
      }

      const result =
        await verifyBettingCustomer({
          providerClient: vtu,
          customerId: normalizedCustomerId,
          serviceId,
        });

      return res.status(200).json({
        success: true,
        status: "verified",
        provider: serviceId,
        customerId: result.customerId,
        customerName:
          result.customerName || "",
        balance:
          result.balance ?? null,
        providerReference:
          result.providerReference || "",
        providerStatus:
          result.providerStatus || "",
        providerCode:
          result.providerCode || "",
        message:
          result.message || "",
      });
    } catch (error) {
      console.error(
        "[Betting Verify Error]",
        {
          uid,
          message: error?.message || "Unknown error",
          kind: error?.kind || "",
          httpStatus: error?.httpStatus || null,
        }
      );

      return res.status(
        getErrorStatus(error)
      ).json({
        success: false,
        error: getSafeErrorMessage(error),
      });
    }
  }
);

/*
 * Fund betting account
 *
 * POST /api/betting/fund
 *
 * Body:
 * {
 *   "provider": "bet9ja",
 *   "customerId": "12345678",
 *   "amountKobo": 100000
 * }
 */
router.post(
  "/fund",
  authenticate,
  async (req, res) => {
    const uid = getAuthenticatedUid(req);

    if (!uid) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
      });
    }

    try {
      const body = {
        provider:
          req.body?.provider,

        customerId:
          req.body?.customerId ||
          req.body?.accountId,

        serviceId:
          req.body?.serviceId ||
          req.body?.provider,

        amountKobo:
          req.body?.amountKobo,

        transactionId:
          req.body?.transactionId,
      };

      const validation =
        validateBettingRequest(body);

      const transaction =
        await purchaseBettingAccount({
          uid,

          provider:
            validation.provider,

          customerId:
            validation.customerId,

          serviceId:
            validation.serviceId,

          amountKobo:
            validation.amountKobo,

          transactionId:
            validation.transactionId,

          providerClient: vtu,
        });

      return sendTransactionResponse(
        res,
        transaction
      );
    } catch (error) {
      console.error(
        "[Betting Fund Error]",
        {
          uid,
          message: error?.message || "Unknown error",
          kind: error?.kind || "",
          httpStatus: error?.httpStatus || null,
        }
      );

      return res.status(
        getErrorStatus(error)
      ).json({
        success: false,
        error: getSafeErrorMessage(error),
      });
    }
  }
);

/*
 * Get a single betting transaction.
 *
 * GET /api/betting/transaction/:transactionId
 */
router.get(
  "/transaction/:transactionId",
  authenticate,
  async (req, res) => {
    const uid = getAuthenticatedUid(req);

    if (!uid) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
      });
    }

    const transactionId =
      typeof req.params?.transactionId === "string"
        ? req.params.transactionId.trim()
        : "";

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        error: "Invalid transaction ID",
      });
    }

    try {
      const transaction =
        await getBettingTransaction(
          transactionId
        );

      if (!transaction) {
        return res.status(404).json({
          success: false,
          error: "Transaction not found",
        });
      }

      if (transaction.uid !== uid) {
        return res.status(404).json({
          success: false,
          error: "Transaction not found",
        });
      }

      return sendTransactionResponse(
        res,
        transaction
      );
    } catch (error) {
      console.error(
        "[Betting Transaction Error]",
        {
          uid,
          message: error?.message || "Unknown error",
        }
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to retrieve the betting transaction right now.",
      });
    }
  }
);

module.exports = router;