const path = require("path");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const serviceAccountPath = path.join(
  __dirname,
  "secrets",
  "novapay-c88fa-firebase-adminsdk-fbsvc-0b66694bce 2.json"
);

const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({
        credential: cert(require(serviceAccountPath)),
      });

const auth = getAuth(app);
const db = getFirestore(app);

module.exports = {
  app,
  auth,
  db,
};