const express = require("express");

const {
  adminLogin
} = require("../controllers/adminLoginController");

const {
  changeAdminToken
} = require("../controllers/adminTokenController");

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