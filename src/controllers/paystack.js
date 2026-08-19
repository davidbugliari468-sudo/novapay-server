const axios = require("axios");

const PAYSTACK_BASE_URL =
  process.env.PAYSTACK_BASE_URL ||
  "https://api.paystack.co";


/**
 * Create authenticated Paystack API client.
 */
function getPaystackClient() {
  const secretKey =
    process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not configured"
    );
  }

  return axios.create({
    baseURL: PAYSTACK_BASE_URL,
    timeout: 15000,
    headers: {
      Authorization:
        `Bearer ${secretKey}`,

      "Content-Type":
        "application/json"
    }
  });
}


/**
 * Create a Paystack customer.
 */
async function createCustomer({
  email,
  firstName,
  lastName,
  phone,
  metadata = {}
}) {
  if (!email) {
    throw new Error(
      "PAYSTACK_CUSTOMER_EMAIL_REQUIRED"
    );
  }

  if (
    !firstName ||
    !lastName ||
    !phone
  ) {
    throw new Error(
      "PAYSTACK_CUSTOMER_DETAILS_REQUIRED"
    );
  }

  try {
    const client =
      getPaystackClient();

    const response =
      await client.post(
        "/customer",
        {
          email,
          first_name: firstName,
          last_name: lastName,
          phone,
          metadata
        }
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_CUSTOMER_CREATION_FAILED"
      );
    }

    return response.data.data;

  } catch (error) {

    console.error(
      "Paystack customer creation error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      error.response?.data?.message ||
      "PAYSTACK_CUSTOMER_CREATION_FAILED"
    );
  }
}


/**
 * Fetch an existing Paystack customer.
 *
 * identifier can be:
 * - customer code
 * - email
 */
async function getCustomer(identifier) {

  if (!identifier) {
    throw new Error(
      "PAYSTACK_CUSTOMER_IDENTIFIER_REQUIRED"
    );
  }

  try {

    const client =
      getPaystackClient();

    const response =
      await client.get(
        `/customer/${encodeURIComponent(identifier)}`
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_CUSTOMER_FETCH_FAILED"
      );
    }

    return response.data.data;

  } catch (error) {

    console.error(
      "Paystack customer fetch error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      error.response?.data?.message ||
      "PAYSTACK_CUSTOMER_FETCH_FAILED"
    );
  }
}


/**
 * Update an existing Paystack customer.
 */
async function updateCustomer(
  customerCode,
  {
    firstName,
    lastName,
    phone,
    metadata
  } = {}
) {

  if (!customerCode) {
    throw new Error(
      "PAYSTACK_CUSTOMER_CODE_REQUIRED"
    );
  }

  try {

    const client =
      getPaystackClient();

    const payload = {};

    if (firstName !== undefined) {
      payload.first_name =
        firstName;
    }

    if (lastName !== undefined) {
      payload.last_name =
        lastName;
    }

    if (phone !== undefined) {
      payload.phone =
        phone;
    }

    if (metadata !== undefined) {
      payload.metadata =
        metadata;
    }

    const response =
      await client.put(
        `/customer/${encodeURIComponent(customerCode)}`,
        payload
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_CUSTOMER_UPDATE_FAILED"
      );
    }

    return response.data.data;

  } catch (error) {

    console.error(
      "Paystack customer update error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      error.response?.data?.message ||
      "PAYSTACK_CUSTOMER_UPDATE_FAILED"
    );
  }
}


/**
 * Create a Dedicated Virtual Account.
 *
 * customer can be a Paystack
 * customer code or ID.
 */
async function createDedicatedAccount({
  customer,
  preferredBank,
  firstName,
  lastName,
  phone
}) {

  if (!customer) {
    throw new Error(
      "PAYSTACK_CUSTOMER_REQUIRED_FOR_DVA"
    );
  }

  try {

    const client =
      getPaystackClient();

    const payload = {
      customer
    };

    if (preferredBank) {
      payload.preferred_bank =
        preferredBank;
    }

    if (firstName) {
      payload.first_name =
        firstName;
    }

    if (lastName) {
      payload.last_name =
        lastName;
    }

    if (phone) {
      payload.phone =
        phone;
    }

    const response =
      await client.post(
        "/dedicated_account",
        payload
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_DVA_CREATION_FAILED"
      );
    }

    return response.data.data;

  } catch (error) {

    console.error(
      "Paystack dedicated account error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      response?.data?.message ||
      "PAYSTACK_DVA_CREATION_FAILED"
    );
  }
}


/**
 * Fetch a Dedicated Virtual Account
 * by its Paystack ID.
 */
