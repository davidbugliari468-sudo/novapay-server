const { db, admin } = require("../config/firebase");
const {
  createCustomer,
  getCustomer,
  createDedicatedAccount
} = require("../providers/paystack");

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
          bankName: user.accountBankName || null,
          bankSlug: user.accountBankSlug || null,
          currency: user.accountCurrency || "NGN"
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
     * We keep the Paystack customer code in Firestore.
     * This prevents us from having to create a new
     * Paystack customer every time the account endpoint
     * is called.
     */
    let customerCode =
      user.paystackCustomerCode || null;

    let customer = null;

    if (customerCode) {
      customer = await getCustomer(
        customerCode
      );
    } else {
      /*
       * Try to find the customer by email first.
       *
       * If the customer doesn't exist yet, create one.
       */
      try {
        customer = await getCustomer(email);
      } catch (error) {
        customer = await createCustomer({
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
     * Make sure Paystack has the latest user details.
     */
    if (
      !customer ||
      customer.first_name !== firstName ||
      customer.last_name !== lastName ||
      customer.phone !== phone
    ) {
      const {
        updateCustomer
      } = require("../providers/paystack");

      customer = await updateCustomer(
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
     *
     * We don't choose a bank here. Paystack can assign
     * an available provider unless NovaPay later decides
     * to expose a preferred-bank choice.
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
     * Save the Paystack identity and permanent account
     * on the NovaPay user document.
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
        admin.firestore.FieldValue.serverTimestamp(),

      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
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
      error.message
    );

    return res.status(502).json({
      success: false,
      message:
        "Unable to create your deposit account right now."
    });
  }
}

module.exports = {
  createPermanentAccount
};