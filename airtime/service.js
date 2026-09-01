// airtime/service.js

const crypto = require("crypto");

const { db } = require("../firebase-admin");
const reservation = require("../wallet/reservation");


// =====================================================
// NOVAPAY — AIRTIME SERVICE
// =====================================================
//
// RESPONSIBILITIES
//
// 1. Validate Airtime request.
// 2. Create an idempotent transaction.
// 3. Reserve wallet funds.
// 4. Call the provider adapter.
// 5. Commit funds ONLY after confirmed success.
// 6. Release funds ONLY after confirmed failure.
// 7. Keep uncertain provider results pending.
// 8. Maintain an auditable transaction record.
// 9. Support secure reconciliation.
//
// IMPORTANT
//
// The provider implementation is injected through
// providerClient.
//
// This service NEVER contains VTU.ng-specific API logic.
// =====================================================


// =====================================================
// COLLECTION
// =====================================================

const AIRTIME_TRANSACTIONS_COLLECTION =
    "airtimeTransactions";


// =====================================================
// CONSTANTS
// =====================================================

const CURRENCY =
    "NGN";

const SERVICE_TYPE =
    "airtime";

const STATUS_PENDING =
    "pending";

const STATUS_SUCCESSFUL =
    "successful";

const STATUS_FAILED =
    "failed";

const PROVIDER_SUCCESS =
    "success";

const PROVIDER_FAILURE =
    "failure";

const PROVIDER_UNKNOWN =
    "unknown";


// =====================================================
// REWARD CONFIGURATION
// =====================================================

const configuredPointsPerNaira =
    Number(
        process.env.AIRTIME_POINTS_PER_NAIRA
    );

const POINTS_PER_NAIRA =
    Number.isSafeInteger(
        configuredPointsPerNaira
    ) &&
    configuredPointsPerNaira > 0
        ? configuredPointsPerNaira
        : 0;


// =====================================================
// VALIDATION
// =====================================================

function requireUid(uid) {

    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {

        throw new Error(
            "Authenticated user ID is required."
        );

    }

    return uid.trim();

}


// =====================================================
// AMOUNT
// =====================================================

function validateAmountKobo(
    amountKobo
) {

    const amount =
        Number(
            amountKobo
        );


    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0
    ) {

        throw new Error(
            "Airtime amount must be a positive integer in kobo."
        );

    }


    return amount;

}


// =====================================================
// PHONE
// =====================================================

function normalizePhoneNumber(
    phoneNumber
) {

    let phone =
        String(
            phoneNumber || ""
        )
            .trim()
            .replace(
                /[\s\-()]/g,
                ""
            );


    if (!phone) {

        throw new Error(
            "Airtime phone number is required."
        );

    }


    if (
        phone.startsWith("+234")
    ) {

        phone =
            "0" +
            phone.slice(4);

    }


    if (
        phone.startsWith("234") &&
        phone.length === 13
    ) {

        phone =
            "0" +
            phone.slice(3);

    }


    if (
        !/^0[789][01]\d{8}$/.test(
            phone
        )
    ) {

        throw new Error(
            "Enter a valid Nigerian Airtime phone number."
        );

    }


    return phone;

}


// =====================================================
// NETWORK
// =====================================================

function normalizeNetwork(
    network
) {

    const value =
        String(
            network || ""
        )
            .trim()
            .toLowerCase();


    const aliases = {

        "etisalat":
            "9mobile",

        "9mobile-ng":
            "9mobile",

        "mtn-ng":
            "mtn",

        "glo-ng":
            "glo",

        "airtel-ng":
            "airtel"

    };


    const normalized =
        aliases[value] ||
        value;


    if (
        ![
            "mtn",
            "glo",
            "airtel",
            "9mobile"
        ].includes(
            normalized
        )
    ) {

        throw new Error(
            "Unsupported Airtime network."
        );

    }


    return normalized;

}


// =====================================================
// TRANSACTION ID
// =====================================================

function createTransactionId() {

    return (
        "NPAIR_" +
        Date.now() +
        "_" +
        crypto
            .randomBytes(12)
            .toString("hex")
    );

}


// =====================================================
// PROVIDER REFERENCE
// =====================================================

