"use strict";

const SUPPORTED_NETWORKS = new Set(["1", "2", "3", "4"]);

const MAX_REFERENCE_LENGTH = 150;
const MAX_PLAN_ID_LENGTH = 100;
const MAX_PHONE_LENGTH = 15;
const MAX_UID_LENGTH = 200;

const LOCAL_PHONE_PATTERN = /^0[789]\d{9}$/;
const INTERNATIONAL_PHONE_PATTERN = /^234[789]\d{9}$/;
const PLUS_INTERNATIONAL_PHONE_PATTERN = /^\+234[789]\d{9}$/;

const REFERENCE_PATTERN = /^[A-Za-z0-9._:-]+$/;
const PLAN_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function createValidationError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeNetwork(value) {
  const network = String(value ?? "").trim();

  if (!SUPPORTED_NETWORKS.has(network)) {
    throw createValidationError(
      "Unsupported data network.",
      "INVALID_NETWORK"
    );
  }

  return network;
}

function normalizePhoneNumber(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    throw createValidationError(
      "Phone number is required.",
      "INVALID_PHONE_NUMBER"
    );
  }

  const compact = raw.replace(/[\s()-]/g, "");

  let normalized;

  if (LOCAL_PHONE_PATTERN.test(compact)) {
    normalized = compact;
  } else if (INTERNATIONAL_PHONE_PATTERN.test(compact)) {
    normalized = `0${compact.slice(3)}`;
  } else if (PLUS_INTERNATIONAL_PHONE_PATTERN.test(compact)) {
    normalized = `0${compact.slice(4)}`;
  } else {
    throw createValidationError(
      "Invalid Nigerian phone number.",
      "INVALID_PHONE_NUMBER"
    );
  }

  if (
    normalized.length > MAX_PHONE_LENGTH ||
    !LOCAL_PHONE_PATTERN.test(normalized)
  ) {
    throw createValidationError(
      "Invalid Nigerian phone number.",
      "INVALID_PHONE_NUMBER"
    );
  }

  return normalized;
}

function normalizePlanId(value) {
  const planId = String(value ?? "").trim();

  if (
    !planId ||
    planId.length > MAX_PLAN_ID_LENGTH ||
    !PLAN_ID_PATTERN.test(planId)
  ) {
    throw createValidationError(
      "Invalid data plan.",
      "INVALID_PLAN_ID"
    );
  }

  return planId;
}

function normalizeReference(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const reference = String(value).trim();

  if (
    reference.length > MAX_REFERENCE_LENGTH ||
    !REFERENCE_PATTERN.test(reference)
  ) {
    throw createValidationError(
      "Invalid transaction reference.",
      "INVALID_REFERENCE"
    );
  }

  return reference;
}

function validatePurchaseInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw createValidationError(
      "Invalid purchase request.",
      "INVALID_REQUEST"
    );
  }

  return {
    network: normalizeNetwork(input.network),
    phoneNumber: normalizePhoneNumber(input.phoneNumber),
    planId: normalizePlanId(input.planId),
    reference: normalizeReference(input.reference)
  };
}

function validateUid(uid) {
  const value = String(uid ?? "").trim();

  if (
    !value ||
    value.length > MAX_UID_LENGTH
  ) {
    throw createValidationError(
      "Invalid user.",
      "INVALID_UID"
    );
  }

  return value;
}

module.exports = {
  SUPPORTED_NETWORKS,
  normalizeNetwork,
  normalizePhoneNumber,
  normalizePlanId,
  normalizeReference,
  validatePurchaseInput,
  validateUid
};