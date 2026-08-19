const { db, admin } = require("../config/firebase");

const {
  createCustomer,
  getCustomer,
  updateCustomer,
  createDedicatedAccount
} = require("../providers/paystack");

const axios = require("axios");


/**
 * Create or return the user's permanent Paystack
 * Dedicated Virtual Account.
 *
 * The authenticated Firebase UID is always taken from
 * req.uid. We never accept a UID from the frontend.
 */
async function createPermanentAccount(req, res) {
  try {
    const uid = req.uid;

    if (!uid) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const userRef = db
      .collection("users")
      .doc(uid);

    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User account not found."
      });
    }

    const user = userDoc.data();

    /*
     * If NovaPay already has a permanent account
     * stored for this user, return it instead of
     * creating another account.
     */
    if (
      user.accountNumber &&
      user.accountName
    ) {
      return res.json({
        success: true,
        existing: true,
        account: {
          accountNumber: user.accountNumber,
          accountName: user.accountName,
          bankName:
            user.accountBankName || null,
          bankSlug:
            user.accountBankSlug || null,
          currency:
            user.accountCurrency || "NGN"
        }
      });
    }

    const email =
      String(user.email || "")
        .trim()
        .toLowerCase();

    const firstName =
      String(user.firstName || "")
        .trim();

    const lastName =
      String(
        user.surname ||
        user.lastName ||
        ""
      ).trim();

    const phone =
      String(user.phone || "")
        .trim();

    if (
      !email ||
      !firstName ||
      !lastName ||
      !phone
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Complete your name, email and phone number before creating your deposit account."
      });
    }

    /*
     * Prepare Paystack customer.
     */
    let customerCode =
      user.paystackCustomerCode || null;

    let customer = null;

    if (customerCode) {
      customer =
        await getCustomer(customerCode);
    } else {
      try {
        customer =
          await getCustomer(email);
      } catch (error) {
        customer =
          await createCustomer({
            email,
            firstName,
            lastName,
            phone,
            metadata: {
              novapayUid: uid
            }
          });
      }

      customerCode =
        customer.customer_code;
    }

    if (!customerCode) {
      return res.status(502).json({
        success: false,
        message:
          "Paystack customer could not be prepared."
      });
    }

    /*
     * Keep Paystack customer details up to date.
     */
    if (
      !customer ||
      customer.first_name !== firstName ||
      customer.last_name !== lastName ||
      customer.phone !== phone
    ) {
      customer =
        await updateCustomer(
          customerCode,
          {
            firstName,
            lastName,
            phone,
            metadata: {
              novapayUid: uid
            }
          }
        );
    }

    /*
     * Create the permanent NGN deposit account.
     */
    const dedicatedAccount =
      await createDedicatedAccount({
        customer: customerCode,
        firstName,
        lastName,
        phone
      });

    const accountNumber =
      dedicatedAccount.account_number;

    const accountName =
      dedicatedAccount.account_name;

    if (
      !accountNumber ||
      !accountName
    ) {
      return res.status(502).json({
        success: false,
        message:
          "Paystack did not return a valid deposit account."
      });
    }

    const bankName =
      dedicatedAccount.bank?.name ||
      null;

    const bankSlug =
      dedicatedAccount.bank?.slug ||
      null;

    /*
     * Save the Paystack identity and
     * permanent account on the user.
     */
    await userRef.update({
      paystackCustomerCode:
        customerCode,

      paystackCustomerId:
        customer?.id ||
        dedicatedAccount.customer?.id ||
        null,

      accountNumber,

      accountName,

      accountBankName:
        bankName,

      accountBankSlug:
        bankSlug,

      accountCurrency:
        dedicatedAccount.currency ||
        "NGN",

      accountProvider:
        "paystack",

      accountStatus:
        dedicatedAccount.active === false
          ? "inactive"
          : "active",

      accountCreatedAt:
        admin.firestore.FieldValue
          .serverTimestamp(),

      updatedAt:
        admin.firestore.FieldValue
          .serverTimestamp()
    });

    return res.status(201).json({
      success: true,
      existing: false,
      account: {
        accountNumber,
        accountName,
        bankName,
        bankSlug,
        currency:
          dedicatedAccount.currency ||
          "NGN"
      }
    });

  } catch (error) {

    console.error(
      "Create Paystack permanent account error:",
      error.response?.data ||
      error.message
    );

    return res.status(502).json({
      success: false,
      message:
        "Unable to create your deposit account right now."
    });
  }
}


