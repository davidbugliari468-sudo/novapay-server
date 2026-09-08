"use strict";

/**
 * Electricity service constants.
 *
 * This file contains only fixed application/provider values.
 * It does not perform wallet operations, provider requests,
 * transaction updates, or authentication.
 */

const ELECTRICITY_STATUS = Object.freeze({
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
  MANUAL_REVIEW: "MANUAL_REVIEW",
});

const RECONCILIATION_STATUS = Object.freeze({
  NOT_REQUIRED: "NOT_REQUIRED",
  REQUIRED: "REQUIRED",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING: "WAITING",
  RESOLVED: "RESOLVED",
  ESCALATED: "ESCALATED",
});

const METER_TYPES = Object.freeze({
  PREPAID: "prepaid",
  POSTPAID: "postpaid",
});

/**
 * Supported VTU.ng electricity service IDs.
 *
 * The frontend must never be trusted to invent arbitrary provider IDs.
 * Electricity routes will validate against this allow-list on the backend.
 */
const ELECTRICITY_SERVICE_IDS = Object.freeze({
  IKEDC: "ikeja-electric",
  EKEDC: "eko-electric",
  AEDC: "abuja-electric",
  IBEDC: "ibadan-electric",
  PHED: "portharcourt-electric",
  EEDC: "enugu-electric",
  BEDC: "benin-electric",
  JED: "jos-electric",

  // Supported by VTU.ng even if not currently displayed
  // on the existing frontend.
  KEDCO: "kano-electric",
  KAEDCO: "kaduna-electric",
  YEDC: "yola-electric",
  ABA: "aba-electric",
});

const SUPPORTED_ELECTRICITY_SERVICE_IDS = Object.freeze(
  new Set(Object.values(ELECTRICITY_SERVICE_IDS))
);

const SUPPORTED_METER_TYPES = Object.freeze(
  new Set(Object.values(METER_TYPES))
);

/**
 * VTU.ng electricity provider statuses.
 *
 * Only COMPLETED_API represents provider success.
 * FAILED, REFUNDED and CANCELLED represent definite non-success.
 * Processing/pending/queued/initiated/on-hold remain unresolved.
 */
const PROVIDER_ELECTRICITY_STATUS = Object.freeze({
  SUCCESS: "completed-api",

  PROCESSING: "processing-api",
  QUEUED: "queued-api",
  INITIATED: "initiated-api",
  PENDING: "pending",
  ON_HOLD: "on-hold",

  FAILED: "failed",
  REFUNDED: "refunded",
  CANCELLED: "cancelled",
});

/**
 * Financial outcome classification.
 *
 * This is intentionally separate from provider status so that
 * ambiguous provider/network states cannot accidentally release
 * customer funds.
 */
const PROVIDER_OUTCOME = Object.freeze({
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
  UNKNOWN: "UNKNOWN",
});

/**
 * Reason codes used internally for reconciliation and auditing.
 */
const ELECTRICITY_REASON_CODES = Object.freeze({
  PROVIDER_SUCCESS: "PROVIDER_SUCCESS",
  PROVIDER_FAILED: "PROVIDER_FAILED",
  PROVIDER_REFUNDED: "PROVIDER_REFUNDED",
  PROVIDER_CANCELLED: "PROVIDER_CANCELLED",

  PROVIDER_PROCESSING: "PROVIDER_PROCESSING",
  PROVIDER_PENDING: "PROVIDER_PENDING",
  PROVIDER_QUEUED: "PROVIDER_QUEUED",
  PROVIDER_INITIATED: "PROVIDER_INITIATED",
  PROVIDER_ON_HOLD: "PROVIDER_ON_HOLD",

  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_NETWORK_ERROR: "PROVIDER_NETWORK_ERROR",
  PROVIDER_UNKNOWN_RESPONSE: "PROVIDER_UNKNOWN_RESPONSE",

  DUPLICATE_REQUEST: "DUPLICATE_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  AUTHORIZATION_ERROR: "AUTHORIZATION_ERROR",
});

/**
 * Reconciliation policy.
 *
 * These values control how often an unresolved electricity transaction
 * may be checked. They do NOT authorize automatic financial release.
 */