function normalizeProviderReference(
    value
) {

    if (
        value === undefined ||
        value === null
    ) {

        return null;

    }


    const reference =
        String(
            value
        )
            .trim();


    if (!reference) {

        return null;

    }


    return reference.slice(
        0,
        200
    );

}


// =====================================================
// PROVIDER RESULT
// =====================================================
//
// Only normalized provider outcomes may control
// reservation state.
//
// success
// failure
// unknown
// =====================================================

function normalizeProviderResult(
    result
) {

    if (
        !result ||
        typeof result !== "object"
    ) {

        return {

            outcome:
                PROVIDER_UNKNOWN,

            providerReference:
                null,

            providerCostKobo:
                null,

            message:
                "Provider response could not be verified."

        };

    }


    const rawOutcome =
        String(
            result.outcome || ""
        )
            .trim()
            .toLowerCase();


    const outcome =
        [
            PROVIDER_SUCCESS,
            PROVIDER_FAILURE,
            PROVIDER_UNKNOWN
        ].includes(
            rawOutcome
        )
            ? rawOutcome
            : PROVIDER_UNKNOWN;


    let providerCostKobo =
        null;


    if (
        result.providerCostKobo !==
            undefined &&
        result.providerCostKobo !==
            null
    ) {

        const cost =
            Number(
                result.providerCostKobo
            );


        if (
            Number.isSafeInteger(cost) &&
            cost >= 0
        ) {

            providerCostKobo =
                cost;

        }

    }


    return {

        outcome,

        providerReference:
            normalizeProviderReference(
                result.providerReference
            ),

        providerCostKobo,

        message:
            String(
                result.message || ""
            )
                .trim()
                .slice(0, 500) ||
            null

    };

}


// =====================================================
// GAIN
// =====================================================

function calculateGainKobo({
    amountKobo,
    providerCostKobo
}) {

    const amount =
        validateAmountKobo(
            amountKobo
        );


    if (
        !Number.isSafeInteger(
            providerCostKobo
        ) ||
        providerCostKobo < 0
    ) {

        return null;

    }


    const gain =
        amount -
        providerCostKobo;


    if (
        !Number.isSafeInteger(
            gain
        )
    ) {

        throw new Error(
            "Unable to calculate Airtime gain."
        );

    }


    return gain;

}


// =====================================================
// REWARD POINTS
// =====================================================

function calculateRewardPoints(
    amountKobo
) {

    const amount =
        validateAmountKobo(
            amountKobo
        );


    if (
        POINTS_PER_NAIRA <= 0
    ) {

        return 0;

    }


    const amountNaira =
        Math.floor(
            amount / 100
        );


    const points =
        amountNaira *
        POINTS_PER_NAIRA;


    if (
        !Number.isSafeInteger(
            points
        )
    ) {

        throw new Error(
            "Calculated reward points exceed supported limits."
        );

    }


    return points;

}


// =====================================================
// CREATE PENDING TRANSACTION
// =====================================================

async function createPendingTransaction({
    uid,
    transactionId,
    network,
    phoneNumber,
    amountKobo
}) {

    const transactionRef =
        db
            .collection(
                AIRTIME_TRANSACTIONS_COLLECTION
            )
            .doc(
                transactionId
            );


    const now =
        new Date();


    const transactionData = {

        id:
            transactionId,

        uid:
            requireUid(uid),

        service:
            SERVICE_TYPE,

        network,

        phoneNumber,

        amountKobo,

        currency:
            CURRENCY,

        status:
            STATUS_PENDING,

        provider:
            "vtu.ng",

        providerReference:
            null,

        providerCostKobo:
            null,

        gainKobo:
            null,

        rewardPoints:
            0,

        reservationId:
            null,

        providerOutcome:
            null,

        reconciliationRequired:
            false,

        createdAt:
            now,

        updatedAt:
            now

    };


    await transactionRef.create(
        transactionData
    );


    return transactionData;

}


// =====================================================
// UPDATE TRANSACTION
// =====================================================

