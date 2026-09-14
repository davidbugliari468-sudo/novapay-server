const {
  getSuperAdmin,
  updateSuperAdminToken
} = require("../services/adminCredentialStore");

const {
  createTokenCredential
} = require("../services/adminTokenService");

const {
  revokeAdminSession
} = require("../services/adminSessionService");


// =====================================================
// ADMIN TOKEN RECOVERY CONTROLLER
// =====================================================
//
// Handles the NovaPay Admin "Forgot Password" flow.
//
// SECURITY MODEL:
//
// - Recovery does not require an existing admin session.
// - The fixed Admin UID must be verified first.
// - A new cryptographically secure token is generated.
// - Only the token hash is stored.
// - The previous token becomes invalid immediately.
// - Any active admin session is revoked.
// - The new raw token is returned only once.
// =====================================================


async function recoverAdminToken(req, res) {

  try {

    // ===================================================
    // GET UID FROM REQUEST
    // ===================================================

    const {
      uid
    } = req.body || {};


    // ===================================================
    // CHECK UID FORMAT
    // ===================================================

    if (
      typeof uid !== "string" ||
      !uid.trim()
    ) {

      return res.status(401).json({
        success: false,
        error: "UID incorrect",
        requestId: req.requestId
      });

    }


    // ===================================================
    // LOAD CURRENT SUPER ADMIN
    // ===================================================

    const admin =
      await getSuperAdmin();


    if (!admin) {

      return res.status(503).json({
        success: false,
        error: "Admin security system is not initialized.",
        requestId: req.requestId
      });

    }


    // ===================================================
    // CHECK ADMIN STATUS
    // ===================================================

    if (
      admin.status !==
      "active"
    ) {

      return res.status(403).json({
        success: false,
        error: "Admin account is not active.",
        requestId: req.requestId
      });

    }


    // ===================================================
    // VERIFY STORED ADMIN UID
    // ===================================================

    const uidMatches =
      uid.trim() ===
      String(admin.adminUid);


    if (!uidMatches) {

      return res.status(401).json({
        success: false,
        error: "UID incorrect",
        requestId: req.requestId
      });

    }


    // ===================================================
    // GENERATE NEW ADMIN TOKEN
    // ===================================================

    const newCredential =
      createTokenCredential();


    // ===================================================
    // REPLACE OLD TOKEN HASH
    // ===================================================

    await updateSuperAdminToken(
      newCredential.tokenHash
    );


    // ===================================================
    // REVOKE CURRENT ADMIN SESSION
    // ===================================================
    //
    // If the admin currently has an active session,
    // changing the password/token must invalidate it.
    // ===================================================

    if (
      typeof admin.activeSessionId === "string" &&
      admin.activeSessionId
    ) {

      await revokeAdminSession(
        admin.activeSessionId
      );

    }


    // ===================================================
    // RETURN NEW TOKEN ONCE
    // ===================================================
    //
    // The raw token is never stored in Firestore.
    // It is returned only in this recovery response.
    // ===================================================

    return res.status(200).json({

      success: true,

      message:
        "Password reset successfully.",

      token:
        newCredential.token,

      requestId:
        req.requestId

    });


  } catch (error) {

    console.error(
      "Admin password recovery error:",
      error.message
    );


    return res.status(500).json({
      success: false,
      error: "Unable to reset admin password.",
      requestId: req.requestId
    });

  }

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  recoverAdminToken
};