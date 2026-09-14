const { auth } = require("./firebase-admin");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
      requestId: req.requestId,
    });
  }

  const idToken = header.slice(7).trim();

  if (!idToken) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
      requestId: req.requestId,
    });
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
      emailVerified: decodedToken.email_verified === true,
    };

    next();
  } catch (error) {
    console.error("Authentication verification failed:", error.message);

    return res.status(401).json({
      success: false,
      error: "Invalid or expired authentication token",
      requestId: req.requestId,
    });
  }
}

module.exports = { requireAuth }; 
console.log("========== AUTH VERIFY DIAGNOSTIC ==========");

console.log(
  "[AUTH] Authorization header present:",
  Boolean(header)
);

console.log(
  "[AUTH] Bearer token present:",
  Boolean(idToken)
);

console.log(
  "[AUTH] Request origin:",
  req.headers.origin || "NO ORIGIN"
);

console.log(
  "[AUTH] Request host:",
  req.headers.host || "NO HOST"
);

console.log(
  "[AUTH] Attempting Firebase ID token verification..."
);

console.log("=============================================");