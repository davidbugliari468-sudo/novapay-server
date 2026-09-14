const {
  validateAdminSession
} = require("../services/adminSessionService");

async function requireAdminSession(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Admin session required",
      requestId: req.requestId
    });
  }

  const sessionCredential = header.slice(7).trim();

  if (!sessionCredential) {
    return res.status(401).json({
      success: false,
      error: "Admin session required",
      requestId: req.requestId
    });
  }

  const separatorIndex = sessionCredential.indexOf(".");

  if (separatorIndex <= 0 || separatorIndex === sessionCredential.length - 1) {
    return res.status(401).json({
      success: false,
      error: "Invalid admin session",
      requestId: req.requestId
    });
  }

  const sessionId = sessionCredential.slice(0, separatorIndex);
  const sessionToken = sessionCredential.slice(separatorIndex + 1);

  try {
    const session = await validateAdminSession({
      sessionId,
      sessionToken,
      adminId: "superAdmin"
    });

    if (!session.valid) {
      return res.status(401).json({
        success: false,
        error: session.error || "Invalid or expired admin session",
        requestId: req.requestId
      });
    }

    req.adminSession = {
      sessionId,
      adminId: session.adminId,
      expiresAt: session.expiresAt
    };

    req.admin = {
      id: session.adminId,
      role: "superAdmin"
    };

    next();
  } catch (error) {
    console.error(
      "Admin session verification failed:",
      error.message
    );

    return res.status(401).json({
      success: false,
      error: "Invalid or expired admin session",
      requestId: req.requestId
    });
  }
}

module.exports = {
  requireAdminSession
};