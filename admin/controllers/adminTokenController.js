const {
  getSuperAdmin,
  updateSuperAdminToken
} = require("../services/adminCredentialStore");

const {
  createTokenCredential
} = require("../services/adminTokenService");


async function changeAdminToken(req, res) {

  try {

    // =====================================================
    // GET UID FROM REQUEST
    // =====================================================

    const {
      uid
    } = req.body || {};


    // =====================================================
    // CHECK UID
    // =====================================================

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


    // =====================================================
    // LOAD CURRENT SUPER ADMIN
    // =====================================================

    const admin =
      await getSuperAdmin();


    if (!admin) {

      return res.status(503).json({
        success: false,
        error: "Admin security system is not initialized.",
        requestId: req.requestId
      });

    }


    // =====================================================
    // CHECK ADMIN STATUS
    // =====================================================

    if (admin.status !== "active") {

      return res.status(403).json({
        success: false,
        error: "Admin account is not active.",
        requestId: req.requestId
      });

    }


    // =====================================================
    // VERIFY STORED ADMIN UID
    // =====================================================

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


    // =====================================================
    // GENERATE NEW ADMIN TOKEN
    // =====================================================

    const newCredential =
      createTokenCredential();


    // =====================================================
    // REPLACE OLD TOKEN HASH
    // =====================================================

    await updateSuperAdminToken(
      newCredential.tokenHash
    );


    // =====================================================
    // RETURN NEW TOKEN ONCE
    // =====================================================

    return res.status(200).json({

      success: true,

      message: "Admin token changed successfully.",

      token: newCredential.token,

      requestId: req.requestId

    });


  } catch (error) {

    console.error(
      "Admin token change error:",
      error.message
    );


    return res.status(500).json({
      success: false,
      error: "Unable to change admin token.",
      requestId: req.requestId
    });

  }

}


module.exports = {
  changeAdminToken
};