"use strict";

/*
 * NovaPay Betting Constants
 *
 * Provider:
 *   VTU.ng API v2
 *
 * Purpose:
 *   Central source of truth for:
 *   - supported betting providers
 *   - canonical VTU service IDs
 *   - validation limits
 *   - provider status classification
 *   - provider error classification
 *
 * Financial rule:
 *
 *   completed-api
 *     -> definite provider success
 *
 *   refunded / failed / cancelled
 *     -> definite provider failure
 *
 *   processing-api / initiated-api / queued-api /
 *   pending / on-hold
 *     -> provider outcome is not final
 *
 *   timeout / network failure / malformed response /
 *   ambiguous provider response
 *     -> UNKNOWN
 *
 * IMPORTANT:
 *   duplicate_request_id and duplicate_order are NEVER
 *   classified as definite failures because the original
 *   request may already have been accepted by VTU.ng.
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

const BETTING_SERVICE_SET = new Set(
  BETTING_SERVICES
);

/*
 * Canonical service IDs expected by VTU.ng.
 *
 * NovaPay internally normalizes provider IDs to lowercase.
 * VTU.ng examples/documentation use provider names such as
 * "Bet9ja", "BetWay", "SportyBet", etc.
 *
 * Keep this mapping in one place so the VTU adapter does not
 * need its own duplicate provider mapping.
 */
const BETTING_PROVIDER_SERVICE_IDS =
  Object.freeze({
    "1xbet": "1xBet",
    bangbet: "BangBet",
    bet9ja: "Bet9ja",
    betking: "BetKing",
    betland: "BetLand",
    betlion: "BetLion",
    betway: "BetWay",
    cloudbet: "CloudBet",
    livescorebet: "LiveScoreBet",
    merrybet: "MerryBet",
    naijabet: "NaijaBet",
    nairabet: "NairaBet",
    sportybet: "SportyBet",
    supabet: "SupaBet",
  });

/*
 * Provider limits.
 *
 * NovaPay stores wallet amounts in kobo.
 * VTU.ng betting amounts are whole NGN.
 */
const BETTING_PROVIDER_LIMITS = Object.freeze({
  customerIdMinLength: 1,
  customerIdMaxLength: 100,

  amountMinKobo: 100 * 100,
  amountMaxKobo: 100000 * 100,

  providerRequestIdMaxLength: 50,

  /*
   * Backend transaction IDs are generated internally.
   * This is intentionally independent from the provider
   * request_id limit.
   */
  transactionIdMinLength: 10,
  transactionIdMaxLength: 120,
});

/*
 * VTU.ng terminal success status.
 *
 * Only completed-api permanently commits the NovaPay
 * wallet reservation.
 */
const BETTING_PROVIDER_SUCCESS_STATUSES =
  Object.freeze([
    "completed-api",
  ]);

/*
 * Explicit terminal provider failure statuses.
 *
 * These are safe to reconcile as failures when returned
 * by the provider's order status/requery response.
 */
const BETTING_PROVIDER_FAILURE_STATUSES =
  Object.freeze([
    "failed",
    "refunded",
    "cancelled",
  ]);

/*
 * Non-terminal provider statuses.
 *
 * These MUST NOT release the customer's reservation.
 *
 * The transaction remains pending/unknown until a later
 * provider status confirms success or failure.
 */
const BETTING_PROVIDER_PENDING_STATUSES =
  Object.freeze([
    "initiated-api",
    "queued-api",
    "processing-api",
    "pending",
    "on-hold",
  ]);

/*
 * Provider error codes that prove a funding request
 * was rejected before successful completion.
 *
 * IMPORTANT:
 *
 * duplicate_request_id
 * duplicate_request
 * duplicate_order
 *
 * are deliberately excluded.
 *
 * A duplicate response may mean the original request
 * already exists at VTU.ng, therefore the safe action
 * is reconciliation rather than releasing funds.
 *
 * Also deliberately excluded:
 *
 * service_unavailable
 * product_unavailable
 *
 * These can represent transient provider conditions and
 * should not automatically cause a financial reversal.
 *
 * "failure" is also excluded because VTU.ng documents
 * that code specifically for verify-customer failures.
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

    "invalid_field",
    "invalid_request_id",

    "order_failed",
    "failed",

    "account_not_found",
    "customer_not_found",
  ]);

/*
 * Codes that indicate the provider may already have
 * knowledge of the request.
 *
 * These require reconciliation instead of an automatic
 * wallet release.
 */
