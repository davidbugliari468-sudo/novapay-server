"use strict";

// NovaPay backend deployment update
require("dotenv").config();


const {
  startReconciliationWorker
} = require("./data/reconciliation");

const {
  runReconciliationBatch
} = require("./airtime/worker");

const airtimeProviderClient =
  require("./airtime/vtu");

const electricityRoutes =
  require("./electricity/routes");

const notificationRoutes =
  require("./notifications/routes");

const transactionRoutes =
  require("./transactions/routes.js");

const crypto =
  require("crypto");

const express =
  require("express");

const helmet =
  require("helmet");

const cors =
  require("cors");

const rateLimit =
  require("express-rate-limit");

const {
  requireAuth
} = require("./auth");

const {
  db,
  auth: adminAuth
} = require("./firebase-admin");

const {
  getWallet
} = require("./wallet.js/wallet");

const airtimeRoutes =
  require("./airtime/routes");

const addMoneyRoutes =
  require("./add-money/routes");

const dataRoutes =
  require("./data/routes");

const {
  handlePaystackWebhook
} = require("./add-money/paystack/webhook");


const app =
  express();


app.set(
  "trust proxy",
  1
);


const PORT =
  Number(
    process.env.PORT
  ) || 3000;


const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN ||
  false;


// =====================================================
// NOVAPAY BACKEND — SECURITY FOUNDATION
// =====================================================

// Hide Express fingerprint
app.disable(
  "x-powered-by"
);


// Security headers
app.use(
  helmet({
    contentSecurityPolicy:
      false,
  })
);


// Request ID for every request
app.use(
  (req, res, next) => {

    const requestId =
      crypto.randomUUID();

    req.requestId =
      requestId;

    res.setHeader(
      "X-Request-ID",
      requestId
    );

    next();

  }
);


// =====================================================
// JSON BODY LIMIT
// =====================================================
//
// Keep the original request body available for
// Paystack webhook signature verification.
//
// All normal JSON API requests continue to work
// exactly as before.
// =====================================================

app.use(
  express.json({

    limit:
      "100kb",

    verify:
      (req, res, buffer) => {

        if (
          req.originalUrl ===
          "/api/add-money/paystack/webhook"
        ) {

          req.rawBody =
            Buffer.from(
              buffer
            );

        }

      }

  })
);


app.post(
  "/api/add-money/paystack/webhook",
  handlePaystackWebhook
);


// URL-encoded body limit
app.use(
  express.urlencoded({
    extended:
      false,

    limit:
      "100kb",
  })
);


// CORS
app.use(
  cors({

    origin:
      FRONTEND_ORIGIN,

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE"
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-ID"
    ],

  })
);


// =====================================================
// RATE LIMITING
// =====================================================

const apiLimiter =
  rateLimit({

    windowMs:
      15 * 60 * 1000,

    limit:
      100,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    message: {

      success:
        false,

      error:
        "Too many requests. Please try again later.",

    },

  });


app.use(
  "/api",
  apiLimiter
);


// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/health",
  (req, res) => {

    res.status(200).json({

      success:
        true,

      service:
        "NovaPay Backend",

      status:
        "online",

      requestId:
        req.requestId,

    });

  }
);


// =====================================================
// API BASE ROUTE
// =====================================================

app.get(
  "/api",
  (req, res) => {

    res.status(200).json({

      success:
        true,

      service:
        "NovaPay API",

      status:
        "online",

      requestId:
        req.requestId,

    });

  }
);


// =====================================================
// WALLET
// =====================================================
//
// The frontend gets the wallet balance through the
// authenticated backend.
//
// The UID comes from the verified Firebase ID token.
// The frontend never supplies the UID.
// =====================================================

app.get(
  "/api/wallet",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.user.uid;


      const wallet =
        await getWallet(
          uid
        );


      return res.status(200).json({

        success:
          true,

        wallet: {

          balanceKobo:
            wallet.balanceKobo,

          currency:
            wallet.currency ||
            "NGN"

        },

        requestId:
          req.requestId

      });

    }

    catch (error) {

      console.error(
        "NovaPay wallet retrieval error:",
        error
      );


      return res.status(500).json({

        success:
          false,

        error:
          "Unable to retrieve wallet balance.",

        requestId:
          req.requestId

      });

    }

  }
);


// =====================================================
// ADD MONEY
// =====================================================

app.use(
  "/api/add-money",
  addMoneyRoutes
);


app.use(
  "/api/transactions",
  transactionRoutes
);


app.use(
  "/api/notifications",
  notificationRoutes
);


app.use(
  "/api/airtime",
  airtimeRoutes
);


app.use(
  "/api/data",
  dataRoutes.createDataRouter(
    requireAuth
  )
);

app.use(
  "/api/electricity",
  electricityRoutes
);

// =====================================================
// PROTECTED AUTH TEST ROUTE
// =====================================================

app.get(
  "/api/protected",
  requireAuth,
  (req, res) => {

    res.status(200).json({

      success:
        true,

      message:
        "Authenticated",

      user:
        req.user,

      requestId:
        req.requestId,

    });

  }
);


