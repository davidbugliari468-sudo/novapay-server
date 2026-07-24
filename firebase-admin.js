const admin = require("firebase-admin");

// Read the JSON stored in Render Environment Variables
const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
);

if (!admin.apps.length) {

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

}

const db = admin.firestore();

module.exports = {
    admin,
    db
};