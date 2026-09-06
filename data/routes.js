"use strict";

const express = require("express");

const {
  purchaseData,
  getPurchaseStatus,
} = require("./service");

const {
  getPlans,
} = require("./catalog");

function createDataRouter(requireAuth) {
  const router = express.Router();

  router.get(
    "/plans",
    requireAuth,
    async (req, res) => {
      try {
        const network =
          req.query.network === undefined
            ? undefined
            : String(req.query.network).trim();

        const type =
          req.query.type === undefined
            ? undefined
            : String(req.query.type).trim().toLowerCase();

        const forceRefresh =
          req.query.refresh === "true";

        /*
         * TEMPORARY DATA CATALOGUE DIAGNOSTICS
         *
         * This does not change catalogue behaviour.
         * It only tells us whether this route is being
         * reached and what getPlans() returns.
         */
        console.log(
          "[DATA DEBUG] GET /api/data/plans requested",
          {
            network: network ?? null,
            type: type ?? null,
            forceRefresh,
            uid: req.user?.uid || req.user?.userId || null,
          }
        );

        console.log(
          "[DATA DEBUG] Calling getPlans()..."
        );

        const plans = await getPlans({
          network,
          type,
          forceRefresh,
        });

        console.log(
          "[DATA DEBUG] getPlans() completed",
          {
            isArray: Array.isArray(plans),
            planCount: Array.isArray(plans)
              ? plans.length
              : null,
          }
        );

        if (
          Array.isArray(plans) &&
          plans.length > 0
        ) {
          console.log(
            "[DATA DEBUG] First returned plan:",
            plans[0]
          );
        } else {
          console.log(
            "[DATA DEBUG] NO PLANS RETURNED BY getPlans()"
          );
        }

        console.log(
          "[DATA DEBUG] Sending catalogue response to frontend",
          {
            planCount: Array.isArray(plans)
              ? plans.length
              : 0,
          }
        );

        return res.status(200).json({
          ok: true,
          plans,
        });
      } catch (error) {
        console.error(
          "[DATA DEBUG] Catalogue request FAILED",
          {
            message: error?.message,
            code: error?.code,
            stack: error?.stack,
          }
        );

        console.error(
          "Data catalogue error:",
          error
        );

        const code = error?.code;

        if (
          code === "INVALID_NETWORK" ||
          code === "INVALID_DATA_NETWORK" ||
          code === "INVALID_DATA_PLAN_TYPE" ||
          code === "INVALID_PLAN_TYPE"
        ) {
          return res.status(400).json({
            ok: false,
            error: "Invalid Data plan filter",
          });
        }

        if (
          code === "BABSPAY_AUTH_ERROR" ||
          code === "BABSPAY_CATALOGUE_AUTH_ERROR"
        ) {
          return res.status(502).json({
            ok: false,
            error:
              "Data service configuration error",
          });
        }

        if (
          code === "BABSPAY_RATE_LIMITED"
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "Data service is temporarily busy",
          });
        }

        if (
          code === "BABSPAY_PROVIDER_ERROR" ||
          code === "BABSPAY_CATALOG_REQUEST_ERROR" ||
          code === "BABSPAY_INVALID_JSON" ||
          code === "BABSPAY_CATALOGUE_NOT_SUCCESSFUL"
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "Data plans are temporarily unavailable",
          });
        }

        return res.status(500).json({
          ok: false,
          error:
            "Unable to load Data plans",
        });
      }
    }
  );

  router.post(
    "/purchase",
    requireAuth,
    async (req, res) => {
      try {
        const uid =
          req.user?.uid ||
          req.user?.userId;

        const result =
          await purchaseData({
            uid,

            network:
              req.body?.network,

            phoneNumber:
              req.body?.phoneNumber,

            planId:
              req.body?.planId,

            reference:
              req.body?.reference,
          });

        /*
         * The service is authoritative for the transaction state.
         *
         * Do not expose wallet reservation internals,
         * provider responses, provider balance information,
         * or other internal settlement data.
         */
        const response = {
          ok: true,

          status:
            result.status,

          transactionId:
            result.transactionId,

          reference:
            result.reference,

          customerPriceKobo:
            result.customerPriceKobo,

          providerReference:
            result.providerReference ||
            null,
        };

        if (
          result.status === "successful"
        ) {
          response.message =
            "Data purchase successful.";
        } else if (
          result.status === "pending"
        ) {
          response.message =
            "Your Data purchase is being processed.";
        } else if (
          result.status === "unknown"
        ) {
          response.message =
            "Your Data purchase is being checked. Please check your transaction status.";
        } else if (
          result.status === "failed"
        ) {
          response.message =
            "Data purchase failed.";
        }

        /*
         * Pending and unknown are legitimate transaction states,
         * not HTTP failures. 202 tells the client that processing
         * has not reached a definitive terminal outcome.
         */
        if (
          result.status === "pending" ||
          result.status === "unknown"
        ) {
          return res.status(202).json(
            response
          );
        }

        return res.status(200).json(
          response
        );
      } catch (error) {
        console.error(
          "Data purchase route error:",
          error
        );

        const code = error?.code;

        /*
         * Authentication/identity problems.
         */
        if (
          code === "INVALID_UID"
        ) {
          return res.status(401).json({
            ok: false,
            error:
              "Unable to identify your account.",
          });
        }

        /*
         * Request validation errors.
         */
        if (
          code === "INVALID_REQUEST" ||
          code === "INVALID_NETWORK" ||
          code === "INVALID_PHONE_NUMBER" ||
          code === "INVALID_PLAN_ID" ||
          code === "INVALID_REFERENCE"
        ) {
          return res.status(400).json({
            ok: false,
            error:
              error.message ||
              "Invalid Data purchase request.",
          });
        }

        /*
         * The selected live provider plan disappeared,
         * was disabled, or no longer belongs to the
         * requested network/type.
         */
        if (
          code ===
            "DATA_PLAN_NOT_AVAILABLE" ||
          code ===
            "DATA_PLAN_NOT_ACTIVE"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "Selected Data plan is no longer available.",
          });
        }

        if (
          code ===
          "DATA_PLAN_NETWORK_MISMATCH"
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Selected Data plan does not match the network.",
          });
        }

        if (
          code ===
          "DATA_PLAN_TYPE_MISMATCH"
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Selected Data plan is no longer available.",
          });
        }

        /*
         * Wallet funds are insufficient.
         */
        if (
          code ===
            "INSUFFICIENT_WALLET_BALANCE" ||
          code ===
            "WALLET_INSUFFICIENT_FUNDS"
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Insufficient wallet balance.",
          });
        }

        /*
         * These indicate that NovaPay could not
         * safely establish a usable transaction.
         */
        if (
          code ===
            "RESERVATION_FAILED"
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "Unable to reserve wallet funds. Please try again.",
          });
        }

        if (
          code ===
            "DATA_PRICE_OUT_OF_RANGE" ||
          code ===
            "INVALID_DATA_PLAN_PRICE" ||
          code ===
            "INVALID_PROVIDER_PLAN_PRICE"
        ) {
          return res.status(503).json({
            ok: false,
            error:
              "The selected Data plan is temporarily unavailable.",
          });
        }

        /*
         * A transaction record could not be created after
         * funds were reserved. Do not tell the customer that
         * the purchase simply failed because the funds may
         * still be reserved and reconciliation is required.
         */
        if (
          code ===
          "DATA_TRANSACTION_RECORD_CREATE_FAILED"
        ) {
          return res.status(202).json({
            ok: true,
            status: "unknown",
            error:
              "Your Data purchase is being checked. Please check your transaction status.",
          });
        }

        /*
         * If an ownership/reference/request mismatch occurs,
         * never expose internal transaction details.
         */
        if (
          code ===
            "DATA_TRANSACTION_OWNERSHIP_MISMATCH" ||
          code ===
            "DATA_TRANSACTION_REFERENCE_MISMATCH" ||
          code ===
            "DATA_TRANSACTION_REQUEST_MISMATCH" ||
          code ===
            "RESERVATION_OWNERSHIP_MISMATCH" ||
          code ===
            "RESERVATION_IDENTITY_MISMATCH"
        ) {
          return res.status(409).json({
            ok: false,
            error:
              "This Data transaction could not be processed.",
          });
        }

        /*
         * Provider/network uncertainty must never be
         * converted into a definite failure.
         *
         * The service itself normally returns an unknown
         * transaction rather than throwing for provider
         * uncertainty. These mappings protect against
         * lower-layer implementations that may still throw.
         */
        if (
          code ===
            "BABSPAY_REQUEST_ERROR" ||
          code ===
            "BABSPAY_TIMEOUT" ||
          code ===
            "BABSPAY_PROVIDER_ERROR" ||
          code ===
            "DATA_PROVIDER_TIMEOUT" ||
          code ===
            "DATA_PROVIDER_UNKNOWN"
        ) {
          return res.status(202).json({
            ok: true,
            status: "unknown",
            error:
              "Your Data purchase is being checked. Please check the transaction status.",
          });
        }

        /*
         * Never turn a confirmed provider-success/settlement
         * problem into a customer-facing "failed" response.
         * The transaction must remain recoverable by
         * reconciliation.
         */
        if (
          code ===
            "WALLET_COMMIT_FAILED" ||
          code ===
            "WALLET_RELEASE_FAILED"
        ) {
          return res.status(202).json({
            ok: true,
            status: "unknown",
            error:
              "Your Data purchase is being checked. Please check the transaction status.",
          });
        }

        return res.status(500).json({
          ok: false,
          error:
            "Unable to complete Data purchase.",
        });
      }
    }
  );

  router.get(
    "/status/:transactionId",
    requireAuth,
    async (req, res) => {
      try {
        const uid =
          req.user?.uid ||
          req.user?.userId;

        const result =
          await getPurchaseStatus({
            uid,

            transactionId:
              req.params.transactionId,
          });

        return res.status(200).json({
          ok: true,
          ...result,
        });
      } catch (error) {
        console.error(
          "Data status route error:",
          error
        );

        const code =
          error?.code;

        if (
          code === "INVALID_UID"
        ) {
          return res.status(401).json({
            ok: false,
            error:
              "Unable to identify your account.",
          });
        }

        if (
          code ===
          "INVALID_DATA_TRANSACTION_ID"
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Invalid Data transaction ID.",
          });
        }

        if (
          code ===
          "DATA_TRANSACTION_NOT_FOUND"
        ) {
          return res.status(404).json({
            ok: false,
            error:
              "Data transaction not found.",
          });
        }

        if (
          code ===
          "DATA_TRANSACTION_OWNERSHIP_MISMATCH"
        ) {
          return res.status(403).json({
            ok: false,
            error:
              "You do not have access to this transaction.",
          });
        }

        return res.status(500).json({
          ok: false,
          error:
            "Unable to retrieve Data transaction status.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createDataRouter,
};