// =====================================================
// REGISTRATION — NIGERIAN PHONE NORMALIZATION
// =====================================================
//
// Canonical format:
//
//     2349164584280
//
// Therefore:
//
//     09164584280
//     2349164584280
//     +2349164584280
//
// all resolve to the same canonical phone.
//
// The registry also checks legacy hashes created by the
// previous implementation so existing registrations
// cannot be bypassed simply by changing the phone format.
// =====================================================

function normalizeRegistrationPhone(
  phone
) {

  const digits =
    String(
      phone || ""
    )
      .replace(
        /\D/g,
        ""
      );


  if (!digits) {

    return null;

  }


  /*
   * Nigerian domestic mobile format:
   *
   * 0XXXXXXXXXX
   *
   * 11 digits total.
   */
  if (
    digits.length ===
      11 &&
    digits.startsWith("0")
  ) {

    return (
      "234" +
      digits.slice(1)
    );

  }


  /*
   * Nigerian international format without
   * the plus sign:
   *
   * 234XXXXXXXXXX
   *
   * 13 digits total.
   */
  if (
    digits.length ===
      13 &&
    digits.startsWith("234")
  ) {

    return digits;

  }


  /*
   * Preserve the existing broad validation behavior
   * for other phone formats instead of unexpectedly
   * breaking unrelated registrations.
   */
  if (
    digits.length >= 7 &&
    digits.length <= 15
  ) {

    return digits;

  }


  return null;

}


// =====================================================
// PHONE REGISTRY KEY
// =====================================================

function createPhoneRegistryKey(
  normalizedPhone
) {

  return crypto
    .createHash(
      "sha256"
    )
    .update(
      normalizedPhone,
      "utf8"
    )
    .digest(
      "hex"
    );

}


// =====================================================
// LEGACY PHONE REPRESENTATIONS
// =====================================================

function getLegacyPhoneRepresentations(
  canonicalPhone
) {

  const representations =
    new Set();


  representations.add(
    canonicalPhone
  );


  if (
    canonicalPhone.length ===
      13 &&
    canonicalPhone.startsWith("234")
  ) {

    const localPhone =
      "0" +
      canonicalPhone.slice(3);


    representations.add(
      localPhone
    );

  }


  return Array.from(
    representations
  );

}


// =====================================================
// REGISTRATION — SECURE PHONE CLAIM
// =====================================================

app.post(
  "/api/registration/claim-phone",
  requireAuth,
  async (req, res) => {

    try {

      const uid =
        req.user.uid;


      const phone =
        String(
          req.body.phone ||
          ""
        ).trim();


      if (!phone) {

        return res.status(400).json({

          success:
            false,

          error:
            "Phone number is required.",

          requestId:
            req.requestId,

        });

      }


      const normalizedPhone =
        normalizeRegistrationPhone(
          phone
        );


      if (!normalizedPhone) {

        return res.status(400).json({

          success:
            false,

          error:
            "Invalid phone number.",

          requestId:
            req.requestId,

        });

      }


      const canonicalPhoneKey =
        createPhoneRegistryKey(
          normalizedPhone
        );


      const canonicalPhoneRef =
        db
          .collection(
            "phoneRegistry"
          )
          .doc(
            canonicalPhoneKey
          );


      const legacyRepresentations =
        getLegacyPhoneRepresentations(
          normalizedPhone
        );


      const legacyPhoneRefs =
        legacyRepresentations
          .map(
            (legacyPhone) => {

              const key =
                createPhoneRegistryKey(
                  legacyPhone
                );


              return {

                phone:
                  legacyPhone,

                ref:
                  db
                    .collection(
                      "phoneRegistry"
                    )
                    .doc(
                      key
                    )

              };

            }
          );


      const userRef =
        db
          .collection(
            "users"
          )
          .doc(
            uid
          );


      await db.runTransaction(
        async (transaction) => {

          const canonicalSnapshot =
            await transaction.get(
              canonicalPhoneRef
            );


          const legacySnapshots =
            [];


          for (
            const item
            of legacyPhoneRefs
          ) {

            if (
              item.ref.path ===
              canonicalPhoneRef.path
            ) {

              continue;

            }


            const snapshot =
              await transaction.get(
                item.ref
              );


            legacySnapshots.push({

              phone:
                item.phone,

              ref:
                item.ref,

              snapshot

            });

          }


          /*
           * Check canonical ownership.
           */
          if (
            canonicalSnapshot.exists
          ) {

            const data =
              canonicalSnapshot.data() ||
              {};

            const existingUid =
              String(
                data.uid ||
                ""
              ).trim();


            if (
              existingUid &&
              existingUid !== uid
            ) {

              const error =
                new Error(
                  "PHONE_ALREADY_REGISTERED"
                );

              error.code =
                "PHONE_ALREADY_REGISTERED";

              throw error;

            }

          }


          /*
           * Check legacy ownership.
           */
          for (
            const item
            of legacySnapshots
          ) {

            if (
              !item.snapshot.exists
            ) {

              continue;

            }


            const data =
              item.snapshot.data() ||
              {};

            const existingUid =
              String(
                data.uid ||
                ""
              ).trim();


            if (
              existingUid &&
              existingUid !== uid
            ) {

              const error =
                new Error(
                  "PHONE_ALREADY_REGISTERED"
                );

              error.code =
                "PHONE_ALREADY_REGISTERED";

              throw error;

            }

          }


          /*
           * Existing canonical record belongs to
           * this same user.
           */
          if (
            canonicalSnapshot.exists
          ) {

            transaction.set(
              userRef,
              {

                phone:
                  normalizedPhone,

                phoneVerified:
                  false,

                updatedAt:
                  new Date(),

              },
              {
                merge:
                  true
              }
            );


            return;

          }


          /*
           * Create canonical registry record.
           */
          transaction.create(
            canonicalPhoneRef,
            {

              uid,

              phone:
                normalizedPhone,

              createdAt:
                new Date(),

            }
          );


          /*
           * Save canonical phone to user profile.
           */
          transaction.set(
            userRef,
            {

              phone:
                normalizedPhone,

              phoneVerified:
                false,

              updatedAt:
                new Date(),

            },
            {
              merge:
                true
            }
          );

        }
      );


      return res.status(200).json({

        success:
          true,

        message:
          "Phone number registered successfully.",

        requestId:
          req.requestId,

      });

    }

    catch (error) {

      if (
        error.code ===
        "PHONE_ALREADY_REGISTERED"
      ) {

        try {

          await adminAuth.deleteUser(
            req.user.uid
          );

        }

        catch (deleteError) {

          console.error(
            "Failed to remove duplicate registration:",
            deleteError
          );

        }


        return res.status(409).json({

          success:
            false,

          error:
            "This phone number is already registered.",

          requestId:
            req.requestId,

        });

      }


      console.error(
        "Phone registration error:",
        error
      );


      return res.status(500).json({

        success:
          false,

        error:
          "Unable to complete registration.",

        requestId:
          req.requestId,

      });

    }

  }
);