async function updateTransaction(
    transactionId,
    updates
) {

    if (
        typeof transactionId !==
            "string" ||
        !transactionId.trim()
    ) {

        throw new Error(
            "Transaction ID is required."
        );

    }


    if (
        !updates ||
        typeof updates !== "object"
    ) {

        throw new Error(
            "Transaction updates are required."
        );

    }


    const transactionRef =
        db
            .collection(
                AIRTIME_TRANSACTIONS_COLLECTION
            )
            .doc(
                transactionId
            );


    await transactionRef.update({

        ...updates,

        updatedAt:
            new Date()

    });

}


// =====================================================
// GET TRANSACTION
// =====================================================

async function getAirtimeTransaction(
    transactionId
) {

    const id =
        String(
            transactionId || ""
        )
            .trim();


    if (!id) {

        throw new Error(
            "Airtime transaction ID is required."
        );

    }


    const snapshot =
        await db
            .collection(
                AIRTIME_TRANSACTIONS_COLLECTION
            )
            .doc(id)
            .get();


    if (
        !snapshot.exists
    ) {

        return null;

    }


    return {

        id:
            snapshot.id,

        ...snapshot.data()

    };

}


// =====================================================
// RESERVATION HELPERS
// =====================================================

function ensureReservationModule() {

    if (
        !reservation ||
        typeof reservation !==
            "object"
    ) {

        throw new Error(
            "Wallet reservation module is unavailable."
        );

    }

}


// =====================================================
// RESERVE FUNDS
// =====================================================

async function reserveUserFunds({
    uid,
    amountKobo,
    transactionId
}) {

    ensureReservationModule();


    if (
        typeof reservation.reserveFunds !==
        "function"
    ) {

        throw new Error(
            "Wallet reservation service is not configured."
        );

    }


    const result =
        await reservation.reserveFunds({

            uid:
                requireUid(uid),

            reference:
                transactionId,

            amountKobo:
                validateAmountKobo(
                    amountKobo
                ),

            currency:
                CURRENCY,

            service:
                SERVICE_TYPE,

            metadata: {

                transactionId,

                source:
                    "airtime"

            }

        });


    if (
        !result ||
        !result.reservationId
    ) {

        throw new Error(
            "Unable to reserve wallet funds."
        );

    }


    return result;

}


// =====================================================
// COMMIT FUNDS
// =====================================================

async function commitReservedFunds({
    uid,
    reservationId,
    transactionId
}) {

    ensureReservationModule();


    if (
        typeof reservation.commitReservation !==
        "function"
    ) {

        throw new Error(
            "Wallet reservation commit service is not configured."
        );

    }


    const result =
        await reservation.commitReservation({

            uid:
                requireUid(uid),

            reservationId,

            provider:
                "vtu.ng"

        });


    if (
        !result ||
        result.committed !== true
    ) {

        throw new Error(
            "Unable to commit reserved wallet funds."
        );

    }


    return result;

}


// =====================================================
// RELEASE FUNDS
// =====================================================

async function releaseReservedFunds({
    uid,
    reservationId,
    reason
}) {

    ensureReservationModule();


    if (
        typeof reservation.releaseReservation !==
        "function"
    ) {

        throw new Error(
            "Wallet reservation release service is not configured."
        );

    }


    const result =
        await reservation.releaseReservation({

            uid:
                requireUid(uid),

            reservationId,

            reason:
                reason ||
                "airtime_provider_failure"

        });


    if (
        !result ||
        result.released !== true
    ) {

        throw new Error(
            "Unable to release reserved wallet funds."
        );

    }


    return result;

}


// =====================================================
// EXECUTE AIRTIME PURCHASE
// =====================================================

