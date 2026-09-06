"use strict";

const express = require("express");

const {
  purchaseData,
  getPurchaseStatus,
  calculateCustomerPriceKobo
} = require("./service");

const {
  getPlans,
  normalizeNetwork,
  normalizeType
} = require("./catalog");

function createDataRouter(requireAuth) {
  const router = express.Router();

  router.get("/plans", requireAuth, async (req, res) => {
    try {
      const network =
        req.query.network === undefined
          ? undefined
          : normalizeNetwork(req.query.network);

      const type =
        req.query.type === undefined
          ? undefined
          : normalizeType(req.query.type);

      const plans = await getPlans({
        network,
        type,
        forceRefresh: req.query.refresh === "true"
      });

      const safePlans = plans.map((plan) => {
        const customerPriceKobo = calculateCustomerPriceKobo(
          plan.priceKobo
        );

        return {
          planId: plan.planId,
          planCode: plan.planCode,
          networkId: plan.networkId,
          networkName: plan.networkName,
          planName: plan.planName,
          planType: plan.planType,
          validity: plan.validity,
          priceKobo: customerPriceKobo,
          priceNaira: customerPriceKobo / 100,
          providerPriceKobo: plan.priceKobo,
          status: plan.status
        };
      });

      res.json({
        ok: true,
        plans: safePlans
      });
    } catch (error) {
      console.error("Data catalogue error:", error);

      const code = error?.code;

      if (
        code === "BABSPAY_AUTH_ERROR" ||
        code === "BABSPAY_CATALOGUE_NOT_SUCCESSFUL"
      ) {
        return res.status(502).json({
          ok: false,
          error: "Data service configuration error"
        });
      }

      if (code === "BABSPAY_RATE_LIMITED") {
        return res.status(503).json({
          ok: false,
          error: "Data service is temporarily busy"
        });
      }

      if (
        code === "BABSPAY_PROVIDER_ERROR" ||
        code === "BABSPAY_CATALOG_REQUEST_ERROR" ||
        code === "BABSPAY_INVALID_JSON"
      ) {
        return res.status(503).json({
          ok: false,
          error: "Data plans are temporarily unavailable"
        });
      }

      if (
        error?.message === "Unsupported network" ||
        error?.message === "Unsupported data plan type"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid Data plan filter"
        });
      }

      return res.status(500).json({
        ok: false,
        error: "Unable to load Data plans"
      });
    }
  });

  router.post("/purchase", requireAuth, async (req, res) => {
    try {
      const uid = req.user?.uid || req.user?.userId;

      const result = await purchaseData({
        uid,
        network: req.body?.network,
        phoneNumber: req.body?.phoneNumber,
        planId: req.body?.planId,
        reference: req.body?.reference
      });

      return res.status(200).json({
        ok: true,
        status: result.status,
        transactionId: result.transactionId,
        reference: result.reference,
        reservationId: result.reservationId,
        plan: result.plan,
        customerPriceKobo: result.customerPriceKobo,
        message: result.message
      });
    } catch (error) {
      console.error("Data purchase route error:", error);

      const code = error?.code;

      if (code === "DATA_VALIDATION_ERROR") {
        return res.status(400).json({
          ok: false,
          error: error.message || "Invalid Data purchase request"
        });
      }

      if (code === "DATA_PLAN_NOT_FOUND") {
        return res.status(404).json({
          ok: false,
          error: "Selected Data plan is no longer available"
        });
      }

      if (code === "DATA_PLAN_NOT_ACTIVE") {
        return res.status(409).json({
          ok: false,
          error: "Selected Data plan is no longer available"
        });
      }

      if (code === "DATA_PLAN_NETWORK_MISMATCH") {
        return res.status(400).json({
          ok: false,
          error: "Selected Data plan does not match the network"
        });
      }

      if (code === "DATA_PLAN_TYPE_MISMATCH") {
        return res.status(400).json({
          ok: false,
          error: "Selected Data plan is invalid"
        });
      }

      if (
        code === "INSUFFICIENT_WALLET_BALANCE" ||
        code === "WALLET_INSUFFICIENT_FUNDS"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Insufficient wallet balance"
        });
      }

      if (code === "DATA_PROVIDER_FAILURE") {
        return res.status(502).json({
          ok: false,
          error: "Data purchase failed"
        });
      }

      if (
        code === "DATA_PROVIDER_TIMEOUT" ||
        code === "DATA_PROVIDER_UNKNOWN"
      ) {
        return res.status(202).json({
          ok: true,
          status: "unknown",
          transactionId: error.transactionId || null,
          reference: error.reference || null,
          error:
            "Your Data purchase is being checked. Please check the transaction status."
        });
      }

      return res.status(500).json({
        ok: false,
        error: "Unable to complete Data purchase"
      });
    }
  });

  router.get(
    "/status/:transactionId",
    requireAuth,
    async (req, res) => {
      try {
        const uid = req.user?.uid || req.user?.userId;

        const result = await getPurchaseStatus({
          uid,
          transactionId: req.params.transactionId
        });

        return res.status(200).json({
          ok: true,
          ...result
        });
      } catch (error) {
        console.error("Data status route error:", error);

        if (error?.code === "DATA_TRANSACTION_NOT_FOUND") {
          return res.status(404).json({
            ok: false,
            error: "Data transaction not found"
          });
        }

        return res.status(500).json({
          ok: false,
          error: "Unable to retrieve Data transaction status"
        });
      }
    }
  );

  return router;
}

module.exports = {
  createDataRouter
};