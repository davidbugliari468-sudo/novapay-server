require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

// --------------------------------------------------
// BASIC SECURITY CONFIGURATION
// --------------------------------------------------

app.disable("x-powered-by");

app.set("trust proxy", 1);

// --------------------------------------------------
// SECURITY HEADERS
// --------------------------------------------------

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

// --------------------------------------------------
// CORS
// --------------------------------------------------

if (!FRONTEND_ORIGIN) {
  console.error("FRONTEND_ORIGIN is not configured.");
  process.exit(1);
}

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false
  })
);

// --------------------------------------------------
// REQUEST SIZE LIMITS
// --------------------------------------------------

app.use(
  express.json({
    limit: "100kb"
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "50kb"
  })
);

// --------------------------------------------------
// GLOBAL RATE LIMIT
// --------------------------------------------------

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again later."
  }
});

app.use(globalLimiter);

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "NovaPay API"
  });
});

// --------------------------------------------------
// 404 HANDLER
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found."
  });
});

// --------------------------------------------------
// GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  res.status(500).json({
    error: "An unexpected server error occurred."
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`NovaPay API running on port ${PORT}`);
});

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------

function shutdown(signal) {
  console.log(`${signal} received. Shutting down NovaPay API...`);

  server.close(() => {
    console.log("NovaPay API stopped.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));