const BETTING_AMBIGUOUS_CODES =
  Object.freeze([
    "duplicate_request",
    "duplicate_request_id",
    "duplicate_order",
    "request_id_error",
    "service_unavailable",
    "product_unavailable",
    "wallet_busy",
    "rate_limit_exceeded",
  ]);

/*
 * Conservative provider message patterns that can establish
 * a definite failure when a structured provider code is
 * unavailable.
 *
 * Do NOT add generic phrases such as:
 *
 *   "unable to process"
 *   "request failed"
 *   "try again"
 *   "timeout"
 *   "network error"
 *   "service unavailable"
 *
 * because those may represent an unknown provider outcome.
 */
const BETTING_DEFINITE_FAILURE_MESSAGE_PATTERNS =
  Object.freeze([
    /insufficient\s+funds/i,

    /invalid\s+(?:service|provider)(?:\s+id)?/i,

    /invalid\s+(?:customer|betting)(?:\s+id)?/i,

    /customer\s+(?:not\s+found|does\s+not\s+exist)/i,

    /account\s+(?:not\s+found|does\s+not\s+exist)/i,

    /below\s+(?:the\s+)?minimum/i,

    /above\s+(?:the\s+)?maximum/i,

    /invalid\s+amount/i,

    /invalid\s+field/i,

    /invalid\s+request\s+id/i,

    /missing\s+(?:required\s+)?field/i,

    /order\s+(?:failed|rejected)/i,

    /transaction\s+(?:failed|rejected)/i,
  ]);

/*
 * Normalize arbitrary string input.
 */
function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

/*
 * Normalize a betting provider/service ID to NovaPay's
 * internal canonical lowercase representation.
 */
function normalizeBettingServiceId(serviceId) {
  return normalizeString(serviceId).toLowerCase();
}

/*
 * Determine whether a provider/service is supported.
 */
function isSupportedBettingServiceId(serviceId) {
  const normalized =
    normalizeBettingServiceId(serviceId);

  return BETTING_SERVICE_SET.has(normalized);
}

/*
 * Convert an internal provider ID to the exact service ID
 * expected by VTU.ng.
 *
 * Returns an empty string for unsupported providers.
 */
function getBettingProviderServiceId(serviceId) {
  const normalized =
    normalizeBettingServiceId(serviceId);

  return (
    BETTING_PROVIDER_SERVICE_IDS[normalized] ||
    ""
  );
}

/*
 * Validate betting customer/account ID.
 *
 * We intentionally do not require numeric-only IDs because
 * provider account identifiers may differ between betting
 * services.
 *
 * VTU.ng remains authoritative for whether the actual
 * customer account exists.
 */
