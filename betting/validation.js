"use strict";

const {
  BETTING_PROVIDER_LIMITS,

  isSupportedBettingServiceId,

  normalizeBettingServiceId,

  isValidBettingCustomerId,

  normalizeBettingCustomerId,

  isValidBettingAmountKobo,

  getBettingProviderServiceId,
} = require("./constants");

/*
 * --------------------------------------------------------------------------
 * Result helpers
 * --------------------------------------------------------------------------
 */

function invalid(message) {
  return {
    valid: false,
    error: message,
  };
}

function valid(data) {
  return {
    valid: true,
    data,
  };
}

/*
 * --------------------------------------------------------------------------
 * Generic string normalization
 * --------------------------------------------------------------------------
 */

function normalizeInputString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

/*
 * --------------------------------------------------------------------------
 * Provider validation
 * --------------------------------------------------------------------------
 *
 * The application provider ID is normalized to lowercase.
 *
 * Example:
 *
 *   "bet9ja"
 *   "Bet9ja"
 *   " BET9JA "
 *
 * all become:
 *
 *   "bet9ja"
 *
 * The canonical VTU service ID is resolved separately:
 *
 *   "bet9ja" -> "Bet9ja"
 *
 * This distinction is important because our application provider ID
 * and VTU's service_id are not the same representation.
 * --------------------------------------------------------------------------
 */

function normalizeApplicationProvider(
  provider
) {
  const normalized =
    normalizeInputString(
      provider
    ).toLowerCase();

  return normalized;
}

function validateProvider(provider) {
  const normalizedProvider =
    normalizeApplicationProvider(
      provider
    );

  if (!normalizedProvider) {
    return invalid(
      "Invalid betting provider"
    );
  }

  const canonicalServiceId =
    getBettingProviderServiceId(
      normalizedProvider
    );

  if (!canonicalServiceId) {
    return invalid(
      "Unsupported betting service"
    );
  }

  /*
   * Confirm that the canonical service ID is actually present
   * in the supported service set.
   */
  const normalizedServiceId =
    normalizeBettingServiceId(
      canonicalServiceId
    );

  if (
    !isSupportedBettingServiceId(
      normalizedServiceId
    )
  ) {
    return invalid(
      "Unsupported betting service"
    );
  }

  return valid({
    provider:
      normalizedProvider,

    serviceId:
      canonicalServiceId,
  });
}

/*
 * --------------------------------------------------------------------------
 * Service ID validation
 * --------------------------------------------------------------------------
 *
 * This is useful when callers send serviceId explicitly.
 *
 * We accept either:
 *
 *   bet9ja
 *
 * or:
 *
 *   Bet9ja
 *
 * but always return the canonical service ID.
 * --------------------------------------------------------------------------
 */

function validateServiceId(
  serviceId
) {
  const normalized =
    normalizeInputString(
      serviceId
    );

  if (!normalized) {
    return invalid(
      "Invalid betting service"
    );
  }

  const normalizedServiceId =
    normalizeBettingServiceId(
      normalized
    );

  if (
    !normalizedServiceId ||
    !isSupportedBettingServiceId(
      normalizedServiceId
    )
  ) {
    return invalid(
      "Unsupported betting service"
    );
  }

  return valid(
    normalizedServiceId
  );
}

/*
 * --------------------------------------------------------------------------
 * Customer/account validation
 * --------------------------------------------------------------------------
 */

function validateCustomerId(
  customerId
) {
  const normalizedCustomerId =
    normalizeBettingCustomerId(
      customerId
    );

  if (
    !normalizedCustomerId ||
    !isValidBettingCustomerId(
      normalizedCustomerId
    )
  ) {
    return invalid(
      "Invalid betting customer ID"
    );
  }

  return valid(
    normalizedCustomerId
  );
}

/*
 * --------------------------------------------------------------------------
 * Amount validation
 * --------------------------------------------------------------------------
 *
 * Internal wallet amount is always kobo.
 *
 * Example:
 *
 *   ₦1,000 = 100000 kobo
 *
 * The constants layer also enforces the provider's whole-NGN requirement.
 * --------------------------------------------------------------------------
 */

function validateAmountKobo(
  amountKobo
) {
  if (
    !isValidBettingAmountKobo(
      amountKobo
    )
  ) {
    return invalid(
      "Invalid betting amount"
    );
  }

  return valid(
    Number(amountKobo)
  );
}