// =====================================================
// 404 HANDLER
// =====================================================

app.use(
  (req, res) => {

    res.status(404).json({

      success:
        false,

      error:
        "Route not found",

      requestId:
        req.requestId,

    });

  }
);


// =====================================================
// CENTRAL ERROR HANDLER
// =====================================================

app.use(
  (err, req, res, next) => {

    console.error(
      "Backend error:",
      err
    );


    if (
      res.headersSent
    ) {

      return next(
        err
      );

    }


    res.status(500).json({

      success:
        false,

      error:
        "Internal server error",

      requestId:
        req.requestId,

    });

  }
);


// =====================================================
// SERVER START
// =====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `NovaPay backend running on port ${PORT}`
    );


    // =================================================
    // DATA RECONCILIATION WORKER
    // =================================================

    startReconciliationWorker();


    // =================================================
    // AIRTIME RECONCILIATION WORKER
    // =================================================
    //
    // Airtime worker uses the existing:
    //
    //     airtime/worker.js
    //     airtime/reconciliation.js
    //     airtime/vtu.js
    //     wallet/reservation.js
    //
    // It never directly changes wallet balances.
    //
    // =================================================

    const airtimeIntervalMs =
      Number(
        process.env.AIRTIME_RECONCILIATION_INTERVAL_MS
      ) || 60000;


    const airtimeBatchSize =
      Number(
        process.env.AIRTIME_RECONCILIATION_BATCH_SIZE
      ) || 25;


    let airtimeReconciliationRunning =
      false;


    const runAirtimeReconciliation =
      async () => {

        if (
          airtimeReconciliationRunning
        ) {

          console.log(
            "Airtime reconciliation already running; skipping overlapping run."
          );

          return;

        }


        airtimeReconciliationRunning =
          true;


        try {

          const result =
            await runReconciliationBatch({

              providerClient:
                airtimeProviderClient,

              limit:
                airtimeBatchSize

            });


          if (
            result.scanned > 0
          ) {

            console.log(
              "Airtime reconciliation completed:",
              {

                scanned:
                  result.scanned,

                processed:
                  result.processed,

                failed:
                  result.failed

              }
            );

          }

        }

        catch (error) {

          console.error(
            "Airtime reconciliation worker error:",
            error
          );

        }

        finally {

          airtimeReconciliationRunning =
            false;

        }

      };


    console.log(
      "Airtime reconciliation worker started:",
      {

        intervalMs:
          airtimeIntervalMs,

        batchSize:
          airtimeBatchSize

      }
    );


    /*
     * Run once shortly after startup.
     *
     * This means existing pending transactions don't
     * necessarily have to wait for the first full interval.
     */
    setTimeout(
      () => {
        runAirtimeReconciliation();
      },
      5000
    );


    /*
     * Continue checking pending/unknown Airtime
     * transactions automatically.
     */
    setInterval(
      () => {

        runAirtimeReconciliation();

      },
      airtimeIntervalMs
    );

  }
);