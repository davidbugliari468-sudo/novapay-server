const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Convert literal \n into real newlines if Render stored them that way
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/**
 * Verify Firebase ID token sent by the frontend.
 *
 * The frontend must send:
 * Authorization: Bearer <Firebase ID token>
 */
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

    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // IMPORTANT:
    // We get the UID from Firebase's verified token.
    // We do NOT trust a UID supplied by the frontend.
    req.user = decodedToken;
    req.uid = decodedToken.uid;

    next();
  } catch (error) {
    console.error("Firebase authentication error:", error.message);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
}

module.exports = {
  admin,
  db,
  verifyFirebaseToken,
};