"use strict";

const axios = require("axios");
const { z } = require("zod");

const BABSPAY_BASE_URL = "https://babspay.com.ng/api";
const BABSPAY_API_KEY = process.env.BABSPAY_API_KEY;

if (!BABSPAY_API_KEY) {
  throw new Error(
    "BABSPAY_API_KEY is not configured. Add it to the server environment before starting NovaPay."
  );
}

const babspayClient = axios.create({
  baseURL: BABSPAY_BASE_URL,
  timeout: 15000,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Token ${BABSPAY_API_KEY}`,
  },
  validateStatus: (status) => status >= 200 && status < 500,
});

/*
 * BabsPay response envelope.
 *
 * We intentionally keep `data` flexible here because successful,
 * pending/processing, and failed responses may not contain exactly
 * the same fields.
 */
const BabsPayResponseSchema = z.object({
  status: z.string().trim().min(1),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});

const NINVerificationDataSchema = z.object({
  ref: z.string().trim().min(1),
  data: z
    .object({
      nin: z.string().optional(),
      firstname: z.string().optional(),
      middlename: z.string().optional(),
      surname: z.string().optional(),
      gender: z.string().optional(),
      birthdate: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      state: z.string().optional(),
      lga: z.string().optional(),
    })
    .optional(),
});

const BVNVerificationDataSchema = z.object({
  ref: z.string().trim().min(1),
  data: z
    .object({
      bvn: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      dateOfBirth: z.string().optional(),
      phoneNumber: z.string().optional(),
    })
    .optional(),
});

const NINSlipDataSchema = z.object({
  ref: z.string().trim().min(1),
  slip_type: z.string().optional(),
  slip_url: z.string().url().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

class BabsPayError extends Error {
  constructor(message, code = "BABSPAY_ERROR") {
    super(message);
    this.name = "BabsPayError";
    this.code = code;
  }
}

function sanitizeProviderMessage(message) {
  if (typeof message !== "string") {
    return "BabsPay request failed.";
  }

  const cleaned = message
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "BabsPay request failed.";
  }

  return cleaned.slice(0, 200);
}

function normalizeStatus(status) {
  if (typeof status !== "string") {
    return "";
  }

  return status.trim().toLowerCase();
}

function classifyStatus(status) {
  const normalized = normalizeStatus(status);

  if (normalized === "success") {
    return "success";
  }

  if (
    normalized === "pending" ||
    normalized === "processing" ||
    normalized === "in_progress" ||
    normalized === "in-progress"
  ) {
    return "pending";
  }

  return "failed";
}

function getProviderErrorMessage(responseData, fallbackMessage) {
  if (!responseData || typeof responseData !== "object") {
    return fallbackMessage;
  }

  return (
    responseData.msg ||
    responseData.message ||
    responseData.error ||
    fallbackMessage
  );
}

async function postToBabsPay(endpoint, payload, operationName) {
  try {
    const response = await babspayClient.post(endpoint, payload);

    const parsed = BabsPayResponseSchema.safeParse(response.data);

    if (!parsed.success) {
      throw new BabsPayError(
        `BabsPay returned an unexpected ${operationName} response.`,
        "BABSPAY_INVALID_RESPONSE"
      );
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof BabsPayError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      if (
        error.code === "ECONNABORTED" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ERR_CANCELED"
      ) {
        throw new BabsPayError(
          `BabsPay ${operationName} service timed out.`,
          "BABSPAY_TIMEOUT"
        );
      }

      if (!error.response) {
        throw new BabsPayError(
          `BabsPay ${operationName} service is unavailable.`,
          "BABSPAY_UNAVAILABLE"
        );
      }

      const providerMessage = getProviderErrorMessage(
        error.response.data,
        `BabsPay ${operationName} request failed.`
      );

      throw new BabsPayError(
        sanitizeProviderMessage(providerMessage),
        "BABSPAY_REQUEST_FAILED"
      );
    }

    throw new BabsPayError(
      `BabsPay ${operationName} request failed.`,
      "BABSPAY_UNKNOWN_ERROR"
    );
  }
}

async function verifyNIN(nin) {
  const response = await postToBabsPay(
    "/verify_nin",
    { nin },
    "NIN verification"
  );

  const result = {
    status: normalizeStatus(response.status),
    state: classifyStatus(response.status),
    message: sanitizeProviderMessage(response.msg || ""),
    ref: null,
    data: null,
  };

  /*
   * Only require the detailed provider payload when BabsPay
   * actually reports success.
   */
  if (result.state === "success") {
    const parsedData = NINVerificationDataSchema.safeParse(response.data);

    if (!parsedData.success) {
      throw new BabsPayError(
        "BabsPay returned an incomplete NIN verification response.",
        "BABSPAY_INVALID_RESPONSE"
      );
    }

    result.ref = parsedData.data.ref;
    result.data = parsedData.data.data || null;

    return result;
  }

  /*
   * Pending/processing responses may contain a reference,
   * but we do not require one because the provider's exact
   * pending response shape is not assumed.
   */
  if (response.data && typeof response.data === "object") {
    const possibleRef =
      typeof response.data.ref === "string"
        ? response.data.ref.trim()
        : null;

    result.ref = possibleRef || null;
  }

  return result;
}

async function verifyBVN(bvn) {
  const response = await postToBabsPay(
    "/verify_bvn",
    { bvn },
    "BVN verification"
  );

  const result = {
    status: normalizeStatus(response.status),
    state: classifyStatus(response.status),
    message: sanitizeProviderMessage(response.msg || ""),
    ref: null,
    data: null,
  };

  if (result.state === "success") {
    const parsedData = BVNVerificationDataSchema.safeParse(response.data);

    if (!parsedData.success) {
      throw new BabsPayError(
        "BabsPay returned an incomplete BVN verification response.",
        "BABSPAY_INVALID_RESPONSE"
      );
    }

    result.ref = parsedData.data.ref;
    result.data = parsedData.data.data || null;

    return result;
  }

  if (response.data && typeof response.data === "object") {
    const possibleRef =
      typeof response.data.ref === "string"
        ? response.data.ref.trim()
        : null;

    result.ref = possibleRef || null;
  }

  return result;
}

async function generateNINSlip(nin, slipType) {
  const response = await postToBabsPay(
    "/nin_slip",
    {
      nin,
      slip_type: slipType,
    },
    "NIN slip generation"
  );

  const state = classifyStatus(response.status);

  if (state !== "success") {
    return {
      status: normalizeStatus(response.status),
      state,
      message: sanitizeProviderMessage(response.msg || ""),
      ref:
        response.data &&
        typeof response.data === "object" &&
        typeof response.data.ref === "string"
          ? response.data.ref.trim()
          : null,
      slipType,
      slipUrl: null,
      data: null,
    };
  }

  const parsedData = NINSlipDataSchema.safeParse(response.data);

  if (!parsedData.success) {
    throw new BabsPayError(
      "BabsPay returned an incomplete NIN slip response.",
      "BABSPAY_INVALID_RESPONSE"
    );
  }

  return {
    status: normalizeStatus(response.status),
    state: "success",
    message: sanitizeProviderMessage(response.msg || ""),
    ref: parsedData.data.ref,
    slipType: parsedData.data.slip_type || slipType,
    slipUrl: parsedData.data.slip_url || null,
    data: parsedData.data.data || null,
  };
}

module.exports = {
  verifyNIN,
  verifyBVN,
  generateNINSlip,
  BabsPayError,
};