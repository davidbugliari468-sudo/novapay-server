const path = require("path");
const fs = require("fs");

const {
  initializeApp,
  cert,
  getApps
} = require("firebase-admin/app");

const {
  getAuth
} = require("firebase-admin/auth");

const {
  getFirestore
} = require("firebase-admin/firestore");


// =====================================================
// FIREBASE ADMIN CREDENTIALS
// =====================================================
//
// Production (Render):
//   FIREBASE_SERVICE_ACCOUNT_JSON
//
// Local development (Codespaces):
//   secrets/service-account JSON file
//
// The service-account JSON must NEVER be committed
// to GitHub.
// =====================================================

let serviceAccount;


// -----------------------------------------------------
// OPTION 1 — RENDER ENVIRONMENT VARIABLE
// -----------------------------------------------------

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {

  try {

    serviceAccount =
      JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      );

    console.log(
      "Firebase Admin credentials loaded from environment."
    );

  } catch (error) {

    console.error(
      "Invalid FIREBASE_SERVICE_ACCOUNT_JSON."
    );

    throw error;
  }
}


// -----------------------------------------------------
// OPTION 2 — LOCAL CODESPACES FILE
// -----------------------------------------------------

if (!serviceAccount) {

  const serviceAccountPath = path.join(
    __dirname,
    "secrets",
    "novapay-c88fa-firebase-adminsdk-fbsvc-0b66694bce 2.json"
  );

  if (!fs.existsSync(serviceAccountPath)) {

    throw new Error(
      "Firebase Admin credentials not found. Set FIREBASE_SERVICE_ACCOUNT_JSON in the production environment."
    );
  }

  serviceAccount =
    require(serviceAccountPath);

  console.log(
    "Firebase Admin credentials loaded from local service-account file."
  );
}


// =====================================================
// INITIALIZE FIREBASE ADMIN
// =====================================================

const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert(serviceAccount)
      });


// =====================================================
// SERVICES
// =====================================================

const auth = getAuth(app);
const db = getFirestore(app);


// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  app,
  auth,
  db
};