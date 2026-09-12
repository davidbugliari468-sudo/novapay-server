"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const { requireAuth } = require("../auth");

const {
  validateNIN,
  validateBVN,
} = require("./validation");

const {
  verifyNINForUser,
  verifyBVNForUser,
  getKYCStatus,
} = require("./service");

const router = express.Router();

/*
 * KYC requests can cause real provider charges.
 *
 * This limiter is intentionally much stricter than the
 * global /api rate limiter.
 *
 * The authenticated user's UID is used as the limiter key
 * so multiple requests from the same user are grouped
 * together even if their IP changes.
 */
const kycRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,

  standardHeaders: "draft-8",
  legacyHeaders: false,

  keyGenerator: (req) => {
    if (req.user?.uid) {
      return `kyc-user:${req.user.uid}`;
    }

    return `kyc-ip:${req.ip}`;
  },

  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      error:
        "Too many verification attempts. Please try again later.",
      requestId: req.requestId,
    });
  },
});

/*
 * POST /api/kyc/nin
 *
 * Verifies a user's NIN through the NovaPay backend.
 *
 * The frontend sends:
 * {
 *   "nin": "12345678901"
 * }
 *
 * Firebase authentication is still required.
 * Email verification is NOT required for KYC.
 */
router.post(
  "/nin",
  requireAuth,
  kycRateLimiter,
  async (req, res) => {
    try {
      const validation = validateNIN(req.body?.nin);

      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: "NIN must contain exactly 11 digits.",
          requestId: req.requestId,
        });
      }

      const nin = validation.data;

      /*
       * IMPORTANT:
       * Do not accept req.body.userId.
       *
       * The UID comes exclusively from the Firebase ID token.
       */
      const result = await verifyNINForUser(
        req.user.uid,
        nin
      );

      if (result.state === "invalid") {
        return res.status(400).json({
          success: false,
          error: result.error,
          requestId: req.requestId,
        });
      }

      if (result.state === "pending") {
        return res.status(202).json({
          success: true,
          state: "pending",
          tier: result.tier,
          message: result.message,
          nin: result.nin,
          requestId: req.requestId,
        });
      }

      if (result.state === "verified") {
        return res.status(200).json({
          success: true,
          state: "verified",
          alreadyVerified:
            result.alreadyVerified === true,
          tier: result.tier,
          message: result.message,
          nin: result.nin,
          requestId: req.requestId,
        });
      }

      return res.status(422).json({
        success: false,
        state: result.state || "failed",
        tier: result.tier,
        error:
          result.error ||
          "NIN verification was unsuccessful.",
        requestId: req.requestId,
      });
    } catch (error) {
      /*
       * Do not pass raw KYC/provider errors to the central
       * error handler because they could potentially contain
       * sensitive provider response information.
       */
      console.error(
        "NIN verification route failed:",
        {
          requestId: req.requestId,
          uid: req.user?.uid,
          code: error?.code || "UNKNOWN",
        }
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to process NIN verification right now.",
        requestId: req.requestId,
      });
    }
  }
);

/*
 * POST /api/kyc/bvn
 *
 * Verifies a user's BVN through the NovaPay backend.
 *
 * The frontend sends:
 * {
 *   "bvn": "22345678901"
 * }
 *
 * Firebase authentication is still required.
 * Email verification is NOT required for KYC.
 */
router.post(
  "/bvn",
  requireAuth,
  kycRateLimiter,
  async (req, res) => {
    try {
      const validation = validateBVN(req.body?.bvn);

      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: "BVN must contain exactly 11 digits.",
          requestId: req.requestId,
        });
      }

      const bvn = validation.data;

      /*
       * Again, the UID is obtained from the verified Firebase
       * authentication token and never from the request body.
       */
      const result = await verifyBVNForUser(
        req.user.uid,
        bvn
      );

      if (result.state === "invalid") {
        return res.status(400).json({
          success: false,
          error: result.error,
          requestId: req.requestId,
        });
      }

      if (result.state === "tier_required") {
        return res.status(403).json({
          success: false,
          state: "tier_required",
          tier: result.tier,
          error: result.error,
          requestId: req.requestId,
        });
      }

      if (result.state === "pending") {
        return res.status(202).json({
          success: true,
          state: "pending",
          tier: result.tier,
          message: result.message,
          bvn: result.bvn,
          requestId: req.requestId,
        });
      }

      if (result.state === "verified") {
        return res.status(200).json({
          success: true,
          state: "verified",
          alreadyVerified:
            result.alreadyVerified === true,
          tier: result.tier,
          message: result.message,
          bvn: result.bvn,
          requestId: req.requestId,
        });
      }

      return res.status(422).json({
        success: false,
        state: result.state || "failed",
        tier: result.tier,
        error:
          result.error ||
          "BVN verification was unsuccessful.",
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(
        "BVN verification route failed:",
        {
          requestId: req.requestId,
          uid: req.user?.uid,
          code: error?.code || "UNKNOWN",
        }
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to process BVN verification right now.",
        requestId: req.requestId,
      });
    }
  }
);

/*
 * GET /api/kyc/status
 *
 * Returns only safe KYC status information.
 *
 * No NIN/BVN values are returned.
 *
 * Firebase authentication is still required.
 * Email verification is NOT required for KYC.
 */
router.get(
  "/status",
  requireAuth,
  async (req, res) => {
    try {
      const result = await getKYCStatus(
        req.user.uid
      );

      return res.status(200).json({
        ...result,
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(
        "KYC status route failed:",
        {
          requestId: req.requestId,
          uid: req.user?.uid,
          code: error?.code || "UNKNOWN",
        }
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to retrieve verification status right now.",
        requestId: req.requestId,
      });
    }
  }
);

module.exports = router;