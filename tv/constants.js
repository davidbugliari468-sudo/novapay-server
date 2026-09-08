"use strict";

/*
 * TV service constants.
 *
 * This file contains only TV-specific configuration and
 * validation helpers.
 *
 * It does NOT:
 * - access Firestore
 * - access the wallet
 * - call VTU.ng
 * - create transactions
 * - authenticate users
 *
 * Those responsibilities belong to later TV modules.
 */

const TV_SERVICES = Object.freeze({
  DSTV: "dstv",
  GOTV: "gotv",
  STARTIMES: "startimes",
  SHOWMAX: "showmax",
});

const SUPPORTED_TV_SERVICE_IDS = Object.freeze(
  new Set([
    TV_SERVICES.DSTV,
    TV_SERVICES.GOTV,
    TV_SERVICES.STARTIMES,
    TV_SERVICES.SHOWMAX,
  ])
);

/*
 * VTU.ng currently requires a variation_id for TV
 * purchases.
 *
 * We intentionally do NOT hard-code individual bouquet
 * IDs here because VTU.ng can change available
 * variations and pricing.
 *
 * Valid variation IDs will later be obtained from:
 *
 *   GET /api/v2/variations/tv
 */
const TV_INPUT_LIMITS = Object.freeze({
  CUSTOMER_ID_MIN_LENGTH: 4,
  CUSTOMER_ID_MAX_LENGTH: 40,

  VARIATION_ID_MAX_LENGTH: 50,

  /*
   * VTU.ng accepts integer NGN amounts.
   * NovaPay stores money internally in kobo.
   */
  MIN_AMOUNT_KOBO: 100,
  MAX_AMOUNT_KOBO: 10000000,
});

/*
 * Provider request IDs have a maximum length of 50
 * characters according to VTU.ng.
 */
const TV_PROVIDER_LIMITS = Object.freeze({
  REQUEST_ID_MAX_LENGTH: 50,
});

/*
 * Provider statuses that represent a confirmed
 * successful TV order.
 *
 * Keep this list deliberately small.
 *
 * Anything not explicitly recognized as success or
 * definite failure must remain UNKNOWN.
 */
const TV_PROVIDER_SUCCESS_STATUSES = Object.freeze(
  new Set([
    "completed-api",
  ])
);

/*
 * Provider statuses that represent a definite
 * unsuccessful/refunded order.
 *
 * "processing-api", "queued-api", "initiated-api",
 * "pending", and "on-hold" are intentionally NOT here.
 *
 * Those statuses do not prove failure and therefore
 * must never cause a customer reservation to be
 * released.
 */
const TV_PROVIDER_FAILURE_STATUSES = Object.freeze(
  new Set([
    "failed",
    "refunded",
    "cancelled",
  ])
);

/*
 * These are provider error codes that represent a
 * definite failure for a TV purchase.
 *
 * IMPORTANT:
 *
 * duplicate_request
 * duplicate_request_id
 * duplicate_order
 *
 * are deliberately NOT included.
 *
 * A duplicate response can mean the provider already
 * accepted the original request. Releasing the
 * customer's reservation based only on a duplicate
 * response could therefore create a financial loss.
 *
 * Such cases must remain UNKNOWN and be reconciled.
 */
const TV_DEFINITE_FAILURE_CODES = Object.freeze(
  new Set([
    "insufficient_funds",
    "insufficient-funds",
    "insufficient balance",
    "insufficient_balance",

    "invalid_service",
    "invalid_service_id",

    "invalid_variation_id",

    "missing_fields",

    "product_unavailable",
    "product-unavailable",

    "order_failed",
    "order-failed",

    "failure",

    "invalid_customer",
    "invalid_customer_id",
  ])
);

/*
 * Human-readable provider messages that can safely
 * indicate a definite failure.
 *
 * Do NOT add generic messages such as:
 *
 *   "request failed"
 *   "order error"
 *   "unable to process"
 *   "duplicate order"
 *
 * unless we have enough evidence that the provider
 * message definitively means the purchase did not
 * happen.
 */
const TV_DEFINITE_FAILURE_MESSAGE_PATTERNS =
  Object.freeze([
    "insufficient funds",
    "insufficient_funds",
    "insufficient-funds",

    "invalid service",
    "invalid service id",

    "invalid variation",

    "missing fields",
    "missing required fields",

    "product unavailable",
    "product-unavailable",

    "order failed",
    "order_failed",
    "order-failed",

    "invalid customer",
    "invalid customer id",

    "verification failed",
  ]);

/*
 * Normalize a provider/service ID.
 */
function normalizeTvServiceId(
  serviceId
) {
  return String(
    serviceId ?? ""
  )
    .trim()
    .toLowerCase();
}

/*
 * Check whether the supplied TV service is supported.
 */
function isSupportedTvServiceId(
  serviceId
) {
  const normalized =
    normalizeTvServiceId(
      serviceId
    );

  return SUPPORTED_TV_SERVICE_IDS.has(
    normalized
  );
}

/*
 * Normalize customer IDs without changing the actual
 * identifier.
 *
 * We deliberately do not convert TV customer IDs to
 * numbers because smartcard/IUC identifiers must be
 * treated as strings.
 */
function normalizeTvCustomerId(
  customerId
) {
  return String(
    customerId ?? ""
  ).trim();
}

