"use strict";

const express = require("express");

const router = express.Router();

const {
  validateBettingRequest,
  validateProvider,
  validateCustomerId,
  validateTransactionId,
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
 * Resolve the project's existing authentication middleware.
 *
 * We intentionally reuse the application's existing authentication
 * system instead of creating another one inside the betting module.
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

/*
 * Extract the authenticated Firebase/application UID.
 */
function getAuthenticatedUid(req) {
  return (
    req?.user?.uid ||
    req?.auth?.uid ||
    req?.firebaseUser?.uid ||
    req?.user?.localId ||
    ""
  );
}

/*
 * Extract a string safely from request data.
 */
function getString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/*
 * Return a safe application/provider error message.
 *
 * Credentials, tokens, authorization headers, reservation IDs,
 * and raw provider responses are never returned to the client.
 */
function getSafeErrorMessage(error) {
  const message =
    typeof error?.message === "string"
      ? error.message.trim()
      : "";

  if (!message) {
    return "Unable to process the betting request right now.";
  }

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
    "Betting provider and service do not match",
  ]);

  if (safeMessages.has(message)) {
    return message;
  }

  /*
   * Provider rejections are safe to expose when the service has
   * explicitly classified them as provider_rejection.
   *
   * We still cap the length.
   */
  if (
    error?.kind === "provider_rejection" ||
    error?.type === "provider_rejection"
  ) {
    return message.slice(0, 300);
  }

  /*
   * These messages originate from our VTU adapter rather than
   * exposing the raw provider response.
   */
  const safeVtuPrefixes = [
    "VTU.ng returned HTTP ",
    "VTU.ng request timed out",
    "Unable to reach VTU.ng",
    "VTU.ng returned an invalid response",
    "Unable to determine the betting customer verification result",
  ];

  if (
    safeVtuPrefixes.some((prefix) =>
      message.startsWith(prefix)
    )
  ) {
    return message.slice(0, 300);
  }

  return "Unable to process the betting request right now.";
}

/*
 * Convert an application/provider error into an HTTP status.
 */
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
    error?.kind === "provider_rejection" ||
    error?.type === "provider_rejection"
  ) {
    return 400;
  }

  if (
    message.includes("invalid") ||
    message.includes("unsupported") ||
    message.includes("does not match")
  ) {
    return 400;
  }

  if (
    Number.isInteger(error?.httpStatus) &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500
  ) {
    return error.httpStatus;
  }

  return 500;
}

/*
 * Safe server-side diagnostic information.
 *
 * This is for logging only.
 */
function getSafeDiagnostic(error) {
  return {
    kind:
      typeof error?.kind === "string"
        ? error.kind
        : "",

    type:
      typeof error?.type === "string"
        ? error.type
        : "",

    httpStatus:
      Number.isInteger(error?.httpStatus)
        ? error.httpStatus
        : null,

    providerCode:
      typeof error?.providerCode === "string"
        ? error.providerCode
        : "",

    providerStatus:
      typeof error?.providerStatus === "string"
        ? error.providerStatus
        : "",
  };
}

/*
 * Build the public transaction object.
 *
 * This keeps the API response consistent regardless of whether
 * the transaction is successful, failed, or still pending.
 */
function buildTransactionResponse(transaction) {
  if (!transaction) {
    return null;
  }

  return {
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
  };
}

/*
 * Send a transaction using the application's betting transaction
 * state machine.
 *
 * SUCCESSFUL:
 *   200
 *
 * FAILED:
 *   400
 *
 * PENDING:
 *   202
 */
function sendTransactionResponse(res, transaction) {
  if (!transaction) {
    return res.status(404).json({
      success: false,
      error: "Transaction not found",
    });
  }

  const publicTransaction =
    buildTransactionResponse(transaction);

  if (transaction.status === STATUS_SUCCESSFUL) {
    return res.status(200).json({
      success: true,
      status: STATUS_SUCCESSFUL,
      transaction: publicTransaction,
    });
  }

  if (transaction.status === STATUS_FAILED) {
    return res.status(400).json({
      success: false,
      status: STATUS_FAILED,
      error:
        transaction.failureReason ||
        transaction.providerMessage ||
        "Betting account funding failed.",
      transaction: publicTransaction,
    });
  }

  /*
   * A provider timeout/ambiguous result must remain pending.
   * The customer must not be told that money was permanently
   * deducted until provider success is confirmed.
   */
  return res.status(202).json({
    success: true,
    status: STATUS_PENDING,
    message:
      "Betting account funding is still being confirmed.",
    transaction: publicTransaction,
  });
}

/*
 * Validate a transaction ID used by the GET endpoint.
 */