/*
 * --------------------------------------------------------------------------
 * Transaction ID validation
 * --------------------------------------------------------------------------
 *
 * Transaction ID is optional because the service can generate one.
 *
 * When supplied, it must:
 *
 *   - be a string
 *   - be within configured length limits
 *   - contain only [A-Za-z0-9_-]
 * --------------------------------------------------------------------------
 */

function validateTransactionId(
  transactionId
) {
  if (
    transactionId === undefined ||
    transactionId === null ||
    transactionId === ""
  ) {
    return valid(undefined);
  }

  if (
    typeof transactionId !==
    "string"
  ) {
    return invalid(
      "Invalid transaction ID"
    );
  }

  const normalized =
    transactionId.trim();

  if (!normalized) {
    return valid(undefined);
  }

  if (
    normalized.length <
      BETTING_PROVIDER_LIMITS.transactionIdMinLength ||
    normalized.length >
      BETTING_PROVIDER_LIMITS.transactionIdMaxLength
  ) {
    return invalid(
      "Invalid transaction ID"
    );
  }

  if (
    !/^[A-Za-z0-9_-]+$/.test(
      normalized
    )
  ) {
    return invalid(
      "Invalid transaction ID"
    );
  }

  return valid(
    normalized
  );
}

/*
 * --------------------------------------------------------------------------
 * Complete betting request validation
 * --------------------------------------------------------------------------
 *
 * Expected input:
 *
 * {
 *   provider: "bet9ja",
 *   customerId: "123456",
 *   amountKobo: 100000,
 *   transactionId: "optional-id"
 * }
 *
 * Optional:
 *
 *   accountId
 *   serviceId
 *
 * Output:
 *
 * {
 *   valid: true,
 *   data: {
 *     provider: "bet9ja",
 *     serviceId: "Bet9ja",
 *     customerId: "123456",
 *     amountKobo: 100000,
 *     transactionId: "optional-id"
 *   }
 * }
 * --------------------------------------------------------------------------
 */

function validateBettingRequest(
  body
) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return invalid(
      "Invalid betting request"
    );
  }

  /*
   * Provider is the primary service selector.
   */
  const providerResult =
    validateProvider(
      body.provider
    );

  if (
    !providerResult.valid
  ) {
    return providerResult;
  }

  const {
    provider,
    serviceId:
      providerServiceId,
  } = providerResult.data;

  /*
   * Customer ID is the canonical API field.
   *
   * accountId is retained for compatibility with the existing frontend.
   */
  const customerId =
    body.customerId ??
    body.accountId;

  const customerResult =
    validateCustomerId(
      customerId
    );

  if (
    !customerResult.valid
  ) {
    return customerResult;
  }

  /*
   * Amount must be supplied explicitly.
   *
   * We do not accept "amount" here because the internal financial
   * contract is amountKobo.
   */
  const amountResult =
    validateAmountKobo(
      body.amountKobo
    );

  if (
    !amountResult.valid
  ) {
    return amountResult;
  }

  /*
   * Transaction ID is optional.
   */
  const transactionResult =
    validateTransactionId(
      body.transactionId
    );

  if (
    !transactionResult.valid
  ) {
    return transactionResult;
  }

  /*
   * serviceId may be supplied by an older client.
   *
   * If supplied, it must refer to the SAME betting provider.
   *
   * This prevents a request such as:
   *
   *   provider:  "bet9ja"
   *   serviceId: "BetKing"
   *
   * from being accepted.
   */
  let canonicalServiceId =
    providerServiceId;

  const suppliedServiceId =
    normalizeInputString(
      body.serviceId
    );

  if (suppliedServiceId) {
    const serviceResult =
      validateServiceId(
        suppliedServiceId
      );

    if (
      !serviceResult.valid
    ) {
      return serviceResult;
    }

    const suppliedCanonicalServiceId =
      serviceResult.data;

    if (
      suppliedCanonicalServiceId !==
      providerServiceId
    ) {
      return invalid(
        "Betting provider and service do not match"
      );
    }

    canonicalServiceId =
      suppliedCanonicalServiceId;
  }

  return valid({
    provider,

    serviceId:
      canonicalServiceId,

    customerId:
      customerResult.data,

    amountKobo:
      amountResult.data,

    transactionId:
      transactionResult.data,
  });
}

/*
 * --------------------------------------------------------------------------
 * Exports
 * --------------------------------------------------------------------------
 */

module.exports = {
  validateBettingRequest,

  validateProvider,

  validateServiceId,

  validateCustomerId,

  validateAmountKobo,

  validateTransactionId,

  BETTING_PROVIDER_LIMITS,
};