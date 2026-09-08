"use strict";

/*
 * NovaPay Betting Constants
 *
 * Provider:
 *   VTU.ng API v2
 *
 * Purpose:
 *   Central source of truth for betting providers,
 *   validation limits, and provider outcome classification.
 *
 * Financial rule:
 *   Unknown / ambiguous provider responses are NEVER
 *   classified as definite failures.
 *
 *   In particular, duplicate_request_id and duplicate_order
 *   are NOT definite failures because the original request
 *   may already have been accepted by VTU.ng.
 */

const BETTING_SERVICES = Object.freeze([
  "1xbet",
  "bangbet",
  "bet9ja",
  "betking",
  "betland",
  "betlion",
  "betway",
  "cloudbet",
  "livescorebet",
  "merrybet",
  "naijabet",
  "nairabet",
  "sportybet",
  "supabet",
]);

const BETTING_SERVICE_SET =
  new Set(BETTING_SERVICES);

const BETTING_PROVIDER_LIMITS = Object.freeze({
  customerIdMinLength: 1,
  customerIdMaxLength: 100,

  amountMinKobo: 100 * 100,
  amountMaxKobo: 100000 * 100,

  providerRequestIdMaxLength: 50,

  /*
   * Backend transaction IDs are generated internally.
   * This is deliberately stricter than the provider's
   * request ID limit.
   */
  transactionIdMinLength: 10,
  transactionIdMaxLength: 120,
});

/*
 * VTU.ng documented successful order status.
 *
 * processing-api is intentionally NOT included here.
 * Processing means the provider has not definitively
 * completed the transaction yet.
 */
const BETTING_PROVIDER_SUCCESS_STATUSES =
  Object.freeze([
    "completed-api",
  ]);

/*
 * These statuses represent a definite unsuccessful
 * provider outcome.
 *
 * Anything else remains unknown unless a definite
 * failure code/message proves failure.
 */
const BETTING_PROVIDER_FAILURE_STATUSES =
  Object.freeze([
    "failed",
    "refunded",
    "cancelled",
  ]);

/*
 * Known VTU/provider failure codes.
 *
 * IMPORTANT:
 * duplicate_request_id and duplicate_order are
 * intentionally excluded.
 *
 * A duplicate can mean the provider already accepted
 * the original transaction.
 */
const BETTING_DEFINITE_FAILURE_CODES =
  Object.freeze([
    "missing_fields",

    "invalid_service_id",
    "invalid_service",
    "invalid_provider",

    "invalid_customer",
    "invalid_customer_id",
    "invalid_betting_id",

    "below_minimum_amount",
    "above_maximum_amount",
    "invalid_amount",

    "insufficient_funds",

    "order_failed",
    "failed",
    "failure",

    "service_unavailable",
    "product_unavailable",

    "account_not_found",
    "customer_not_found",

    "invalid_field",
  ]);

/*
 * Messages that can establish a definite provider
 * failure when the provider code is not sufficient.
 *
 * Keep these conservative.
 *
 * We deliberately do NOT classify generic messages such
 * as "unable to process", "request failed", "timeout",
 * "network error", or "try again" as definite failures.
 *
 * Those may represent an unknown provider outcome.
 */
const BETTING_DEFINITE_FAILURE_MESSAGE_PATTERNS =
  Object.freeze([
    /insufficient\s+funds/i,

    /invalid\s+(?:service|provider)\s*(?:id)?/i,

    /invalid\s+(?:customer|betting)\s*(?:id)?/i,

    /customer\s+(?:not\s+found|does\s+not\s+exist)/i,

    /account\s+(?:not\s+found|does\s+not\s+exist)/i,

    /below\s+(?:the\s+)?minimum/i,

    /above\s+(?:the\s+)?maximum/i,

    /invalid\s+amount/i,

    /invalid\s+field/i,

    /missing\s+(?:required\s+)?field/i,

    /order\s+(?:failed|rejected)/i,

    /product\s+(?:unavailable|not\s+available)/i,

    /service\s+(?:unavailable|not\s+available)/i,

    /transaction\s+(?:failed|rejected)/i,
  ]);

/*
 * Normalize arbitrary input into a safe string.
 */
function normalizeString(value) {
  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value.trim();
}

/*
 * Normalize a betting service/provider ID.
 *
 * VTU documentation shows provider IDs with mixed
 * capitalization in examples, but the backend should
 * store one canonical representation.
 */
function normalizeBettingServiceId(
  serviceId
) {
  return normalizeString(
    serviceId
  ).toLowerCase();
}

/*
 * Determine whether a provider/service is supported.
 */
function isSupportedBettingServiceId(
  serviceId
) {
  const normalized =
    normalizeBettingServiceId(
      serviceId
    );

  return BETTING_SERVICE_SET.has(
    normalized
  );
}

/*
 * Validate betting customer/account ID.
 *
 * We intentionally do not assume that every bookmaker
 * uses the same numeric format.
 *
 * The provider remains authoritative for whether the
 * actual betting account exists.
 */
