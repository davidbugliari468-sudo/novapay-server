const crypto = require("crypto");

const { db } = require("../../firebase-admin");

const {
  updateActiveSession
} = require("./adminCredentialStore");


// =====================================================
// ADMIN SESSION SERVICE
// =====================================================
//
// Handles secure sessions for the NovaPay Admin
// Management System.
//
// SECURITY MODEL:
//
// - One active session per admin.
// - New authorized login replaces the previous session.
// - Session secrets are never stored in plain text.
// - Only a SHA-256 hash is stored.
// - Sessions automatically expire.
// - Revoked or replaced sessions cannot be used.
// =====================================================


// -----------------------------------------------------
// FIRESTORE COLLECTION
// -----------------------------------------------------

const SESSION_COLLECTION =
  "adminSessions";


// -----------------------------------------------------
// SESSION SETTINGS
// -----------------------------------------------------
//
// Default:
// 8 hours.
//
// Can be changed through the backend environment
// without changing the source code.
// -----------------------------------------------------

const DEFAULT_SESSION_TTL_MINUTES = 480;

const SESSION_TTL_MINUTES =
  Number(
    process.env.ADMIN_SESSION_TTL_MINUTES
  ) ||
  DEFAULT_SESSION_TTL_MINUTES;


// -----------------------------------------------------
// SESSION TOKEN SETTINGS
// -----------------------------------------------------

const SESSION_TOKEN_BYTES = 32;


// -----------------------------------------------------
// GET SESSION REFERENCE
// -----------------------------------------------------

function getSessionRef(sessionId) {

  return db
    .collection(SESSION_COLLECTION)
    .doc(sessionId);
}


// -----------------------------------------------------
// GENERATE SESSION TOKEN
// -----------------------------------------------------

function generateSessionToken() {

  return crypto
    .randomBytes(SESSION_TOKEN_BYTES)
    .toString("hex");
}


// -----------------------------------------------------
// HASH SESSION TOKEN
// -----------------------------------------------------

function hashSessionToken(token) {

  if (
    typeof token !== "string" ||
    !token
  ) {
    throw new Error(
      "A valid session token is required."
    );
  }

  return crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}


// -----------------------------------------------------
// VERIFY SESSION TOKEN HASH
// -----------------------------------------------------

function verifySessionToken(
  token,
  storedTokenHash
) {

  if (
    typeof token !== "string" ||
    !token ||
    typeof storedTokenHash !== "string" ||
    !storedTokenHash
  ) {
    return false;
  }

  const suppliedHash =
    hashSessionToken(token);

  const suppliedBuffer =
    Buffer.from(
      suppliedHash,
      "hex"
    );

  const storedBuffer =
    Buffer.from(
      storedTokenHash,
      "hex"
    );

  if (
    suppliedBuffer.length !==
    storedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    suppliedBuffer,
    storedBuffer
  );
}


// -----------------------------------------------------
// GENERATE SESSION ID
// -----------------------------------------------------

function generateSessionId() {

  return crypto
    .randomBytes(24)
    .toString("hex");
}


// -----------------------------------------------------
// CREATE ADMIN SESSION
// -----------------------------------------------------
//
// Creates a new active session.
//
// The previous active session is revoked first by
// clearing the admin's activeSessionId and marking the
// old session revoked.
//
// The raw session token is returned only once.
// -----------------------------------------------------

async function createAdminSession({
  adminId
}) {

  if (
    typeof adminId !== "string" ||
    !adminId
  ) {
    throw new Error(
      "A valid admin ID is required."
    );
  }


  // ---------------------------------------------------
  // GENERATE NEW SESSION CREDENTIALS
  // ---------------------------------------------------

  const sessionId =
    generateSessionId();

  const sessionToken =
    generateSessionToken();

  const sessionTokenHash =
    hashSessionToken(sessionToken);


  // ---------------------------------------------------
  // SESSION TIMES
  // ---------------------------------------------------

  const now =
    new Date();

  const expiresAt =
    new Date(
      now.getTime() +
      SESSION_TTL_MINUTES * 60 * 1000
    );


  // ---------------------------------------------------
  // CREATE SESSION RECORD
  // ---------------------------------------------------

  const sessionData = {

    adminId,

    tokenHash:
      sessionTokenHash,

    status:
      "active",

    createdAt:
      now.toISOString(),

    expiresAt:
      expiresAt.toISOString(),

    revokedAt:
      null
  };


  await getSessionRef(sessionId)
    .create(sessionData);


  // ---------------------------------------------------
  // MAKE THIS THE ONLY ACTIVE SESSION
  // ---------------------------------------------------

  await updateActiveSession(
    sessionId
  );


  // ---------------------------------------------------
  // RETURN RAW TOKEN ONCE
  // ---------------------------------------------------
  //
  // This token must be sent only through the secure
  // login response and must never be stored in logs.
  // ---------------------------------------------------

  return {
    sessionId,

    sessionToken,

    expiresAt:
      expiresAt.toISOString()
  };
}


