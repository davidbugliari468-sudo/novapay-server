"use strict";

const { FieldValue } = require("firebase-admin/firestore");

const { db } = require("../firebase-admin");
const {
  verifyNIN,
  verifyBVN,
  BabsPayError,
} = require("./babspay");
const {
  normalizeNIN,
  normalizeBVN,
  maskIdentifier,
} = require("./validation");

const USERS_COLLECTION = "users";
const KYC_COLLECTION = "kyc";
const IDENTITY_DOCUMENT = "identity";

const TIER_1 = 1;
const TIER_2 = 2;
const TIER_3 = 3;

function getUserRef(uid) {
  return db.collection(USERS_COLLECTION).doc(uid);
}

function getIdentityRef(uid) {
  return getUserRef(uid)
    .collection(KYC_COLLECTION)
    .doc(IDENTITY_DOCUMENT);
}

function normalizeTier(value) {
  const tier = Number(value);

  if (tier === TIER_3) {
    return TIER_3;
  }

  if (tier === TIER_2) {
    return TIER_2;
  }

  return TIER_1;
}

function getVerificationState(status) {
  if (status === "success") {
    return "verified";
  }

  if (status === "pending" || status === "processing") {
    return "pending";
  }

  return "failed";
}

function buildSafeError(error, fallbackMessage) {
  if (error instanceof BabsPayError) {
    return {
      message: fallbackMessage,
      code: error.code || "BABSPAY_ERROR",
    };
  }

  return {
    message: fallbackMessage,
    code: "KYC_SERVICE_ERROR",
  };
}

function buildNINVerifiedData(providerData) {
  if (!providerData || typeof providerData !== "object") {
    return {};
  }

  return {
    firstName:
      typeof providerData.firstname === "string"
        ? providerData.firstname.trim()
        : null,

    middleName:
      typeof providerData.middlename === "string"
        ? providerData.middlename.trim()
        : null,

    surname:
      typeof providerData.surname === "string"
        ? providerData.surname.trim()
        : null,

    gender:
      typeof providerData.gender === "string"
        ? providerData.gender.trim()
        : null,

    dateOfBirth:
      typeof providerData.birthdate === "string"
        ? providerData.birthdate.trim()
        : null,
  };
}

function buildBVNVerifiedData(providerData) {
  if (!providerData || typeof providerData !== "object") {
    return {};
  }

  return {
    firstName:
      typeof providerData.firstName === "string"
        ? providerData.firstName.trim()
        : null,

    lastName:
      typeof providerData.lastName === "string"
        ? providerData.lastName.trim()
        : null,

    dateOfBirth:
      typeof providerData.dateOfBirth === "string"
        ? providerData.dateOfBirth.trim()
        : null,
  };
}

async function getIdentityRecord(uid) {
  const snapshot = await getIdentityRef(uid).get();

  if (!snapshot.exists) {
    return null;
  }

  return snapshot.data();
}

async function getCurrentTier(uid) {
  const snapshot = await getUserRef(uid).get();

  if (!snapshot.exists) {
    return TIER_1;
  }

  return normalizeTier(snapshot.data()?.accountTier);
}

