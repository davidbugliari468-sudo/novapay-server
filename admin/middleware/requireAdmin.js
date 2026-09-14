const { auth } = require("../../firebase-admin");

async function requireAdmin(req, res, next) {
  // -----------------------------------------------------
  // AUTHENTICATION CHECK
  // -----------------------------------------------------
  //
  // requireAuth must run before requireAdmin.
  // This makes sure req.user has already been created
  // from a verified Firebase ID token.
  //
  if (!req.user || !req.user.uid) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
      requestId: req.requestId,
    });
  }

  try {
    // ---------------------------------------------------
    // GET THE CURRENT FIREBASE AUTH USER
    // ---------------------------------------------------
    //
    // We use Firebase Admin SDK on the backend.
    // We do NOT trust an admin value sent by the frontend.
    //
    const userRecord = await auth.getUser(req.user.uid);

    // ---------------------------------------------------
    // READ FIREBASE CUSTOM CLAIMS
    // ---------------------------------------------------
    const customClaims = userRecord.customClaims || {};

    // ---------------------------------------------------
    // ADMIN AUTHORIZATION CHECK
    // ---------------------------------------------------
    //
    // NovaPay admin users must have:
    //
    // adminp: true
    //
    if (customClaims.adminp !== true) {
      return res.status(403).json({
        success: false,
        error: "Admin access required",
        requestId: req.requestId,
      });
    }

    // ---------------------------------------------------
    // ADMIN CONTEXT
    // ---------------------------------------------------
    //
    // This information is available to later admin
    // routes/controllers through req.admin.
    //
    // We only store information that is needed for
    // server-side authorization and auditing.
    //
    req.admin = {
      uid: req.user.uid,
      email: req.user.email || null,
      role: "admin",
    };

    // ---------------------------------------------------
    // AUTHORIZED
    // ---------------------------------------------------
    next();
  } catch (error) {
    // ---------------------------------------------------
    // FAIL CLOSED
    // ---------------------------------------------------
    //
    // If Firebase Admin cannot verify the authorization,
    // do not allow the request to continue.
    //
    console.error(
      "Admin authorization verification failed:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Unable to verify admin authorization",
      requestId: req.requestId,
    });
  }
}

module.exports = {
  requireAdmin
};