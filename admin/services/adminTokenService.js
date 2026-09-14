const crypto = require("crypto");


// =====================================================
// ADMIN TOKEN SERVICE
// =====================================================
//
// Handles generation, hashing, and verification of
// NovaPay Admin Management System tokens.
//
// IMPORTANT:
//
// - Raw tokens must never be stored in Firestore.
// - Raw tokens must never be logged.
// - Generated tokens contain cryptographically secure
//   random data.
// - Only token hashes are stored.
// - Admin tokens are exactly 32 characters.
// =====================================================


// -----------------------------------------------------
// TOKEN SETTINGS
// -----------------------------------------------------
//
// 16 random bytes converted to hexadecimal produce
// exactly 32 characters.
//
// 16 bytes = 128 bits of cryptographically secure
// randomness.
// -----------------------------------------------------

const TOKEN_BYTES = 16;


// -----------------------------------------------------
// GENERATE ADMIN TOKEN
// -----------------------------------------------------
//
// Generates a cryptographically secure 32-character
// hexadecimal token.
//
// The returned value is the raw token.
//
// It must only be available to the authorized backend
// operation that needs to present it once.
// -----------------------------------------------------

function generateAdminToken() {

  return crypto
    .randomBytes(
      TOKEN_BYTES
    )
    .toString("hex");
}


// -----------------------------------------------------
// HASH ADMIN TOKEN
// -----------------------------------------------------
//
// Creates a SHA-256 hash of the supplied token.
//
// Only this hash should be stored in Firestore.
// -----------------------------------------------------

function hashAdminToken(token) {

  if (
    typeof token !== "string" ||
    !token
  ) {
    throw new Error(
      "A valid admin token is required."
    );
  }

  return crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}


// -----------------------------------------------------
// VERIFY ADMIN TOKEN
// -----------------------------------------------------
//
// Compares a supplied token against the stored hash.
//
// timingSafeEqual is used so the comparison does not
// rely on a normal string comparison.
// -----------------------------------------------------

function verifyAdminToken(
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
    hashAdminToken(token);

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
// CREATE TOKEN CREDENTIAL
// -----------------------------------------------------
//
// Generates a new raw token and its hash.
//
// The raw token can be shown once to the authorized
// admin after the initial bootstrap or token rotation.
//
// The hash is what gets stored in Firestore.
// -----------------------------------------------------

function createTokenCredential() {

  const token =
    generateAdminToken();

  const tokenHash =
    hashAdminToken(token);

  return {
    token,
    tokenHash
  };
}


// -----------------------------------------------------
// EXPORTS
// -----------------------------------------------------

module.exports = {
  generateAdminToken,
  hashAdminToken,
  verifyAdminToken,
  createTokenCredential
};