async function verifyNINForUser(uid, nin) {
  const normalizedNIN = normalizeNIN(nin);

  if (!normalizedNIN) {
    return {
      success: false,
      state: "invalid",
      error: "Invalid NIN.",
    };
  }

  const identityRef = getIdentityRef(uid);

  /*
   * Check the user's current verification state before
   * making a paid request to BabsPay.
   */
  const [currentTier, identityRecord] = await Promise.all([
    getCurrentTier(uid),
    getIdentityRecord(uid),
  ]);

  if (
    currentTier >= TIER_2 ||
    identityRecord?.nin?.status === "verified"
  ) {
    return {
      success: true,
      state: "verified",
      alreadyVerified: true,
      tier: Math.max(currentTier, TIER_2),
      message: "NIN is already verified.",
      nin: identityRecord?.nin?.masked || maskIdentifier(normalizedNIN),
    };
  }

  let providerResponse;

  try {
    providerResponse = await verifyNIN(normalizedNIN);
  } catch (error) {
    const safeError = buildSafeError(
      error,
      "NIN verification service is currently unavailable."
    );

    await identityRef.set(
      {
        nin: {
          status: "failed",
          errorCode: safeError.code,
          updatedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      success: false,
      state: "failed",
      error: safeError.message,
    };
  }

  const verificationState = getVerificationState(providerResponse.state);

  /*
   * SUCCESS
   */
  if (verificationState === "verified") {
    const verifiedData = buildNINVerifiedData(providerResponse.data);

    await db.runTransaction(async (transaction) => {
      const userRef = getUserRef(uid);
      const freshUserSnapshot = await transaction.get(userRef);

      const freshTier = freshUserSnapshot.exists
        ? normalizeTier(freshUserSnapshot.data()?.accountTier)
        : TIER_1;

      const newTier = Math.max(freshTier, TIER_2);

      transaction.set(
        identityRef,
        {
          nin: {
            status: "verified",
            masked: maskIdentifier(normalizedNIN),
            provider: "babspay",
            providerRef: providerResponse.ref || null,
            verifiedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            ...verifiedData,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      transaction.set(
        userRef,
        {
          accountTier: newTier,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return {
      success: true,
      state: "verified",
      alreadyVerified: false,
      tier: TIER_2,
      message: "NIN verified successfully.",
      nin: maskIdentifier(normalizedNIN),
    };
  }

  /*
   * PENDING / PROCESSING
   *
   * Do not upgrade the user's account tier.
   */
  if (verificationState === "pending") {
    await identityRef.set(
      {
        nin: {
          status: "pending",
          masked: maskIdentifier(normalizedNIN),
          provider: "babspay",
          providerRef: providerResponse.ref || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      success: true,
      state: "pending",
      alreadyVerified: false,
      tier: currentTier,
      message:
        "NIN verification is still processing. Your account tier has not been upgraded yet.",
      nin: maskIdentifier(normalizedNIN),
    };
  }

  /*
   * FAILED
   */
  await identityRef.set(
    {
      nin: {
        status: "failed",
        masked: maskIdentifier(normalizedNIN),
        provider: "babspay",
        providerRef: providerResponse.ref || null,
        errorCode: "VERIFICATION_FAILED",
        updatedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: false,
    state: "failed",
    tier: currentTier,
    error: "NIN verification was unsuccessful.",
    nin: maskIdentifier(normalizedNIN),
  };
}

async function verifyBVNForUser(uid, bvn) {
  const normalizedBVN = normalizeBVN(bvn);

  if (!normalizedBVN) {
    return {
      success: false,
      state: "invalid",
      error: "Invalid BVN.",
    };
  }

  const identityRef = getIdentityRef(uid);

  const [currentTier, identityRecord] = await Promise.all([
    getCurrentTier(uid),
    getIdentityRecord(uid),
  ]);

  if (
    currentTier >= TIER_3 ||
    identityRecord?.bvn?.status === "verified"
  ) {
    return {
      success: true,
      state: "verified",
      alreadyVerified: true,
      tier: TIER_3,
      message: "BVN is already verified.",
      bvn: identityRecord?.bvn?.masked || maskIdentifier(normalizedBVN),
    };
  }

  /*
   * BVN verification is intended for Tier 3.
   *
   * A user should have completed NIN verification first.
   */
  if (
    currentTier < TIER_2 &&
    identityRecord?.nin?.status !== "verified"
  ) {
    return {
      success: false,
      state: "tier_required",
      tier: currentTier,
      error: "Complete NIN verification before BVN verification.",
    };
  }

  let providerResponse;

  try {
    providerResponse = await verifyBVN(normalizedBVN);
  } catch (error) {
    const safeError = buildSafeError(
      error,
      "BVN verification service is currently unavailable."
    );

    await identityRef.set(
      {
        bvn: {
          status: "failed",
          errorCode: safeError.code,
          updatedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      success: false,
      state: "failed",
      error: safeError.message,
    };
  }

  const verificationState = getVerificationState(providerResponse.state);

  /*
   * SUCCESS
   */
  if (verificationState === "verified") {
    const verifiedData = buildBVNVerifiedData(providerResponse.data);

    await db.runTransaction(async (transaction) => {
      const userRef = getUserRef(uid);
      const freshUserSnapshot = await transaction.get(userRef);

      const freshTier = freshUserSnapshot.exists
        ? normalizeTier(freshUserSnapshot.data()?.accountTier)
        : TIER_1;

      const newTier = Math.max(freshTier, TIER_3);

      transaction.set(
        identityRef,
        {
          bvn: {
            status: "verified",
            masked: maskIdentifier(normalizedBVN),
            provider: "babspay",
            providerRef: providerResponse.ref || null,
            verifiedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            ...verifiedData,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      transaction.set(
        userRef,
        {
          accountTier: newTier,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return {
      success: true,
      state: "verified",
      alreadyVerified: false,
      tier: TIER_3,
      message: "BVN verified successfully.",
      bvn: maskIdentifier(normalizedBVN),
    };
  }

  /*
   * PENDING / PROCESSING
   */
  if (verificationState === "pending") {
    await identityRef.set(
      {
        bvn: {
          status: "pending",
          masked: maskIdentifier(normalizedBVN),
          provider: "babspay",
          providerRef: providerResponse.ref || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      success: true,
      state: "pending",
      alreadyVerified: false,
      tier: currentTier,
      message:
        "BVN verification is still processing. Your account tier has not been upgraded yet.",
      bvn: maskIdentifier(normalizedBVN),
    };
  }

  /*
   * FAILED
   */
  await identityRef.set(
    {
      bvn: {
        status: "failed",
        masked: maskIdentifier(normalizedBVN),
        provider: "babspay",
        providerRef: providerResponse.ref || null,
        errorCode: "VERIFICATION_FAILED",
        updatedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: false,
    state: "failed",
    tier: currentTier,
    error: "BVN verification was unsuccessful.",
    bvn: maskIdentifier(normalizedBVN),
  };
}

async function getKYCStatus(uid) {
  const [userSnapshot, identitySnapshot] = await Promise.all([
    getUserRef(uid).get(),
    getIdentityRef(uid).get(),
  ]);

  const userData = userSnapshot.exists ? userSnapshot.data() : {};
  const identityData = identitySnapshot.exists
    ? identitySnapshot.data()
    : {};

  return {
    success: true,

    tier: normalizeTier(userData.accountTier),

    nin: {
      status: identityData.nin?.status || "not_started",
      masked: identityData.nin?.masked || null,
      verifiedAt: identityData.nin?.verifiedAt || null,
    },

    bvn: {
      status: identityData.bvn?.status || "not_started",
      masked: identityData.bvn?.masked || null,
      verifiedAt: identityData.bvn?.verifiedAt || null,
    },
  };
}

module.exports = {
  verifyNINForUser,
  verifyBVNForUser,
  getKYCStatus,
};