async function purchaseAirtime({
    uid,
    network,
    phoneNumber,
    amountKobo,
    providerClient
}) {

    const authenticatedUid =
        requireUid(
            uid
        );


    const normalizedNetwork =
        normalizeNetwork(
            network
        );


    const normalizedPhone =
        normalizePhoneNumber(
            phoneNumber
        );


    const validatedAmount =
        validateAmountKobo(
            amountKobo
        );


    if (
        !providerClient ||
        typeof providerClient.purchaseAirtime !==
            "function"
    ) {

        throw new Error(
            "Airtime provider is not configured."
        );

    }


    const transactionId =
        createTransactionId();


    // -------------------------------------------------
    // CREATE AUDIT RECORD FIRST
    // -------------------------------------------------

    await createPendingTransaction({

        uid:
            authenticatedUid,

        transactionId,

        network:
            normalizedNetwork,

        phoneNumber:
            normalizedPhone,

        amountKobo:
            validatedAmount

    });


    // -------------------------------------------------
    // RESERVE WALLET FUNDS
    // -------------------------------------------------

    let reservationResult;


    try {

        reservationResult =
            await reserveUserFunds({

                uid:
                    authenticatedUid,

                amountKobo:
                    validatedAmount,

                transactionId

            });

    }

    catch (error) {

        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_FAILED,

                failureReason:
                    "wallet_reservation_failed",

                reconciliationRequired:
                    false

            }
        );


        throw error;

    }


    const reservationId =
        reservationResult.reservationId;


    await updateTransaction(
        transactionId,
        {

            reservationId

        }
    );


    // -------------------------------------------------
    // PROVIDER CALL
    // -------------------------------------------------

    let providerResponse;


    try {

        providerResponse =
            await providerClient.purchaseAirtime({

                transactionId,

                network:
                    normalizedNetwork,

                phoneNumber:
                    normalizedPhone,

                amountKobo:
                    validatedAmount,

                amountNaira:
                    validatedAmount /
                    100

            });

    }

    catch (error) {

        /*
         * A transport error does not prove failure.
         *
         * The reservation remains pending.
         */

        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_PENDING,

                providerOutcome:
                    PROVIDER_UNKNOWN,

                reconciliationRequired:
                    true,

                lastProviderError:
                    String(
                        error?.message ||
                        "Provider request could not be verified."
                    )
                        .slice(0, 500)

            }
        );


        return {

            success:
                false,

            pending:
                true,

            transactionId,

            status:
                STATUS_PENDING,

            message:
                "Your Airtime request is being processed. Please do not retry yet."

        };

    }


    const providerResult =
        normalizeProviderResult(
            providerResponse
        );


    // =================================================
    // CONFIRMED SUCCESS
    // =================================================

    if (
        providerResult.outcome ===
        PROVIDER_SUCCESS
    ) {

        /*
         * We require a provider reference before
         * considering the result safely identifiable.
         */

        if (
            !providerResult.providerReference
        ) {

            await updateTransaction(
                transactionId,
                {

                    status:
                        STATUS_PENDING,

                    providerOutcome:
                        PROVIDER_UNKNOWN,

                    reconciliationRequired:
                        true,

                    providerResponseWarning:
                        "Provider reported success without a provider reference."

                }
            );


            return {

                success:
                    false,

                pending:
                    true,

                transactionId,

                status:
                    STATUS_PENDING,

                message:
                    "Your Airtime request is being verified. Please do not retry yet."

            };

        }


        const gainKobo =
            calculateGainKobo({

                amountKobo:
                    validatedAmount,

                providerCostKobo:
                    providerResult.providerCostKobo

            });


        const rewardPoints =
            calculateRewardPoints(
                validatedAmount
            );


        /*
         * Provider succeeded.
         *
         * Now permanently debit the reservation.
         */

        try {

            await commitReservedFunds({

                uid:
                    authenticatedUid,

                reservationId,

                transactionId

            });

        }

        catch (error) {

            /*
             * NEVER release here.
             *
             * Provider already succeeded.
             */

            await updateTransaction(
                transactionId,
                {

                    status:
                        STATUS_PENDING,

                    providerOutcome:
                        PROVIDER_SUCCESS,

                    providerReference:
                        providerResult.providerReference,

                    providerCostKobo:
                        providerResult.providerCostKobo,

                    gainKobo,

                    rewardPoints,

                    reconciliationRequired:
                        true,

                    walletCommitRequired:
                        true,

                    walletCommitError:
                        String(
                            error?.message ||
                            "Wallet commit failed."
                        )
                            .slice(0, 500)

                }
            );


            return {

                success:
                    false,

                pending:
                    true,

                transactionId,

                status:
                    STATUS_PENDING,

                message:
                    "Your Airtime purchase was received and is being finalized."

            };

        }


        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_SUCCESSFUL,

                providerOutcome:
                    PROVIDER_SUCCESS,

                providerReference:
                    providerResult.providerReference,

                providerCostKobo:
                    providerResult.providerCostKobo,

                gainKobo,

                rewardPoints,

                reconciliationRequired:
                    false,

                walletCommitRequired:
                    false

            }
        );


        return {

            success:
                true,

            pending:
                false,

            transactionId,

            status:
                STATUS_SUCCESSFUL,

            amountKobo:
                validatedAmount,

            network:
                normalizedNetwork,

            phoneNumber:
                normalizedPhone,

            rewardPoints,

            gainKobo

        };

    }


    // =================================================
    // CONFIRMED FAILURE
    // =================================================

    if (
        providerResult.outcome ===
        PROVIDER_FAILURE
    ) {

        try {

            await releaseReservedFunds({

                uid:
                    authenticatedUid,

                reservationId,

                reason:
                    "airtime_provider_confirmed_failure"

            });

        }

        catch (error) {

            /*
             * Provider failure is known, but the wallet
             * release failed.
             *
             * Keep the transaction pending for
             * reconciliation.
             */

            await updateTransaction(
                transactionId,
                {

                    status:
                        STATUS_PENDING,

                    providerOutcome:
                        PROVIDER_FAILURE,

                    providerReference:
                        providerResult.providerReference,

                    reconciliationRequired:
                        true,

                    walletReleaseRequired:
                        true,

                    walletReleaseError:
                        String(
                            error?.message ||
                            "Wallet release failed."
                        )
                            .slice(0, 500)

                }
            );


            return {

                success:
                    false,

                pending:
                    true,

                transactionId,

                status:
                    STATUS_PENDING,

                message:
                    "The Airtime request could not be completed and your balance is being verified."

            };

        }


        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_FAILED,

                providerOutcome:
                    PROVIDER_FAILURE,

                providerReference:
                    providerResult.providerReference,

                failureReason:
                    providerResult.message ||
                    "Airtime provider confirmed failure.",

                reconciliationRequired:
                    false

            }
        );


        return {

            success:
                false,

            pending:
                false,

            transactionId,

            status:
                STATUS_FAILED,

            message:
                "Airtime could not be completed. Your reserved balance has been released."

        };

    }


    // =================================================
    // UNKNOWN
    // =================================================

    await updateTransaction(
        transactionId,
        {

            status:
                STATUS_PENDING,

            providerOutcome:
                PROVIDER_UNKNOWN,

            providerReference:
                providerResult.providerReference,

            providerMessage:
                providerResult.message,

            reconciliationRequired:
                true

        }
    );


    return {

        success:
            false,

        pending:
            true,

        transactionId,

        status:
            STATUS_PENDING,

        message:
            "Your Airtime request is being processed. Please do not retry yet."

    };

}


