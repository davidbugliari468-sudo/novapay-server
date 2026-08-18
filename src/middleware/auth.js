const { admin } = require("../config/firebase");

async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const idToken = authHeader.substring(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        message: "Authentication token missing",
      });
    }

    const decodedToken =
      await admin.auth().verifyIdToken(idToken);

    // UID comes only from Firebase's verified token.
    req.user = decodedToken;
    req.uid = decodedToken.uid;

    next();
  } catch (error) {
    console.error(
      "Firebase authentication error:",
      error.message
    );

    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
}

module.exports = {
  verifyFirebaseToken,
};