/*
 * TV smartcard/IUC/customer identifiers can vary by
 * provider, so we allow alphanumeric identifiers plus
 * a small set of safe separators.
 */
function isValidTvCustomerId(
  customerId
) {
  const normalized =
    normalizeTvCustomerId(
      customerId
    );

  if (
    normalized.length <
      TV_INPUT_LIMITS
        .CUSTOMER_ID_MIN_LENGTH
  ) {
    return false;
  }

  if (
    normalized.length >
      TV_INPUT_LIMITS
        .CUSTOMER_ID_MAX_LENGTH
  ) {
    return false;
  }

  return /^[A-Za-z0-9._:/-]+$/.test(
    normalized
  );
}

/*
 * Variation IDs come from VTU.ng.
 *
 * We keep them as strings because the API documents
 * variation_id as a string and provider variation IDs
 * should not be assumed to fit a JavaScript integer.
 */
function normalizeTvVariationId(
  variationId
) {
  return String(
    variationId ?? ""
  ).trim();
}

function isValidTvVariationId(
  variationId
) {
  const normalized =
    normalizeTvVariationId(
      variationId
    );

  if (
    !normalized ||
    normalized.length >
      TV_INPUT_LIMITS
        .VARIATION_ID_MAX_LENGTH
  ) {
    return false;
  }

  return /^[A-Za-z0-9._:-]+$/.test(
    normalized
  );
}

/*
 * Normalize money to a safe integer number of kobo.
 */
function normalizeTvAmountKobo(
  amountKobo
) {
  const value =
    Number(
      amountKobo
    );

  if (
    !Number.isSafeInteger(
      value
    )
  ) {
    return null;
  }

  return value;
}

function isValidTvAmountKobo(
  amountKobo
) {
  const value =
    normalizeTvAmountKobo(
      amountKobo
    );

  if (
    value === null
  ) {
    return false;
  }

  if (
    value <
      TV_INPUT_LIMITS
        .MIN_AMOUNT_KOBO
  ) {
    return false;
  }

  if (
    value >
      TV_INPUT_LIMITS
        .MAX_AMOUNT_KOBO
  ) {
    return false;
  }

  /*
   * VTU.ng TV amounts are expressed in whole NGN.
   * Therefore NovaPay's kobo amount must be divisible
   * by 100.
   */
  if (
    value % 100 !== 0
  ) {
    return false;
  }

  return true;
}

/*
 * Convert NovaPay's internal kobo amount to the
 * integer NGN amount required by VTU.ng.
 */
function tvKoboToNaira(
  amountKobo
) {
  const value =
    normalizeTvAmountKobo(
      amountKobo
    );

  if (
    value === null ||
    value % 100 !== 0
  ) {
    return null;
  }

  return value / 100;
}

/*
 * Normalize provider status for comparison.
 */
function normalizeTvProviderStatus(
  status
) {
  return String(
    status ?? ""
  )
    .trim()
    .toLowerCase();
}

/*
 * Determine whether a provider status proves
 * successful completion.
 */
function isTvProviderSuccessStatus(
  status
) {
  return TV_PROVIDER_SUCCESS_STATUSES.has(
    normalizeTvProviderStatus(
      status
    )
  );
}

/*
 * Determine whether a provider status proves
 * definite failure/refund/cancellation.
 */
function isTvProviderFailureStatus(
  status
) {
  return TV_PROVIDER_FAILURE_STATUSES.has(
    normalizeTvProviderStatus(
      status
    )
  );
}

/*
 * Normalize provider error codes.
 */
function normalizeTvProviderCode(
  code
) {
  return String(
    code ?? ""
  )
    .trim()
    .toLowerCase();
}

/*
 * Determine whether a provider code represents
 * definite failure.
 *
 * Unknown codes deliberately return false.
 */
function isTvDefiniteFailureCode(
  code
) {
  return TV_DEFINITE_FAILURE_CODES.has(
    normalizeTvProviderCode(
      code
    )
  );
}

/*
 * Determine whether a provider message contains a
 * known definite failure phrase.
 *
 * Unknown messages deliberately return false.
 */
function isTvDefiniteFailureMessage(
  message
) {
  const normalized =
    String(
      message ?? ""
    )
      .trim()
      .toLowerCase();

  if (!normalized) {
    return false;
  }

  return TV_DEFINITE_FAILURE_MESSAGE_PATTERNS.some(
    (pattern) =>
      normalized.includes(
        pattern
      )
  );
}

module.exports = {
  TV_SERVICES,
  SUPPORTED_TV_SERVICE_IDS,

  TV_INPUT_LIMITS,
  TV_PROVIDER_LIMITS,

  TV_PROVIDER_SUCCESS_STATUSES,
  TV_PROVIDER_FAILURE_STATUSES,

  TV_DEFINITE_FAILURE_CODES,
  TV_DEFINITE_FAILURE_MESSAGE_PATTERNS,

  normalizeTvServiceId,
  isSupportedTvServiceId,

  normalizeTvCustomerId,
  isValidTvCustomerId,

  normalizeTvVariationId,
  isValidTvVariationId,

  normalizeTvAmountKobo,
  isValidTvAmountKobo,
  tvKoboToNaira,

  normalizeTvProviderStatus,
  isTvProviderSuccessStatus,
  isTvProviderFailureStatus,

  normalizeTvProviderCode,
  isTvDefiniteFailureCode,
  isTvDefiniteFailureMessage,
};