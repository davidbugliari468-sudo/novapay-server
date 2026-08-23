// NovaPay backend deployment update
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("./auth");
require("dotenv").config();

const app = express();

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

// JSON body limit
app.use(express.json({ limit: "100kb" }));

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
// PROTECTED AUTH TEST ROUTE
// =====================================================

app.get("/api/protected", requireAuth, (req, res) => {
  res.status(200).json({
    success: true,
    message: "Authenticated",
    user: req.user,
    requestId: req.requestId,
  });
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