// =====================================================
// RECONCILIATION
// =====================================================


// =====================================================
// FINALIZE SUCCESS
// =====================================================

async function finalizeSuccessfulTransaction({
    transactionId,
    providerReference,
    providerCostKobo
}) {

    const transaction =
        await getAirtimeTransaction(
            transactionId
        );


    if (!transaction) {

        throw new Error(
            "Airtime transaction not found."
        );

    }


    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        return {

            success:
                true,

            alreadyFinalized:
                true,

            transactionId

        };

    }


    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        throw new Error(
            "A failed Airtime transaction cannot be finalized as successful."
        );

    }


    const amountKobo =
        validateAmountKobo(
            transaction.amountKobo
        );


    const normalizedReference =
        normalizeProviderReference(
            providerReference
        );


    if (
        !normalizedReference
    ) {

        throw new Error(
            "Provider reference is required."
        );

    }


    const cost =
        Number(
            providerCostKobo
        );


    if (
        !Number.isSafeInteger(cost) ||
        cost < 0
    ) {

        throw new Error(
            "Valid provider cost is required."
        );

    }


    const gainKobo =
        calculateGainKobo({

            amountKobo,

            providerCostKobo:
                cost

        });


    const rewardPoints =
        calculateRewardPoints(
            amountKobo
        );


    if (
        !transaction.reservationId
    ) {

        throw new Error(
            "Pending Airtime transaction has no wallet reservation."
        );

    }


    try {

        await commitReservedFunds({

            uid:
                transaction.uid,

            reservationId:
                transaction.reservationId,

            transactionId

        });

    }

    catch (error) {

        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_PENDING,

                providerOutcome:
                    PROVIDER_SUCCESS,

                providerReference:
                    normalizedReference,

                providerCostKobo:
                    cost,

                gainKobo,

                rewardPoints,

                reconciliationRequired:
                    true,

                walletCommitRequired:
                    true,

                walletCommitError:
                    String(
                        error?.message ||
                        "Wallet commit failed."
                    )
                        .slice(0, 500)

            }
        );


        throw error;

    }


    await updateTransaction(
        transactionId,
        {

            status:
                STATUS_SUCCESSFUL,

            providerOutcome:
                PROVIDER_SUCCESS,

            providerReference:
                normalizedReference,

            providerCostKobo:
                cost,

            gainKobo,

            rewardPoints,

            reconciliationRequired:
                false,

            walletCommitRequired:
                false

        }
    );


    return {

        success:
            true,

        alreadyFinalized:
            false,

        transactionId,

        gainKobo,

        rewardPoints

    };

}


