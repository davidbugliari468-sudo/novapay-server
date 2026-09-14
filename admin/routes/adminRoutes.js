const express = require("express");

const {
  adminLogin
} = require("../controllers/adminLoginController");

const {
  changeAdminToken
} = require("../controllers/adminTokenController");

const {
  recoverAdminToken
} = require("../controllers/adminTokenRecoveryController");

const {
  checkAdminLock
} = require("../middleware/adminRateLimiter");

const {
  requireAdminSession
} = require("../middleware/requireAdminSession");


const router = express.Router();


// =====================================================
// ADMIN LOGIN
// =====================================================
//
// Public route.
// Login protection is handled by checkAdminLock.
//
// POST /api/admin/login
// =====================================================

router.post(
  "/login",
  checkAdminLock,
  adminLogin
);


// =====================================================
// FORGOT PASSWORD
// =====================================================
//
// Public recovery route.
// The UID is verified by the backend before a new
// admin token is generated.
//
// POST /api/admin/forgot-password
// =====================================================

router.post(
  "/forgot-password",
  recoverAdminToken
);


// =====================================================
// CHANGE ADMIN TOKEN
// =====================================================
//
// Protected route.
// A valid admin session is required.
//
// POST /api/admin/change-token
// =====================================================

router.post(
  "/change-token",
  requireAdminSession,
  changeAdminToken
);


module.exports = router;