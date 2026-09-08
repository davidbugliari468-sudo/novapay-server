"use strict";

const {
  BETTING_PROVIDER_LIMITS,
  isSupportedBettingServiceId,
  normalizeBettingServiceId,
  isValidBettingCustomerId,
  normalizeBettingCustomerId,
  isValidBettingAmountKobo,
} = require("./constants");

function invalid(message) {
  return {
    valid: false,
    message,
  };
}

function valid(data) {
  return {
    valid: true,
    data,
  };
}

/*
 * Validate betting provider/service.
 *
 * The provider is normalized into the canonical
 * representation used by the backend.
 */
function validateProvider(provider) {
  const normalizedProvider =
    normalizeBettingServiceId(
      provider
    );

  if (
    !isSupportedBettingServiceId(
      normalizedProvider
    )
  ) {
    return invalid(
      "Unsupported betting provider"
    );
  }

  return valid(
    normalizedProvider
  );
}

/*
 * Validate betting account/customer ID.
 */
function validateCustomerId(
  customerId
) {
  const normalizedCustomerId =
    normalizeBettingCustomerId(
      customerId
    );

  if (
    !isValidBettingCustomerId(
      normalizedCustomerId
    )
  ) {
    return invalid(
      "Invalid betting account ID"
    );
  }

  return valid(
    normalizedCustomerId
  );
}

/*
 * Validate amount in kobo.
 *
 * The wallet layer stores money in kobo.
 * The provider adapter will later convert it
 * to whole NGN when making the VTU request.
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
 * Validate an optional client transaction ID.
 *
 * The service layer remains responsible for generating
 * a transaction ID when the client does not provide one.
 *
 * This validation only checks format.
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

  /*
   * Restrict transaction IDs to characters that are safe
   * for Firestore document IDs and provider request-ID
   * derivation.
   */
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
 * Validate the complete betting funding request.
 *
 * Expected request shape:
 *
 * {
 *   provider: "bet9ja",
 *   customerId: "123456",
 *   amountKobo: 100000,
 *   transactionId: "optional-id"
 * }
 *
 * The frontend must not be trusted for financial
 * authorization. This function only validates the
 * request shape and values.
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

  const providerResult =
    validateProvider(
      body.provider
    );

  if (
    !providerResult.valid
  ) {
    return providerResult;
  }

  /*
   * Accept customerId as the canonical field.
   *
   * accountId is also accepted to make the backend
   * tolerant of a frontend using that terminology.
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

  const amountResult =
    validateAmountKobo(
      body.amountKobo
    );

  if (
    !amountResult.valid
  ) {
    return amountResult;
  }

  const transactionResult =
    validateTransactionId(
      body.transactionId
    );

  if (
    !transactionResult.valid
  ) {
    return transactionResult;
  }

  return valid({
    provider:
      providerResult.data,

    customerId:
      customerResult.data,

    amountKobo:
      amountResult.data,

    transactionId:
      transactionResult.data,
  });
}

module.exports = {
  validateBettingRequest,

  validateProvider,
  validateCustomerId,
  validateAmountKobo,
  validateTransactionId,

  BETTING_PROVIDER_LIMITS,
};