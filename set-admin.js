const { auth } = require("./firebase-admin");

// =====================================================
// NOVAPAY ADMIN CLAIM SETUP
// =====================================================
//
// This is a manual, server-side security script.
//
// It is NOT an Express route.
// It must NEVER be exposed through the public API.
//
// Usage:
//   node set-admin.js <FIREBASE_UID>
//
// Example:
//   node set-admin.js ikj1hoaR3fNuVeMBKDCAp5VOrzm1
//
// =====================================================

async function setAdminClaim() {
  const uid = process.argv[2];

  // ---------------------------------------------------
  // UID CHECK
  // ---------------------------------------------------
  if (!uid) {
    console.error(
      "Error: Firebase UID is required."
    );

    console.error(
      "Usage: node set-admin.js <FIREBASE_UID>"
    );

    process.exit(1);
  }

  try {
    // -------------------------------------------------
    // GET FIREBASE USER
    // -------------------------------------------------
    const userRecord = await auth.getUser(uid);

    // -------------------------------------------------
    // GET EXISTING CUSTOM CLAIMS
    // -------------------------------------------------
    //
    // We preserve existing claims instead of replacing
    // them completely.
    //
    const existingClaims =
      userRecord.customClaims || {};

    // -------------------------------------------------
    // ADD NOVAPAY ADMIN CLAIM
    // -------------------------------------------------
    const updatedClaims = {
      ...existingClaims,
      adminp: true
    };

    // -------------------------------------------------
    // SAVE CUSTOM CLAIMS
    // -------------------------------------------------
    await auth.setCustomUserClaims(
      uid,
      updatedClaims
    );

    // -------------------------------------------------
    // SUCCESS
    // -------------------------------------------------
    console.log("");
    console.log(
      "=============================================="
    );
    console.log(
      "NovaPay admin claim successfully assigned."
    );
    console.log(
      "=============================================="
    );
    console.log("");
    console.log(
      `Firebase UID: ${uid}`
    );
    console.log(
      "Admin claim: adminp = true"
    );
    console.log("");
    console.log(
      "The user is now authorized for NovaPay admin APIs."
    );
    console.log("");

    process.exit(0);
  } catch (error) {
    // -------------------------------------------------
    // SAFE ERROR HANDLING
    // -------------------------------------------------
    console.error("");
    console.error(
      "Failed to assign NovaPay admin claim."
    );
    console.error(
      "Reason:",
      error.message
    );
    console.error("");

    process.exit(1);
  }
}

setAdminClaim();