const {
  getSuperAdmin,
  updateLoginProtection
} = require("../services/adminCredentialStore");


// =====================================================
// ADMIN RATE LIMITER
// =====================================================
//
// Protects the NovaPay Admin Management System from
// repeated failed authentication attempts.
//
// SECURITY RULE:
//
// 3 failed attempts
//        ↓
// 30-minute lockout
//
// This middleware works with the admin record stored
// in Firestore.
// =====================================================


// -----------------------------------------------------
// SECURITY SETTINGS
// -----------------------------------------------------

const MAX_FAILED_ATTEMPTS = 3;

const LOCKOUT_MINUTES = 30;

const LOCKOUT_DURATION_MS =
  LOCKOUT_MINUTES * 60 * 1000;


// -----------------------------------------------------
// CHECK ADMIN LOCK STATUS
// -----------------------------------------------------

async function checkAdminLock(req, res, next) {

  try {

    const admin =
      await getSuperAdmin();


    // -------------------------------------------------
    // ADMIN RECORD MUST EXIST
    // -------------------------------------------------

    if (!admin) {

      return res.status(503).json({
        success: false,
        error: "Admin security system is not initialized.",
        requestId: req.requestId
      });
    }


    // -------------------------------------------------
    // CHECK CURRENT LOCK
    // -------------------------------------------------

    if (admin.lockedUntil) {

      const lockedUntil =
        new Date(admin.lockedUntil);

      const now =
        new Date();


      // -----------------------------------------------
      // LOCK IS STILL ACTIVE
      // -----------------------------------------------

      if (
        !Number.isNaN(lockedUntil.getTime()) &&
        lockedUntil > now
      ) {

        return res.status(429).json({
          success: false,
          error: "Too many failed attempts. Admin login is temporarily locked.",
          lockedUntil: lockedUntil.toISOString(),
          lockoutMinutes: LOCKOUT_MINUTES,
          requestId: req.requestId
        });
      }


      // -----------------------------------------------
      // LOCK HAS EXPIRED
      // -----------------------------------------------
      //
      // Clear the expired lock before continuing.
      // -----------------------------------------------

      await updateLoginProtection({
        failedAttempts: 0,
        lockedUntil: null
      });

      admin.failedAttempts = 0;
      admin.lockedUntil = null;
    }


    // -------------------------------------------------
    // ATTACH ADMIN SECURITY STATE
    // -------------------------------------------------

    req.adminSecurity = {
      failedAttempts:
        Number(admin.failedAttempts) || 0,

      lockedUntil:
        admin.lockedUntil || null
    };


    next();

  } catch (error) {

    console.error(
      "Admin rate limiter error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Unable to verify admin login protection.",
      requestId: req.requestId
    });
  }
}


// -----------------------------------------------------
// RECORD FAILED LOGIN
// -----------------------------------------------------
//
// The login controller will call this after an invalid
// admin identifier or token.
//
// On the third failure, a 30-minute lock is created.
// -----------------------------------------------------

async function recordFailedAdminLogin() {

  const admin =
    await getSuperAdmin();

  if (!admin) {
    throw new Error(
      "Admin security system is not initialized."
    );
  }


  const currentAttempts =
    Number(admin.failedAttempts) || 0;

  const failedAttempts =
    currentAttempts + 1;


  // ---------------------------------------------------
  // LOCK AFTER THIRD FAILURE
  // ---------------------------------------------------

  if (
    failedAttempts >=
    MAX_FAILED_ATTEMPTS
  ) {

    const lockedUntil =
      new Date(
        Date.now() +
        LOCKOUT_DURATION_MS
      ).toISOString();

    await updateLoginProtection({
      failedAttempts,
      lockedUntil
    });

    return {
      failedAttempts,
      locked: true,
      lockedUntil
    };
  }


  // ---------------------------------------------------
  // STORE FAILED ATTEMPT
  // ---------------------------------------------------

  await updateLoginProtection({
    failedAttempts,
    lockedUntil: null
  });

  return {
    failedAttempts,
    locked: false,
    lockedUntil: null
  };
}


// -----------------------------------------------------
// EXPORTS
// -----------------------------------------------------

module.exports = {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES,

  checkAdminLock,
  recordFailedAdminLogin
};