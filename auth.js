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