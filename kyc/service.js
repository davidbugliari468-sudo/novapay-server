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

/*
 * SECURITY:
 * Never log raw NIN/BVN values or complete provider responses.
 *
 * These helpers keep diagnostics useful while preventing sensitive
 * identity information from being written into Render logs.
 */
function sanitizeDiagnosticText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .replace(/\b\d{11}\b/g, "[REDACTED_11_DIGIT_ID]")
    .replace(/\b\d{10,}\b/g, "[REDACTED_NUMBER]")
    .trim();

  if (!cleaned) {
    return null;
  }

  return cleaned.slice(0, 300);
}

function safeProviderRef(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const ref = value.trim();

  if (ref.length <= 8) {
    return ref;
  }

  return `${ref.slice(0, 4)}...${ref.slice(-4)}`;
}

function logProviderDiagnostic(type, providerResponse) {
  if (!providerResponse || typeof providerResponse !== "object") {
    console.warn(`[KYC][${type}] BabsPay returned no usable response.`);
    return;
  }

  console.warn(`[KYC][${type}] BabsPay verification result`, {
    providerStatus:
      typeof providerResponse.status === "string"
        ? providerResponse.status
        : null,

    providerState:
      typeof providerResponse.state === "string"
        ? providerResponse.state
        : null,

    providerMessage: sanitizeDiagnosticText(
      providerResponse.msg || providerResponse.message
    ),

    providerRef: safeProviderRef(providerResponse.ref),

    hasData:
      providerResponse.data !== null &&
      providerResponse.data !== undefined,

    dataType: Array.isArray(providerResponse.data)
      ? "array"
      : typeof providerResponse.data,
  });
}

function logProviderErrorDiagnostic(type, error) {
  if (!error) {
    console.error(`[KYC][${type}] Unknown BabsPay error.`);
    return;
  }

  const diagnostic = {
    errorType:
      error instanceof BabsPayError
        ? "BabsPayError"
        : error.constructor?.name || "Error",

    code:
      typeof error.code === "string"
        ? error.code
        : "UNKNOWN_ERROR",

    status:
      Number.isFinite(error.status)
        ? error.status
        : Number.isFinite(error.statusCode)
          ? error.statusCode
          : null,

    message: sanitizeDiagnosticText(error.message),

    providerStatus:
      typeof error.data?.status === "string"
        ? error.data.status
        : null,

    providerState:
      typeof error.data?.state === "string"
        ? error.data.state
        : null,

    providerMessage: sanitizeDiagnosticText(
      error.data?.msg || error.data?.message
    ),

    providerRef: safeProviderRef(error.data?.ref),
  };

  console.error(`[KYC][${type}] BabsPay request error`, diagnostic);
}

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
    logProviderErrorDiagnostic("NIN", error);

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

  /*
   * DIAGNOSTICS:
   * Log only safe provider metadata.
   *
   * Raw NIN and complete provider response are intentionally
   * excluded from logs.
   */
  logProviderDiagnostic("NIN", providerResponse);

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
        providerStatus:
          typeof providerResponse.status === "string"
            ? providerResponse.status
            : null,
        providerState:
          typeof providerResponse.state === "string"
            ? providerResponse.state
            : null,
        providerMessage: sanitizeDiagnosticText(
          providerResponse.msg || providerResponse.message
        ),
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
    logProviderErrorDiagnostic("BVN", error);

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

  /*
   * DIAGNOSTICS:
   * Log only safe provider metadata.
   *
   * Raw BVN and complete provider response are intentionally
   * excluded from logs.
   */
  logProviderDiagnostic("BVN", providerResponse);

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
        providerStatus:
          typeof providerResponse.status === "string"
            ? providerResponse.status
            : null,
        providerState:
          typeof providerResponse.state === "string"
            ? providerResponse.state
            : null,
        providerMessage: sanitizeDiagnosticText(
          providerResponse.msg || providerResponse.message
        ),
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