function isValidBettingCustomerId(customerId) {
  if (typeof customerId !== "string") {
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
function normalizeBettingCustomerId(customerId) {
  return normalizeString(customerId);
}

/*
 * Validate an amount stored in kobo.
 *
 * Betting funding must be representable as a whole NGN
 * amount because VTU.ng expects an integer amount.
 */
function isValidBettingAmountKobo(amountKobo) {
  if (
    amountKobo === null ||
    amountKobo === undefined ||
    amountKobo === ""
  ) {
    return false;
  }

  const numeric = Number(amountKobo);

  if (!Number.isSafeInteger(numeric)) {
    return false;
  }

  if (
    numeric <
      BETTING_PROVIDER_LIMITS.amountMinKobo ||
    numeric >
      BETTING_PROVIDER_LIMITS.amountMaxKobo
  ) {
    return false;
  }

  /*
   * 100 kobo = ₦1.
   *
   * VTU.ng requires a whole NGN amount, so values such as
   * ₦100.50 must never be sent to the provider.
   */
  return numeric % 100 === 0;
}

/*
 * Convert validated kobo to whole NGN.
 */
function bettingKoboToNaira(amountKobo) {
  if (
    !isValidBettingAmountKobo(
      amountKobo
    )
  ) {
    throw new Error(
      "Invalid betting amount"
    );
  }

  return Number(amountKobo) / 100;
}

/*
 * Normalize provider status.
 */
function normalizeBettingProviderStatus(status) {
  return normalizeString(status).toLowerCase();
}

/*
 * Determine whether a provider status is definite
 * success.
 */
function isBettingProviderSuccessStatus(status) {
  const normalized =
    normalizeBettingProviderStatus(status);

  return BETTING_PROVIDER_SUCCESS_STATUSES.includes(
    normalized
  );
}

/*
 * Determine whether a provider status is definite
 * failure.
 */
function isBettingProviderFailureStatus(status) {
  const normalized =
    normalizeBettingProviderStatus(status);

  return BETTING_PROVIDER_FAILURE_STATUSES.includes(
    normalized
  );
}

/*
 * Determine whether a provider status is still
 * non-terminal/pending.
 */
function isBettingProviderPendingStatus(status) {
  const normalized =
    normalizeBettingProviderStatus(status);

  return BETTING_PROVIDER_PENDING_STATUSES.includes(
    normalized
  );
}

/*
 * Normalize provider error/outcome code.
 */
function normalizeBettingProviderCode(code) {
  return normalizeString(code).toLowerCase();
}

/*
 * Determine whether a provider code proves a
 * definite failure.
 */
function isBettingDefiniteFailureCode(code) {
  const normalized =
    normalizeBettingProviderCode(code);

  return BETTING_DEFINITE_FAILURE_CODES.includes(
    normalized
  );
}

/*
 * Determine whether a provider code represents an
 * ambiguous outcome that requires reconciliation.
 */
function isBettingAmbiguousCode(code) {
  const normalized =
    normalizeBettingProviderCode(code);

  return BETTING_AMBIGUOUS_CODES.includes(
    normalized
  );
}

/*
 * Determine whether a provider message proves a
 * definite failure.
 */
function isBettingDefiniteFailureMessage(message) {
  const normalized =
    normalizeString(message);

  if (!normalized) {
    return false;
  }

  return BETTING_DEFINITE_FAILURE_MESSAGE_PATTERNS.some(
    (pattern) =>
      pattern.test(normalized)
  );
}

/*
 * Validate a provider request ID.
 */
function isValidBettingProviderRequestId(
  requestId
) {
  if (typeof requestId !== "string") {
    return false;
  }

  const normalized =
    requestId.trim();

  if (
    normalized.length === 0 ||
    normalized.length >
      BETTING_PROVIDER_LIMITS
        .providerRequestIdMaxLength
  ) {
    return false;
  }

  return /^[A-Za-z0-9_-]+$/.test(
    normalized
  );
}

module.exports = {
  BETTING_SERVICES,
  BETTING_SERVICE_SET,
  BETTING_PROVIDER_SERVICE_IDS,
  BETTING_PROVIDER_LIMITS,

  BETTING_PROVIDER_SUCCESS_STATUSES,
  BETTING_PROVIDER_FAILURE_STATUSES,
  BETTING_PROVIDER_PENDING_STATUSES,

  BETTING_DEFINITE_FAILURE_CODES,
  BETTING_AMBIGUOUS_CODES,
  BETTING_DEFINITE_FAILURE_MESSAGE_PATTERNS,

  normalizeString,

  normalizeBettingServiceId,
  isSupportedBettingServiceId,
  getBettingProviderServiceId,

  isValidBettingCustomerId,
  normalizeBettingCustomerId,

  isValidBettingAmountKobo,
  bettingKoboToNaira,

  normalizeBettingProviderStatus,
  isBettingProviderSuccessStatus,
  isBettingProviderFailureStatus,
  isBettingProviderPendingStatus,

  normalizeBettingProviderCode,
  isBettingDefiniteFailureCode,
  isBettingAmbiguousCode,
  isBettingDefiniteFailureMessage,

  isValidBettingProviderRequestId,
};