const RECONCILIATION_CONFIG = Object.freeze({
  DEFAULT_BATCH_SIZE: 25,
  MAX_BATCH_SIZE: 100,

  MAX_AUTOMATIC_ATTEMPTS: 12,

  INITIAL_DELAY_MS: 30 * 1000,
  MAX_DELAY_MS: 30 * 60 * 1000,

  /**
   * After this point the transaction can be escalated for manual review.
   * Escalation does NOT release the customer's reserved funds.
   */
  MAX_RECONCILIATION_AGE_MS: 24 * 60 * 60 * 1000,
});

/**
 * Basic electricity amount limits.
 *
 * The provider currently documents a maximum purchase amount of
 * ₦100,000. The minimum amount can depend on the verified customer,
 * so the final minimum must come from the provider verification result.
 */
const ELECTRICITY_LIMITS = Object.freeze({
  MAX_AMOUNT_NAIRA: 100000,
  MAX_AMOUNT_KOBO: 100000 * 100,
});

/**
 * Maximum lengths used for backend validation.
 *
 * These are deliberately conservative application-level limits.
 */
const ELECTRICITY_INPUT_LIMITS = Object.freeze({
  METER_NUMBER_MIN_LENGTH: 4,
  METER_NUMBER_MAX_LENGTH: 32,

  SERVICE_ID_MAX_LENGTH: 64,

  REQUEST_ID_MAX_LENGTH: 50,

  CUSTOMER_NAME_MAX_LENGTH: 200,
  ADDRESS_MAX_LENGTH: 500,
});

function isSupportedElectricityServiceId(serviceId) {
  return (
    typeof serviceId === "string" &&
    SUPPORTED_ELECTRICITY_SERVICE_IDS.has(serviceId)
  );
}

function isSupportedMeterType(meterType) {
  return (
    typeof meterType === "string" &&
    SUPPORTED_METER_TYPES.has(meterType)
  );
}

function isDefiniteProviderFailureStatus(status) {
  return (
    status === PROVIDER_ELECTRICITY_STATUS.FAILED ||
    status === PROVIDER_ELECTRICITY_STATUS.REFUNDED ||
    status === PROVIDER_ELECTRICITY_STATUS.CANCELLED
  );
}

function isProviderSuccessStatus(status) {
  return status === PROVIDER_ELECTRICITY_STATUS.SUCCESS;
}

function isProviderPendingStatus(status) {
  return (
    status === PROVIDER_ELECTRICITY_STATUS.PROCESSING ||
    status === PROVIDER_ELECTRICITY_STATUS.QUEUED ||
    status === PROVIDER_ELECTRICITY_STATUS.INITIATED ||
    status === PROVIDER_ELECTRICITY_STATUS.PENDING ||
    status === PROVIDER_ELECTRICITY_STATUS.ON_HOLD
  );
}

function classifyProviderStatus(status) {
  if (isProviderSuccessStatus(status)) {
    return PROVIDER_OUTCOME.SUCCESS;
  }

  if (isDefiniteProviderFailureStatus(status)) {
    return PROVIDER_OUTCOME.FAILURE;
  }

  if (isProviderPendingStatus(status)) {
    return PROVIDER_OUTCOME.UNKNOWN;
  }

  return PROVIDER_OUTCOME.UNKNOWN;
}

module.exports = {
  ELECTRICITY_STATUS,
  RECONCILIATION_STATUS,
  METER_TYPES,

  ELECTRICITY_SERVICE_IDS,
  SUPPORTED_ELECTRICITY_SERVICE_IDS,
  SUPPORTED_METER_TYPES,

  PROVIDER_ELECTRICITY_STATUS,
  PROVIDER_OUTCOME,

  ELECTRICITY_REASON_CODES,
  RECONCILIATION_CONFIG,
  ELECTRICITY_LIMITS,
  ELECTRICITY_INPUT_LIMITS,

  isSupportedElectricityServiceId,
  isSupportedMeterType,
  isDefiniteProviderFailureStatus,
  isProviderSuccessStatus,
  isProviderPendingStatus,
  classifyProviderStatus,
};