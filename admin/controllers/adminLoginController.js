const {
  getSuperAdmin,
  resetLoginProtection
} = require("../services/adminCredentialStore");

const {
  verifyAdminToken
} = require("../services/adminTokenService");

const {
  createAdminSession
} = require("../services/adminSessionService");

const {
  recordFailedAdminLogin
} = require("../middleware/adminRateLimiter");


// =====================================================
// ADMIN LOGIN CONTROLLER
// =====================================================
//
// Handles authentication for the NovaPay Admin
// Management System.
//
// IMPORTANT:
//
// - This is NOT an admin registration system.
// - No admin account can be created here.
// - UID is never returned to the frontend.
// - The token is verified against its stored hash.
// - Failed attempts are handled by the admin rate
//   limiter.
// - A secure admin session is created after successful
//   authentication.
// =====================================================


// -----------------------------------------------------
// ADMIN LOGIN
// -----------------------------------------------------

async function adminLogin(req, res) {

  try {

    // -------------------------------------------------
    // GET LOGIN INPUT
    // -------------------------------------------------

    const {
      superAdmin,
      token
    } = req.body || {};


    // -------------------------------------------------
    // BASIC INPUT CHECK
    // -------------------------------------------------

    if (
      typeof superAdmin !== "string" ||
      !superAdmin.trim()
    ) {

      return res.status(401).json({
        success: false,
        error: "Email address incorrect",
        requestId: req.requestId
      });
    }


    if (
      typeof token !== "string" ||
      !token.trim()
    ) {

      return res.status(401).json({
        success: false,
        error: "Password incorrect",
        requestId: req.requestId
      });
    }


    // -------------------------------------------------
    // GET CURRENT ADMIN
    // -------------------------------------------------

    const admin =
      await getSuperAdmin();


    if (!admin) {

      return res.status(503).json({
        success: false,
        error: "Admin security system is not initialized.",
        requestId: req.requestId
      });
    }


    // -------------------------------------------------
    // VERIFY ADMIN STATUS
    // -------------------------------------------------

    if (
      admin.status !== "active"
    ) {

      return res.status(403).json({
        success: false,
        error: "Admin account is not active.",
        requestId: req.requestId
      });
    }


    // -------------------------------------------------
    // VERIFY ADMIN IDENTIFIER
    // -------------------------------------------------
    //
    // The actual configured value remains on the
    // backend.
    // -------------------------------------------------

    const identifierMatches =
      superAdmin.trim() ===
      String(admin.superAdmin);


    if (!identifierMatches) {

      const result =
        await recordFailedAdminLogin();


      if (result.locked) {

        return res.status(429).json({
          success: false,
          error: "Too many failed attempts. Admin login is temporarily locked.",
          lockedUntil: result.lockedUntil,
          requestId: req.requestId
        });
      }


      return res.status(401).json({
        success: false,
        error: "Email address incorrect",
        requestId: req.requestId
      });
    }


    // -------------------------------------------------
    // VERIFY ADMIN TOKEN
    // -------------------------------------------------

    const tokenMatches =
      verifyAdminToken(
        token.trim(),
        admin.tokenHash
      );


    if (!tokenMatches) {

      const result =
        await recordFailedAdminLogin();


      if (result.locked) {

        return res.status(429).json({
          success: false,
          error: "Too many failed attempts. Admin login is temporarily locked.",
          lockedUntil: result.lockedUntil,
          requestId: req.requestId
        });
      }


      return res.status(401).json({
        success: false,
        error: "Password incorrect",
        requestId: req.requestId
      });
    }


    // -------------------------------------------------
    // SUCCESSFUL AUTHENTICATION
    // -------------------------------------------------
    //
    // Clear the failed-attempt counter first.
    // -------------------------------------------------

    await resetLoginProtection();


    // -------------------------------------------------
    // CREATE SECURE ADMIN SESSION
    // -------------------------------------------------
    //
    // The admin document ID is used internally only.
    // It is never returned to the frontend.
    // -------------------------------------------------

    const session =
      await createAdminSession({
        adminId: "superAdmin"
      });


    // -------------------------------------------------
    // RETURN SECURE LOGIN RESULT
    // -------------------------------------------------
    //
    // Return only what the frontend needs to maintain
    // the authenticated admin session.
    //
    // Never return:
    // - adminUid
    // - tokenHash
    // - raw admin token
    // - Firestore admin document
    // -------------------------------------------------

    return res.status(200).json({
      success: true,
      message: "Admin authentication successful",

      session: {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        expiresAt: session.expiresAt
      },

      admin: {
        role: admin.role,
        status: admin.status
      },

      requestId: req.requestId
    });

  } catch (error) {

    console.error(
      "Admin login error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Unable to process admin login.",
      requestId: req.requestId
    });
  }
}


// -----------------------------------------------------
// EXPORTS
// -----------------------------------------------------

module.exports = {
  adminLogin
};