function validateTransactionIdForRoute(transactionId) {
  const result =
    validateTransactionId(transactionId);

  if (!result?.valid) {
    return {
      valid: false,
      error:
        result?.error ||
        "Invalid transaction ID",
    };
  }

  return {
    valid: true,
    data:
      result.data ??
      transactionId,
  };
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
 *
 * Verification is performed before funding.
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
      const body =
        req.body &&
        typeof req.body === "object" &&
        !Array.isArray(req.body)
          ? req.body
          : {};

      const provider =
        getString(body.provider);

      const customerId =
        getString(
          body.customerId ||
          body.accountId
        );

      /*
       * Provider validation must happen before calling VTU.
       *
       * This prevents values such as "unknown-provider"
       * from reaching the provider adapter.
       */
      const providerValidation =
        validateProvider(provider);

      if (!providerValidation?.valid) {
        return res.status(400).json({
          success: false,
          error:
            providerValidation?.error ||
            "Invalid betting provider",
        });
      }

      /*
       * Customer validation is shared with funding.
       */
      const customerValidation =
        validateCustomerId(customerId);

      if (!customerValidation?.valid) {
        return res.status(400).json({
          success: false,
          error:
            customerValidation?.error ||
            "Invalid betting customer ID",
        });
      }

      /*
       * IMPORTANT:
       *
       * validation.js returns:
       *
       * {
       *   valid: true,
       *   data: {
       *     provider: "bet9ja",
       *     serviceId: "Bet9ja"
       *   }
       * }
       *
       * The old code incorrectly passed the entire data object
       * as the provider. That produced:
       *
       * provider: {
       *   provider: "bet9ja",
       *   serviceId: "Bet9ja"
       * }
       *
       * which caused "Unsupported betting service".
       */
      const normalizedProvider =
        providerValidation.data.provider;

      const normalizedServiceId =
        providerValidation.data.serviceId;

      const normalizedCustomerId =
        customerValidation.data;

      /*
       * Defensive validation of the new validator contract.
       */
      if (
        !normalizedProvider ||
        !normalizedServiceId
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid betting provider",
        });
      }

      console.log(
        "[BETTING VERIFY REQUEST]",
        {
          uid,
          provider: normalizedProvider,
          serviceId: normalizedServiceId,
          customerIdProvided: true,
        }
      );

      const result =
        await verifyBettingCustomer({
          providerClient: vtu,
          customerId:
            normalizedCustomerId,
          provider:
            normalizedProvider,
          serviceId:
            normalizedServiceId,
        });

      console.log(
        "[BETTING VERIFY SUCCESS]",
        {
          uid,
          provider: normalizedProvider,
          serviceId: normalizedServiceId,
          providerCode:
            result.providerCode || "",
          providerStatus:
            result.providerStatus || "",
          customerVerified: true,
        }
      );

      return res.status(200).json({
        success: true,
        status: "verified",
        provider:
          normalizedProvider,
        serviceId:
          normalizedServiceId,
        customerId:
          result.customerId ||
          normalizedCustomerId,
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
      const diagnostic =
        getSafeDiagnostic(error);

      const safeMessage =
        getSafeErrorMessage(error);

      console.error(
        "[BETTING VERIFY ERROR]",
        {
          uid,
          message: safeMessage,
          ...diagnostic,
        }
      );

      /*
       * Diagnostics stay server-side.
       * They are deliberately not returned to the client.
       */
      return res.status(
        getErrorStatus(error)
      ).json({
        success: false,
        error: safeMessage,
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
      const body =
        req.body &&
        typeof req.body === "object" &&
        !Array.isArray(req.body)
          ? req.body
          : {};

      /*
       * Build one normalized validation input.
       *
       * accountId remains supported for backwards compatibility.
       *
       * NOTE:
       * We no longer force serviceId to body.provider here.
       * validation.js already derives the correct canonical
       * VTU service ID from the provider and validates an
       * explicitly supplied serviceId when present.
       */
      const validationInput = {
        provider:
          body.provider,

        customerId:
          body.customerId ||
          body.accountId,

        serviceId:
          body.serviceId,

        amountKobo:
          body.amountKobo,

        transactionId:
          body.transactionId,
      };

      const validation =
        validateBettingRequest(
          validationInput
        );

      /*
       * validateBettingRequest() returns a result object,
       * not the validated data itself.
       */
      if (!validation?.valid) {
        return res.status(400).json({
          success: false,
          error:
            validation?.error ||
            "Invalid betting request",
        });
      }

      /*
       * The validated/normalized data lives inside
       * validation.data.
       */
      const data =
        validation.data;

      /*
       * Defensive check so a malformed validator result
       * cannot reach the funding service.
       */
      if (
        !data ||
        !data.provider ||
        !data.serviceId ||
        !data.customerId ||
        !Number.isInteger(data.amountKobo)
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid betting request",
        });
      }

      const transaction =
        await purchaseBettingAccount({
          uid,

          provider:
            data.provider,

          customerId:
            data.customerId,

          serviceId:
            data.serviceId,

          amountKobo:
            data.amountKobo,

          transactionId:
            data.transactionId,

          providerClient: vtu,
        });

      return sendTransactionResponse(
        res,
        transaction
      );
    } catch (error) {
      const diagnostic =
        getSafeDiagnostic(error);

      const safeMessage =
        getSafeErrorMessage(error);

      console.error(
        "[BETTING FUND ERROR]",
        {
          uid,
          message: safeMessage,
          ...diagnostic,
        }
      );

      /*
       * Provider credentials, raw responses and internal
       * reservation information remain server-side.
       */
      return res.status(
        getErrorStatus(error)
      ).json({
        success: false,
        error: safeMessage,
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
      getString(
        req.params?.transactionId
      );

    const transactionValidation =
      validateTransactionIdForRoute(
        transactionId
      );

    if (!transactionValidation.valid) {
      return res.status(400).json({
        success: false,
        error:
          transactionValidation.error,
      });
    }

    const normalizedTransactionId =
      transactionValidation.data;

    try {
      const transaction =
        await getBettingTransaction(
          normalizedTransactionId
        );

      if (!transaction) {
        return res.status(404).json({
          success: false,
          error: "Transaction not found",
        });
      }

      /*
       * Never reveal whether another user's transaction
       * exists. Return 404 for ownership mismatch.
       */
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
        "[BETTING TRANSACTION ERROR]",
        {
          uid,
          message:
            error?.message ||
            "Unknown error",
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