async function getDedicatedAccount(
  dedicatedAccountId
) {

  if (!dedicatedAccountId) {
    throw new Error(
      "PAYSTACK_DEDICATED_ACCOUNT_ID_REQUIRED"
    );
  }

  try {

    const client =
      getPaystackClient();

    const response =
      await client.get(
        `/dedicated_account/${dedicatedAccountId}`
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_DVA_FETCH_FAILED"
      );
    }

    return response.data.data;

  } catch (error) {

    console.error(
      "Paystack DVA fetch error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      error.response?.data?.message ||
      "PAYSTACK_DVA_FETCH_FAILED"
    );
  }
}


/**
 * List Dedicated Virtual Accounts.
 */
async function listDedicatedAccounts({
  customer,
  active,
  currency = "NGN"
} = {}) {

  try {

    const client =
      getPaystackClient();

    const params = {};

    if (customer) {
      params.customer =
        customer;
    }

    if (active !== undefined) {
      params.active =
        active;
    }

    if (currency) {
      params.currency =
        currency;
    }

    const response =
      await client.get(
        "/dedicated_account",
        { params }
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_DVA_LIST_FAILED"
      );
    }

    return response.data.data || [];

  } catch (error) {

    console.error(
      "Paystack DVA list error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      response?.data?.message ||
      "PAYSTACK_DVA_LIST_FAILED"
    );
  }
}


/**
 * Get banks currently available
 * for Dedicated Virtual Accounts.
 */
async function getDedicatedAccountProviders() {

  try {

    const client =
      getPaystackClient();

    const response =
      await client.get(
        "/dedicated_account/available_providers"
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_DVA_PROVIDERS_FAILED"
      );
    }

    return response.data.data || [];

  } catch (error) {

    console.error(
      "Paystack DVA providers error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      error.response?.data?.message ||
      "PAYSTACK_DVA_PROVIDERS_FAILED"
    );
  }
}


/**
 * Initialize a Paystack checkout transaction.
 *
 * Amount is supplied in Naira by NovaPay
 * and converted to kobo before sending
 * to Paystack.
 */
async function initializeTransaction({
  email,
  amount,
  reference,
  channels = [
    "card",
    "bank_transfer",
    "ussd"
  ],
  metadata = {}
}) {

  if (!email) {
    throw new Error(
      "PAYSTACK_TRANSACTION_EMAIL_REQUIRED"
    );
  }

  const numericAmount =
    Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 100
  ) {
    throw new Error(
      "PAYSTACK_TRANSACTION_AMOUNT_INVALID"
    );
  }

  try {

    const client =
      getPaystackClient();

    const amountInKobo =
      Math.round(
        numericAmount * 100
      );

    const payload = {
      email,

      amount:
        String(amountInKobo),

      currency:
        "NGN",

      channels,

      metadata
    };

    if (reference) {
      payload.reference =
        reference;
    }

    const response =
      await client.post(
        "/transaction/initialize",
        payload
      );

    if (
      !response.data?.status ||
      !response.data?.data
    ) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_TRANSACTION_INITIALIZATION_FAILED"
      );
    }

    return response.data.data;

  } catch (error) {

    console.error(
      "Paystack transaction initialization error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      error.response?.data?.message ||
      "PAYSTACK_TRANSACTION_INITIALIZATION_FAILED"
    );
  }
}


/**
 * Verify a Paystack transaction.
 */
async function verifyTransaction(
  reference
) {

  if (!reference) {
    throw new Error(
      "PAYSTACK_TRANSACTION_REFERENCE_REQUIRED"
    );
  }

  try {

    const client =
      getPaystackClient();

    const response =
      await client.get(
        `/transaction/verify/${encodeURIComponent(reference)}`
      );

    if (!response.data?.status) {
      throw new Error(
        response.data?.message ||
        "PAYSTACK_TRANSACTION_VERIFICATION_FAILED"
      );
    }

    return response.data.data;

  } catch (error) {

    console.error(
      "Paystack transaction verification error:",
      error.response?.data?.message ||
      error.message
    );

    throw new Error(
      error.response?.data?.message ||
      "PAYSTACK_TRANSACTION_VERIFICATION_FAILED"
    );
  }
}


/**
 * Export Paystack provider functions.
 */
module.exports = {
  createCustomer,
  getCustomer,
  updateCustomer,
  createDedicatedAccount,
  getDedicatedAccount,
  listDedicatedAccounts,
  getDedicatedAccountProviders,
  initializeTransaction,
  verifyTransaction
};