// =====================================================
// FINALIZE FAILURE
// =====================================================

async function finalizeFailedTransaction({
    transactionId,
    providerReference,
    reason
}) {

    const transaction =
        await getAirtimeTransaction(
            transactionId
        );


    if (!transaction) {

        throw new Error(
            "Airtime transaction not found."
        );

    }


    if (
        transaction.status ===
        STATUS_FAILED
    ) {

        return {

            success:
                true,

            alreadyFinalized:
                true,

            transactionId

        };

    }


    if (
        transaction.status ===
        STATUS_SUCCESSFUL
    ) {

        throw new Error(
            "A successful Airtime transaction cannot be changed to failed."
        );

    }


    if (
        !transaction.reservationId
    ) {

        throw new Error(
            "Pending Airtime transaction has no wallet reservation."
        );

    }


    try {

        await releaseReservedFunds({

            uid:
                transaction.uid,

            reservationId:
                transaction.reservationId,

            reason:
                reason ||
                "provider_confirmed_failure"

        });

    }

    catch (error) {

        await updateTransaction(
            transactionId,
            {

                status:
                    STATUS_PENDING,

                providerOutcome:
                    PROVIDER_FAILURE,

                providerReference:
                    normalizeProviderReference(
                        providerReference
                    ),

                reconciliationRequired:
                    true,

                walletReleaseRequired:
                    true,

                walletReleaseError:
                    String(
                        error?.message ||
                        "Wallet release failed."
                    )
                        .slice(0, 500)

            }
        );


        throw error;

    }


    await updateTransaction(
        transactionId,
        {

            status:
                STATUS_FAILED,

            providerOutcome:
                PROVIDER_FAILURE,

            providerReference:
                normalizeProviderReference(
                    providerReference
                ),

            failureReason:
                reason ||
                "Provider confirmed failure.",

            reconciliationRequired:
                false,

            walletReleaseRequired:
                false

        }
    );


    return {

        success:
            true,

        alreadyFinalized:
            false,

        transactionId

    };

}


// =====================================================
// GET PENDING TRANSACTIONS
// =====================================================

async function getPendingTransactions(
    limit = 50
) {

    const normalizedLimit =
        Number(
            limit
        );


    if (
        !Number.isInteger(
            normalizedLimit
        ) ||
        normalizedLimit < 1 ||
        normalizedLimit > 100
    ) {

        throw new Error(
            "Pending transaction limit must be between 1 and 100."
        );

    }


    const snapshot =
        await db
            .collection(
                AIRTIME_TRANSACTIONS_COLLECTION
            )
            .where(
                "status",
                "==",
                STATUS_PENDING
            )
            .orderBy(
                "createdAt",
                "asc"
            )
            .limit(
                normalizedLimit
            )
            .get();


    return snapshot.docs.map(
        document => ({

            id:
                document.id,

            ...document.data()

        })
    );

}


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

    purchaseAirtime,

    getAirtimeTransaction,

    getPendingTransactions,

    finalizeSuccessfulTransaction,

    finalizeFailedTransaction,

    calculateGainKobo,

    calculateRewardPoints,

    normalizePhoneNumber,

    normalizeNetwork

};