function isValidBettingCustomerId(
  customerId
) {
  if (
    typeof customerId !== "string"
  ) {
    return false;
  }

  const normalized =
    customerId.trim();

  if (
    normalized.length <
      BETTING_PROVIDER_LIMITS.customerIdMinLength ||
    normalized.length >
      BETTING_PROVIDER_LIMITS.customerIdMaxLength
  ) {
    return false;
  }

  /*
   * Permit common betting account identifiers:
   * letters, numbers, underscore and hyphen.
   *
   * Reject whitespace and arbitrary punctuation.
   */
  return /^[A-Za-z0-9_-]+$/.test(
    normalized
  );
}

/*
 * Normalize a betting customer/account ID.
 */
function normalizeBettingCustomerId(
  customerId
) {
  return normalizeString(
    customerId
  );
}

/*
 * Validate amount in kobo.
 *
 * NovaPay stores wallet money in kobo.
 * VTU.ng expects the provider amount in whole NGN.
 */
function isValidBettingAmountKobo(
  amountKobo
) {
  if (
    amountKobo === null ||
    amountKobo === undefined ||
    amountKobo === ""
  ) {
    return false;
  }

  const numeric =
    Number(amountKobo);

  if (
    !Number.isSafeInteger(
      numeric
    )
  ) {
    return false;
  }

  return (
    numeric >=
      BETTING_PROVIDER_LIMITS.amountMinKobo &&
    numeric <=
      BETTING_PROVIDER_LIMITS.amountMaxKobo
  );
}

/*
 * Convert kobo to whole NGN.
 *
 * VTU.ng betting requires an integer NGN amount.
 */
function bettingKoboToNaira(
  amountKobo
) {
  if (
    !isValidBettingAmountKobo(
      amountKobo
    )
  ) {
    throw new Error(
      "Invalid betting amount"
    );
  }

  return Number(
    amountKobo
  ) / 100;
}

/*
 * Normalize provider status.
 */
function normalizeBettingProviderStatus(
  status
) {
  return normalizeString(
    status
  ).toLowerCase();
}

/*
 * Determine whether a provider status is definite
 * success.
 */
function isBettingProviderSuccessStatus(
  status
) {
  const normalized =
    normalizeBettingProviderStatus(
      status
    );

  return BETTING_PROVIDER_SUCCESS_STATUSES.includes(
    normalized
  );
}

/*
 * Determine whether a provider status is definite
 * failure.
 */
function isBettingProviderFailureStatus(
  status
) {
  const normalized =
    normalizeBettingProviderStatus(
      status
    );

  return BETTING_PROVIDER_FAILURE_STATUSES.includes(
    normalized
  );
}

/*
 * Normalize provider error/outcome code.
 */
function normalizeBettingProviderCode(
  code
) {
  return normalizeString(
    code
  ).toLowerCase();
}

/*
 * Determine whether a provider code proves a
 * definite failure.
 */
function isBettingDefiniteFailureCode(
  code
) {
  const normalized =
    normalizeBettingProviderCode(
      code
    );

  return BETTING_DEFINITE_FAILURE_CODES.includes(
    normalized
  );
}

/*
 * Determine whether a provider message proves a
 * definite failure.
 */
function isBettingDefiniteFailureMessage(
  message
) {
  const normalized =
    normalizeString(
      message
    );

  if (!normalized) {
    return false;
  }

  return BETTING_DEFINITE_FAILURE_MESSAGE_PATTERNS.some(
    (pattern) =>
      pattern.test(normalized)
  );
}

/*
 * Provider request ID validation.
 */
function isValidBettingProviderRequestId(
  requestId
) {
  if (
    typeof requestId !== "string"
  ) {
    return false;
  }

  const normalized =
    requestId.trim();

  if (
    normalized.length === 0 ||
    normalized.length >
      BETTING_PROVIDER_LIMITS.providerRequestIdMaxLength
  ) {
    return false;
  }

  return /^[A-Za-z0-9_-]+$/.test(
    normalized
  );
}

module.exports = {
  BETTING_SERVICES,
  BETTING_PROVIDER_LIMITS,

  BETTING_PROVIDER_SUCCESS_STATUSES,
  BETTING_PROVIDER_FAILURE_STATUSES,

  BETTING_DEFINITE_FAILURE_CODES,
  BETTING_DEFINITE_FAILURE_MESSAGE_PATTERNS,

  normalizeBettingServiceId,
  isSupportedBettingServiceId,

  isValidBettingCustomerId,
  normalizeBettingCustomerId,

  isValidBettingAmountKobo,
  bettingKoboToNaira,

  normalizeBettingProviderStatus,
  isBettingProviderSuccessStatus,
  isBettingProviderFailureStatus,

  normalizeBettingProviderCode,
  isBettingDefiniteFailureCode,
  isBettingDefiniteFailureMessage,

  isValidBettingProviderRequestId,
};