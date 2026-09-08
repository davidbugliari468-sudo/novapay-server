"use strict";

const {
  TV_PROVIDER_LIMITS,
  isSupportedTvServiceId,
  normalizeTvServiceId,
  isValidTvCustomerId,
  normalizeTvCustomerId,
  isValidTvVariationId,
  normalizeTvVariationId,
  isValidTvAmountKobo,
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

function validateProvider(provider) {
  const normalizedProvider =
    normalizeTvServiceId(provider);

  if (
    !isSupportedTvServiceId(
      normalizedProvider
    )
  ) {
    return invalid(
      "Unsupported TV provider"
    );
  }

  return valid(normalizedProvider);
}

function validateCustomerId(customerId) {
  const normalizedCustomerId =
    normalizeTvCustomerId(customerId);

  if (
    !isValidTvCustomerId(
      normalizedCustomerId
    )
  ) {
    return invalid(
      "Invalid customer or smartcard number"
    );
  }

  return valid(normalizedCustomerId);
}

function validateServiceId(serviceId) {
  const normalizedServiceId =
    normalizeTvServiceId(serviceId);

  if (
    !isSupportedTvServiceId(
      normalizedServiceId
    )
  ) {
    return invalid(
      "Invalid TV service ID"
    );
  }

  return valid(normalizedServiceId);
}

function validateVariationId(variationId) {
  const normalizedVariationId =
    normalizeTvVariationId(
      variationId
    );

  if (
    !isValidTvVariationId(
      normalizedVariationId
    )
  ) {
    return invalid(
      "Invalid TV variation"
    );
  }

  return valid(normalizedVariationId);
}

function validateAmountKobo(amountKobo) {
  if (
    !isValidTvAmountKobo(
      amountKobo
    )
  ) {
    return invalid(
      "Invalid TV purchase amount"
    );
  }

  return valid(
    Number(amountKobo)
  );
}

function validateSubscriptionType(
  subscriptionType
) {
  if (
    subscriptionType ===
      undefined ||
    subscriptionType === null ||
    subscriptionType === ""
  ) {
    return valid("change");
  }

  if (
    typeof subscriptionType !==
    "string"
  ) {
    return invalid(
      "Invalid subscription type"
    );
  }

  const normalized =
    subscriptionType
      .trim()
      .toLowerCase();

  if (
    normalized !== "change" &&
    normalized !== "renew"
  ) {
    return invalid(
      "Invalid subscription type"
    );
  }

  return valid(normalized);
}

function validateTransactionId(
  transactionId
) {
  if (
    transactionId ===
      undefined ||
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
    normalized.length < 10 ||
    normalized.length > 120
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

  return valid(normalized);
}

function validateTvRequest(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return invalid(
      "Invalid TV purchase request"
    );
  }

  const providerResult =
    validateProvider(
      body.provider
    );

  if (!providerResult.valid) {
    return providerResult;
  }

  const customerId =
    body.smartcardNumber ??
    body.customerId;

  const customerResult =
    validateCustomerId(
      customerId
    );

  if (!customerResult.valid) {
    return customerResult;
  }

  const serviceResult =
    validateServiceId(
      body.serviceId
    );

  if (!serviceResult.valid) {
    return serviceResult;
  }

  /*
   * The provider and service ID must agree.
   *
   * Example:
   * provider = dstv
   * serviceId = dstv
   *
   * A client must not select one provider while
   * submitting another provider's service ID.
   */
  if (
    providerResult.data !==
    serviceResult.data
  ) {
    return invalid(
      "TV service does not match provider"
    );
  }

  const variationResult =
    validateVariationId(
      body.variationId
    );

  if (!variationResult.valid) {
    return variationResult;
  }

  const amountResult =
    validateAmountKobo(
      body.amountKobo
    );

  if (!amountResult.valid) {
    return amountResult;
  }

  const subscriptionResult =
    validateSubscriptionType(
      body.subscriptionType
    );

  if (!subscriptionResult.valid) {
    return subscriptionResult;
  }

  const transactionResult =
    validateTransactionId(
      body.transactionId
    );

  if (!transactionResult.valid) {
    return transactionResult;
  }

  return valid({
    provider:
      providerResult.data,

    customerId:
      customerResult.data,

    serviceId:
      serviceResult.data,

    variationId:
      variationResult.data,

    amountKobo:
      amountResult.data,

    subscriptionType:
      subscriptionResult.data,

    transactionId:
      transactionResult.data,
  });
}

module.exports = {
  validateTvRequest,
  validateProvider,
  validateCustomerId,
  validateServiceId,
  validateVariationId,
  validateAmountKobo,
  validateSubscriptionType,
  validateTransactionId,

  TV_PROVIDER_LIMITS,
};