const {
  revokeCurrentAdminSession
} = require("../services/adminSessionService");


async function adminLogout(req, res) {

  try {

    // =====================================================
    // GET CURRENT ADMIN SESSION
    // =====================================================

    const sessionId =
      req.adminSession &&
      req.adminSession.sessionId;


    if (
      typeof sessionId !== "string" ||
      !sessionId
    ) {

      return res.status(401).json({
        success: false,
        error: "Admin session required",
        requestId: req.requestId
      });

    }


    // =====================================================
    // REVOKE CURRENT SESSION
    // =====================================================

    await revokeCurrentAdminSession(
      sessionId
    );


    // =====================================================
    // SUCCESS
    // =====================================================

    return res.status(200).json({

      success: true,

      message: "Admin logout successful.",

      requestId: req.requestId

    });


  } catch (error) {

    console.error(
      "Admin logout error:",
      error.message
    );


    return res.status(500).json({
      success: false,
      error: "Unable to logout admin.",
      requestId: req.requestId
    });

  }

}


module.exports = {
  adminLogout
};