/**
 * Initialize a Paystack checkout transaction.
 *
 * This is used by NovaPay Add Money.
 *
 * IMPORTANT:
 * The Paystack secret key stays on the backend.
 */
async function initializePayment(req, res) {
  try {

    const uid = req.uid;

    if (!uid) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const userRef =
      db.collection("users").doc(uid);

    const userDoc =
      await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "User account not found."
      });
    }

    const user =
      userDoc.data();

    const email =
      String(user.email || "")
        .trim()
        .toLowerCase();

    if (!email) {
      return res.status(400).json({
        success: false,
        message:
          "Your NovaPay account does not have a valid email address."
      });
    }

    const amount =
      Number(req.body?.amount);

    if (
      !Number.isFinite(amount) ||
      amount < 100
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Minimum deposit amount is ₦100."
      });
    }

    if (amount > 10000000) {
      return res.status(400).json({
        success: false,
        message:
          "Deposit amount is too large."
      });
    }

    /*
     * Paystack expects NGN amounts in kobo.
     *
     * Example:
     * ₦100 = 10000 kobo
     */
    const amountInKobo =
      Math.round(amount * 100);

    /*
     * Paystack references may contain only
     * alphanumeric characters plus -, . and =.
     */
    const reference =
      `NVP-${uid}-${Date.now()}`;

    const secretKey =
      process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
      console.error(
        "PAYSTACK_SECRET_KEY is not configured."
      );

      return res.status(500).json({
        success: false,
        message:
          "Paystack is not configured on the server."
      });
    }

    /*
     * Initialize the Paystack transaction.
     *
     * The secret key is NEVER sent to the frontend.
     */
    const response =
      await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email,

          amount:
            String(amountInKobo),

          currency:
            "NGN",

          reference,

          /*
           * Give the customer the payment methods
           * available to this checkout.
           */
          channels: [
            "card",
            "bank_transfer",
            "ussd"
          ],

          metadata:
            JSON.stringify({
              novapayUid: uid,
              amountNaira: amount,
              purpose: "wallet_funding"
            })
        },
        {
          headers: {
            Authorization:
              `Bearer ${secretKey}`,

            "Content-Type":
              "application/json"
          },

          timeout: 15000
        }
      );

    if (
      !response.data?.status ||
      !response.data?.data?.authorization_url
    ) {
      console.error(
        "Paystack initialization failed:",
        response.data
      );

      return res.status(502).json({
        success: false,
        message:
          response.data?.message ||
          "Paystack could not initialize the payment."
      });
    }

    const payment =
      response.data.data;

    /*
     * Store the pending deposit.
     *
     * We do NOT add money to the wallet here.
     * Wallet credit must happen only after
     * Paystack confirms the payment.
     */
    await db
      .collection("users")
      .doc(uid)
      .collection("deposits")
      .doc(reference)
      .set({
        reference,

        amount,

        amountInKobo,

        currency: "NGN",

        provider: "paystack",

        status: "pending",

        purpose: "wallet_funding",

        createdAt:
          admin.firestore.FieldValue
            .serverTimestamp(),

        updatedAt:
          admin.firestore.FieldValue
            .serverTimestamp()
      });

    return res.json({
      success: true,

      authorizationUrl:
        payment.authorization_url,

      accessCode:
        payment.access_code,

      reference:
        payment.reference
    });

  } catch (error) {

    console.error(
      "Paystack payment initialization error:",
      error.response?.data ||
      error.message
    );

    return res.status(502).json({
      success: false,
      message:
        error.response?.data?.message ||
        "Unable to start Paystack payment."
    });
  }
}


module.exports = {
  createPermanentAccount,
  initializePayment
};