// -----------------------------------------------------
// GET SESSION
// -----------------------------------------------------

async function getAdminSession(
  sessionId
) {

  if (
    typeof sessionId !== "string" ||
    !sessionId
  ) {
    return null;
  }

  const snapshot =
    await getSessionRef(sessionId)
      .get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    id: snapshot.id,
    ...snapshot.data()
  };
}


// -----------------------------------------------------
// VALIDATE ADMIN SESSION
// -----------------------------------------------------
//
// Checks:
//
// 1. Session exists.
// 2. Session is active.
// 3. Session belongs to the expected admin.
// 4. Session has not expired.
// 5. Session token is correct.
// 6. Session is still the admin's active session.
// -----------------------------------------------------

async function validateAdminSession({
  sessionId,
  sessionToken,
  adminId
}) {

  if (
    !sessionId ||
    !sessionToken ||
    !adminId
  ) {
    return {
      valid: false,
      reason: "Invalid session credentials."
    };
  }


  const session =
    await getAdminSession(
      sessionId
    );


  if (!session) {

    return {
      valid: false,
      reason: "Session not found."
    };
  }


  // ---------------------------------------------------
  // SESSION STATUS
  // ---------------------------------------------------

  if (
    session.status !==
    "active"
  ) {

    return {
      valid: false,
      reason: "Session has been revoked."
    };
  }


  // ---------------------------------------------------
  // ADMIN OWNERSHIP
  // ---------------------------------------------------

  if (
    session.adminId !==
    adminId
  ) {

    return {
      valid: false,
      reason: "Invalid session owner."
    };
  }


  // ---------------------------------------------------
  // SESSION EXPIRATION
  // ---------------------------------------------------

  const expiresAt =
    new Date(
      session.expiresAt
    );

  if (
    Number.isNaN(
      expiresAt.getTime()
    ) ||
    expiresAt <= new Date()
  ) {

    await revokeAdminSession(
      sessionId
    );

    return {
      valid: false,
      reason: "Session has expired."
    };
  }


  // ---------------------------------------------------
  // SESSION TOKEN
  // ---------------------------------------------------

  const tokenValid =
    verifySessionToken(
      sessionToken,
      session.tokenHash
    );

  if (!tokenValid) {

    return {
      valid: false,
      reason: "Invalid session token."
    };
  }


  // ---------------------------------------------------
  // CHECK ACTIVE SESSION
  // ---------------------------------------------------

  const adminSnapshot =
    await db
      .collection("adminManagement")
      .doc("superAdmin")
      .get();


  if (!adminSnapshot.exists) {

    return {
      valid: false,
      reason: "Admin record not found."
    };
  }


  const admin =
    adminSnapshot.data();


  if (
    admin.activeSessionId !==
    sessionId
  ) {

    return {
      valid: false,
      reason: "Session is no longer active."
    };
  }


  // ---------------------------------------------------
  // SESSION VALID
  // ---------------------------------------------------

  return {
    valid: true,
    session
  };
}


// -----------------------------------------------------
// REVOKE ADMIN SESSION
// -----------------------------------------------------

async function revokeAdminSession(
  sessionId
) {

  if (
    typeof sessionId !== "string" ||
    !sessionId
  ) {
    return {
      success: false
    };
  }


  const ref =
    getSessionRef(sessionId);

  const snapshot =
    await ref.get();


  if (!snapshot.exists) {

    return {
      success: false
    };
  }


  await ref.update({
    status: "revoked",

    revokedAt:
      new Date().toISOString()
  });


  // ---------------------------------------------------
  // ONLY CLEAR ACTIVE SESSION IF THIS SESSION IS
  // CURRENTLY ACTIVE
  // ---------------------------------------------------

  const adminSnapshot =
    await db
      .collection("adminManagement")
      .doc("superAdmin")
      .get();


  if (adminSnapshot.exists) {

    const admin =
      adminSnapshot.data();

    if (
      admin.activeSessionId ===
      sessionId
    ) {

      await updateActiveSession(
        null
      );
    }
  }


  return {
    success: true
  };
}


// -----------------------------------------------------
// REVOKE CURRENT ADMIN SESSION
// -----------------------------------------------------

async function revokeCurrentAdminSession(
  sessionId
) {

  return revokeAdminSession(
    sessionId
  );
}


// -----------------------------------------------------
// EXPORTS
// -----------------------------------------------------

module.exports = {
  SESSION_COLLECTION,
  SESSION_TTL_MINUTES,

  generateSessionToken,
  hashSessionToken,
  verifySessionToken,

  createAdminSession,
  getAdminSession,
  validateAdminSession,

  revokeAdminSession,
  revokeCurrentAdminSession
};