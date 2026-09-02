// NovaPay backend deployment update
require("dotenv").config();

const notificationRoutes =
    require("./notifications/routes");
const transactionRoutes =
  require("./transactions/routes.js");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("./auth");
const { db, auth: adminAuth } = require("./firebase-admin");
const {
  getWallet
} = require("./wallet.js/wallet");
const airtimeRoutes = require("./airtime/routes");
const addMoneyRoutes = require("./add-money/routes");
const dataRoutes = require("./data/routes");
const {
  handlePaystackWebhook
} = require("./add-money/paystack/webhook");
const app = express();

app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || false;

// =====================================================
// NOVAPAY BACKEND — SECURITY FOUNDATION
// =====================================================

// Hide Express fingerprint
app.disable("x-powered-by");

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// Request ID for every request
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  next();
});

// =====================================================
// JSON BODY LIMIT
// =====================================================
//
// Keep the original request body available for
// Paystack webhook signature verification.
//
// All normal JSON API requests continue to work
// exactly as before.
// =====================================================

app.use(
  express.json({
    limit: "100kb",

    verify: (req, res, buffer) => {

      if (
        req.originalUrl ===
        "/api/add-money/paystack/webhook"
      ) {

        req.rawBody =
          Buffer.from(buffer);

      }

    }
  })
);
app.post(
  "/api/add-money/paystack/webhook",
  handlePaystackWebhook
);

// URL-encoded body limit
app.use(
  express.urlencoded({
    extended: false,
    limit: "100kb",
  })
);

// CORS
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
  })
);

// =====================================================
// RATE LIMITING
// =====================================================

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please try again later.",
  },
});

app.use("/api", apiLimiter);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "NovaPay Backend",
    status: "online",
    requestId: req.requestId,
  });
});

// =====================================================
// API BASE ROUTE
// =====================================================

app.get("/api", (req, res) => {
  res.status(200).json({
    success: true,
    service: "NovaPay API",
    status: "online",
    requestId: req.requestId,
  });
}); 
// =====================================================
// WALLET
// =====================================================
//
// The frontend gets the wallet balance through the
// authenticated backend.
//
// The UID comes from the verified Firebase ID token.
// The frontend never supplies the UID.
// =====================================================

app.get(
  "/api/wallet",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.user.uid;

      const wallet =
        await getWallet(uid);

      return res.status(200).json({

        success: true,

        wallet: {

          balanceKobo:
            wallet.balanceKobo,

          currency:
            wallet.currency ||
            "NGN"

        },

        requestId:
          req.requestId

      });

    } catch (error) {

      console.error(
        "NovaPay wallet retrieval error:",
        error
      );

      return res.status(500).json({

        success: false,

        error:
          "Unable to retrieve wallet balance.",

        requestId:
          req.requestId

      });

    }

  }
);

// =====================================================
// ADD MONEY
// =====================================================

app.use(
  "/api/add-money",
  addMoneyRoutes
);

app.use(
  "/api/transactions",
  transactionRoutes
);
app.use(
    "/api/notifications",
    notificationRoutes
);
app.use(
  "/api/airtime",
  airtimeRoutes
);
app.use(
  "/api/data",
  dataRoutes
);


// =====================================================
// PROTECTED AUTH TEST ROUTE
// =====================================================

app.get("/api/protected", requireAuth, (req, res) => {
  res.status(200).json({
    success: true,
    message: "Authenticated",
    user: req.user,
    requestId: req.requestId,
  });
});// =====================================================
// REGISTRATION — SECURE PHONE CLAIM
// =====================================================

app.post("/api/registration/claim-phone", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const phone = String(req.body.phone || "").trim();

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Phone number is required.",
        requestId: req.requestId,
      });
    }

    // Normalize phone number.
    // Keep digits only so formatting differences don't create duplicates.
    const normalizedPhone = phone.replace(/\D/g, "");

    if (normalizedPhone.length < 7 || normalizedPhone.length > 15) {
      return res.status(400).json({
        success: false,
        error: "Invalid phone number.",
        requestId: req.requestId,
      });
    }

    // Never use the raw phone number as a Firestore document ID.
    const phoneKey = crypto
      .createHash("sha256")
      .update(normalizedPhone)
      .digest("hex");

    const phoneRef = db.collection("phoneRegistry").doc(phoneKey);
    const userRef = db.collection("users").doc(uid);

    await db.runTransaction(async (transaction) => {
      const phoneSnapshot = await transaction.get(phoneRef);

      // Phone already belongs to another account.
      if (phoneSnapshot.exists) {
        const existingUid = phoneSnapshot.data().uid;

        if (existingUid !== uid) {
          const error = new Error("PHONE_ALREADY_REGISTERED");
          error.code = "PHONE_ALREADY_REGISTERED";
          throw error;
        }

        // Same user is retrying registration.
        transaction.set(
          userRef,
          {
            phone: normalizedPhone,
            phoneVerified: false,
            updatedAt: new Date(),
          },
          { merge: true }
        );

        return;
      }

      // Claim the phone number.
      transaction.create(phoneRef, {
        uid,
        createdAt: new Date(),
      });

      // Save the normalized phone on the user's profile.
      transaction.set(
        userRef,
        {
          phone: normalizedPhone,
          phoneVerified: false,
          updatedAt: new Date(),
        },
        { merge: true }
      );
    });

    return res.status(200).json({
      success: true,
      message: "Phone number registered successfully.",
      requestId: req.requestId,
    });

  } catch (error) {

    if (error.code === "PHONE_ALREADY_REGISTERED") {

      // Delete the newly-created Firebase account because
      // the phone number is already owned by another account.
      try {
        await adminAuth.deleteUser(req.user.uid);
      } catch (deleteError) {
        console.error(
          "Failed to remove duplicate registration:",
          deleteError
        );
      }

      return res.status(409).json({
        success: false,
        error: "This phone number is already registered.",
        requestId: req.requestId,
      });
    }

    console.error(
      "Phone registration error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Unable to complete registration.",
      requestId: req.requestId,
    });
  }
});

// =====================================================
// 404 HANDLER
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    requestId: req.requestId,
  });
});

// =====================================================
// CENTRAL ERROR HANDLER
// =====================================================

app.use((err, req, res, next) => {
  console.error("Backend error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    error: "Internal server error",
    requestId: req.requestId,
  });
});

// =====================================================
// SERVER START
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NovaPay backend running on port ${PORT}`);
});