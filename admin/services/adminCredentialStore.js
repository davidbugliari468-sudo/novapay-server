const { db } = require("../../firebase-admin");


// =====================================================
// ADMIN CREDENTIAL STORE
// =====================================================
//
// This file is responsible for the backend storage of
// the NovaPay Admin Management System.
//
// IMPORTANT:
//
// - There is NO admin account creation API.
// - The first admin is created only by the backend
//   bootstrap process.
// - After bootstrap, Firestore becomes the authority.
// - The raw admin token is NEVER stored in Firestore.
// - Only the token hash is stored.
// =====================================================


// -----------------------------------------------------
// FIRESTORE COLLECTION
// -----------------------------------------------------

const ADMIN_COLLECTION = "adminManagement";


// -----------------------------------------------------
// SUPER ADMIN DOCUMENT
// -----------------------------------------------------
//
// We start with one super-admin record.
//
// The structure is designed so additional admins can
// be supported later without rebuilding the whole system.
// -----------------------------------------------------

const SUPER_ADMIN_DOCUMENT = "superAdmin";


// -----------------------------------------------------
// GET SUPER ADMIN DOCUMENT
// -----------------------------------------------------

function getSuperAdminRef() {
  return db
    .collection(ADMIN_COLLECTION)
    .doc(SUPER_ADMIN_DOCUMENT);
}


// -----------------------------------------------------
// READ CURRENT SUPER ADMIN
// -----------------------------------------------------

async function getSuperAdmin() {

  const snapshot =
    await getSuperAdminRef().get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data()
  };
}


// -----------------------------------------------------
// CREATE INITIAL SUPER ADMIN
// -----------------------------------------------------
//
// This is NOT an HTTP account-creation endpoint.
//
// It is only used by the backend bootstrap process
// when the admin record does not exist yet.
// -----------------------------------------------------

async function createInitialSuperAdmin({
  superAdmin,
  adminUid,
  tokenHash
}) {

  const ref = getSuperAdminRef();

  const existing =
    await ref.get();

  if (existing.exists) {
    return {
      created: false,
      admin: {
        id: existing.id,
        ...existing.data()
      }
    };
  }

  const now =
    new Date().toISOString();

  const adminData = {
    superAdmin,
    adminUid,
    tokenHash,

    role: "superAdmin",

    status: "active",

    failedAttempts: 0,

    lockedUntil: null,

    activeSessionId: null,

    createdAt: now,

    updatedAt: now
  };

  await ref.create(adminData);

  return {
    created: true,
    admin: {
      id: SUPER_ADMIN_DOCUMENT,
      ...adminData
    }
  };
}


// -----------------------------------------------------
// UPDATE SUPER ADMIN TOKEN
// -----------------------------------------------------
//
// Only the token hash is written.
//
// The raw token is never stored here.
// -----------------------------------------------------

async function updateSuperAdminToken(tokenHash) {

  if (
    typeof tokenHash !== "string" ||
    !tokenHash
  ) {
    throw new Error(
      "A valid token hash is required."
    );
  }

  const ref =
    getSuperAdminRef();

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Super admin record does not exist."
    );
  }

  await ref.update({
    tokenHash,

    updatedAt:
      new Date().toISOString()
  });

  return {
    success: true
  };
}


// -----------------------------------------------------
// UPDATE FAILED ATTEMPTS
// -----------------------------------------------------

async function updateLoginProtection({
  failedAttempts,
  lockedUntil
}) {

  const ref =
    getSuperAdminRef();

  await ref.update({
    failedAttempts,
    lockedUntil,

    updatedAt:
      new Date().toISOString()
  });

  return {
    success: true
  };
}


// -----------------------------------------------------
// RESET LOGIN PROTECTION
// -----------------------------------------------------

async function resetLoginProtection() {

  const ref =
    getSuperAdminRef();

  await ref.update({
    failedAttempts: 0,
    lockedUntil: null,

    updatedAt:
      new Date().toISOString()
  });

  return {
    success: true
  };
}


// -----------------------------------------------------
// UPDATE ACTIVE SESSION
// -----------------------------------------------------
//
// Used by the one-active-device system.
//
// Only the session ID is stored here.
// The actual session credential remains private.
// -----------------------------------------------------

async function updateActiveSession(
  activeSessionId
) {

  const ref =
    getSuperAdminRef();

  await ref.update({
    activeSessionId:
      activeSessionId || null,

    updatedAt:
      new Date().toISOString()
  });

  return {
    success: true
  };
}


// -----------------------------------------------------
// EXPORTS
// -----------------------------------------------------

module.exports = {
  ADMIN_COLLECTION,
  SUPER_ADMIN_DOCUMENT,

  getSuperAdmin,
  createInitialSuperAdmin,

  updateSuperAdminToken,

  updateLoginProtection,
  resetLoginProtection,

  updateActiveSession
};