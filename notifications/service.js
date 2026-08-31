/* =========================================================
   NOVAPAY — NOTIFICATION SERVICE
   =========================================================
   Responsibilities:
   - Create backend-controlled in-app notifications
   - Send Firebase Cloud Messaging push notifications
   - Store notifications under the authenticated user's account
   - Register/remove user device tokens
   - Retrieve only the authenticated user's notifications
   - Mark notifications as read
   - Mark all notifications as read
   - Remove invalid FCM tokens
   - Support trusted backend notification helpers

   FIRESTORE STRUCTURE

   users/{uid}/notifications/{notificationId}

   notificationTokens/{uid}/tokens/{tokenId}

   IMPORTANT:
   - Browser requests must NEVER decide notification ownership.
   - Trusted backend services supply userId.
   - Client-facing routes must obtain userId from verified Firebase Auth.
   ========================================================= */

const crypto = require("crypto");

const {
    db
} = require("../firebase-admin");

const {
    getMessaging
} = require("firebase-admin/messaging");


/* =========================================================
   FIREBASE MESSAGING
   ========================================================= */

const messaging =
    getMessaging();


/* =========================================================
   COLLECTIONS
   ========================================================= */

const USERS_COLLECTION =
    "users";

const NOTIFICATIONS_SUBCOLLECTION =
    "notifications";

const DEVICE_TOKENS_COLLECTION =
    "notificationTokens";

const DEVICE_TOKENS_SUBCOLLECTION =
    "tokens";


/* =========================================================
   LIMITS
   ========================================================= */

const MAX_TITLE_LENGTH =
    120;

const MAX_BODY_LENGTH =
    500;

const MAX_DATA_KEYS =
    20;

const MAX_DATA_VALUE_LENGTH =
    1000;

const MAX_DEVICE_TOKENS_PER_USER =
    10;

const MAX_NOTIFICATIONS_PER_PAGE =
    50;


/* =========================================================
   SUPPORTED TYPES
   ========================================================= */

const ALLOWED_TYPES =
    new Set([

        "transaction",

        "security",

        "account",

        "promotion",

        "system",

        "payment",

        "wallet"

    ]);


/* =========================================================
   INTERNAL HELPERS
   ========================================================= */

/**
 * Generates a cryptographically strong notification ID.
 */
function createNotificationId() {

    return crypto.randomUUID();

}


/**
 * Safely converts a value into a trimmed string.
 */
function safeString(
    value
) {

    if (
        value === undefined ||
        value === null
    ) {

        return "";

    }

    return String(
        value
    ).trim();

}


/**
 * Restricts a string to a maximum length.
 */
function limitString(
    value,
    maxLength
) {

    return safeString(
        value
    ).slice(
        0,
        maxLength
    );

}


/**
 * Normalizes notification type.
 */
function normalizeType(
    type
) {

    const normalized =
        safeString(
            type
        )
            .toLowerCase();


    if (
        ALLOWED_TYPES.has(
            normalized
        )
    ) {

        return normalized;

    }


    return "system";

}


/**
 * Normalizes FCM data.
 *
 * Firebase Cloud Messaging data values must be strings.
 */
function normalizeData(
    data
) {

    if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data)
    ) {

        return {};

    }


    const result = {};

    const entries =
        Object.entries(
            data
        )
            .slice(
                0,
                MAX_DATA_KEYS
            );


    for (
        const [key, value]
        of entries
    ) {

        const safeKey =
            limitString(
                key,
                100
            );


        if (!safeKey) {

            continue;

        }


        if (
            value === undefined ||
            value === null
        ) {

            continue;

        }


        let normalizedValue;


        if (
            typeof value === "string"
        ) {

            normalizedValue =
                value;

        } else {

            try {

                normalizedValue =
                    JSON.stringify(
                        value
                    );

            }

            catch {

                normalizedValue =
                    String(
                        value
                    );

            }

        }


        result[safeKey] =
            limitString(
                normalizedValue,
                MAX_DATA_VALUE_LENGTH
            );

    }


    return result;

}


/**
 * Removes undefined object properties.
 */
function removeUndefined(
    object
) {

    return Object.fromEntries(

        Object.entries(
            object
        )
            .filter(
                ([, value]) =>
                    value !== undefined
            )

    );

}


/**
 * Returns a user's notification collection.
 *
 * Ownership is structural because notifications live
 * underneath the user's own Firestore document.
 */
function notificationCollection(
    userId
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        throw new Error(
            "Notification user ID is required."
        );

    }


    return db
        .collection(
            USERS_COLLECTION
        )
        .doc(
            normalizedUserId
        )
        .collection(
            NOTIFICATIONS_SUBCOLLECTION
        );

}


/**
 * Returns one user's notification reference.
 */
function notificationRef(
    userId,
    notificationId
) {

    const normalizedNotificationId =
        safeString(
            notificationId
        );


    if (
        !normalizedNotificationId ||
        normalizedNotificationId.length > 200 ||
        normalizedNotificationId.includes("/") ||
        normalizedNotificationId.includes("\\")
    ) {

        throw new Error(
            "Invalid notification ID."
        );

    }


    return notificationCollection(
        userId
    )
        .doc(
            normalizedNotificationId
        );

}


/**
 * Returns the device-token collection for a user.
 */
function userTokenCollection(
    userId
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        throw new Error(
            "Notification user ID is required."
        );

    }


    return db
        .collection(
            DEVICE_TOKENS_COLLECTION
        )
        .doc(
            normalizedUserId
        )
        .collection(
            DEVICE_TOKENS_SUBCOLLECTION
        );

}


/* =========================================================
   CREATE IN-APP NOTIFICATION
   ========================================================= */

/**
 * Creates an in-app notification.
 *
 * ONLY trusted backend code should call this function.
 */
async function createNotification(
    {
        userId,
        type = "system",
        title,
        body,
        data = {},
        sendPush = true
    }
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        throw new Error(
            "Notification user ID is required."
        );

    }


    const normalizedTitle =
        limitString(
            title,
            MAX_TITLE_LENGTH
        );


    const normalizedBody =
        limitString(
            body,
            MAX_BODY_LENGTH
        );


    if (!normalizedTitle) {

        throw new Error(
            "Notification title is required."
        );

    }


    if (!normalizedBody) {

        throw new Error(
            "Notification body is required."
        );

    }


    const notificationId =
        createNotificationId();


    const normalizedType =
        normalizeType(
            type
        );


    const normalizedData =
        normalizeData(
            data
        );


    const now =
        new Date();


    const notification = {

        id:
            notificationId,

        type:
            normalizedType,

        title:
            normalizedTitle,

        body:
            normalizedBody,

        data:
            normalizedData,

        read:
            false,

        createdAt:
            now,

        updatedAt:
            now

    };


    const ref =
        notificationRef(
            normalizedUserId,
            notificationId
        );


    /*
     * Ownership is represented by the Firestore path:
     *
     * users/{uid}/notifications/{notificationId}
     *
     * The userId is therefore not exposed as a mutable
     * client-controlled notification field.
     */
    await ref.create(
        notification
    );


    let pushResult = {

        attempted:
            false,

        sent:
            0,

        failed:
            0

    };


    if (sendPush) {

        try {

            pushResult =
                await sendPushNotification(
                    normalizedUserId,
                    {

                        title:
                            normalizedTitle,

                        body:
                            normalizedBody,

                        data:
                            {

                                notificationId,

                                type:
                                    normalizedType,

                                ...normalizedData

                            }

                    }
                );

        }

        catch (pushError) {

            /*
             * The in-app notification has already been
             * stored successfully.
             *
             * A temporary push-service problem must not
             * erase the user's transaction notification.
             */
            console.error(
                "NovaPay push notification error:",
                {
                    userId:
                        normalizedUserId,

                    notificationId,

                    error:
                        pushError.message
                }
            );

            pushResult = {

                attempted:
                    true,

                sent:
                    0,

                failed:
                    0,

                error:
                    "Push notification delivery failed."

            };

        }

    }


    return {

        ...notification,

        push:
            pushResult

    };

}


/* =========================================================
   SEND PUSH NOTIFICATION
   ========================================================= */

/**
 * Sends an FCM notification to all registered devices
 * belonging to the supplied authenticated user.
 */
async function sendPushNotification(
    userId,
    {
        title,
        body,
        data = {}
    }
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        return {

            attempted:
                false,

            sent:
                0,

            failed:
                0

        };

    }


    const tokenSnapshot =
        await userTokenCollection(
            normalizedUserId
        )
            .get();


    if (
        tokenSnapshot.empty
    ) {

        return {

            attempted:
                false,

            sent:
                0,

            failed:
                0

        };

    }


    const uniqueTokens =
        [
            ...new Set(

                tokenSnapshot.docs
                    .map(
                        doc =>
                            safeString(
                                doc.data()?.token
                            )
                    )
                    .filter(
                        Boolean
                    )

            )
        ];


    if (
        uniqueTokens.length === 0
    ) {

        return {

            attempted:
                false,

            sent:
                0,

            failed:
                0

        };

    }


    /*
     * Firebase multicast messages support a maximum
     * number of registration tokens per request.
     *
     * We already cap each user at 10 devices, so one
     * multicast request is sufficient.
     */
    const response =
        await messaging
            .sendEachForMulticast({

                tokens:
                    uniqueTokens,

                notification: {

                    title:
                        limitString(
                            title,
                            MAX_TITLE_LENGTH
                        ),

                    body:
                        limitString(
                            body,
                            MAX_BODY_LENGTH
                        )

                },

                data:
                    normalizeData(
                        data
                    ),

                android: {

                    priority:
                        "high",

                    notification: {

                        channelId:
                            "novapay_default",

                        sound:
                            "default"

                    }

                },

                apns: {

                    payload: {

                        aps: {

                            sound:
                                "default",

                            badge:
                                1

                        }

                    }

                }

            });


    const invalidTokenPromises = [];


    response.responses.forEach(
        (result, index) => {

            if (
                result.success
            ) {

                return;

            }


            const errorCode =
                result.error?.code ||
                "";


            if (

                errorCode ===
                    "messaging/invalid-registration-token" ||

                errorCode ===
                    "messaging/registration-token-not-registered"

            ) {

                const token =
                    uniqueTokens[index];


                invalidTokenPromises.push(
                    removeDeviceToken(
                        normalizedUserId,
                        token
                    )
                );

            }

        }
    );


    await Promise.allSettled(
        invalidTokenPromises
    );


    return {

        attempted:
            true,

        sent:
            response.successCount,

        failed:
            response.failureCount

    };

}


/* =========================================================
   REGISTER DEVICE TOKEN
   ========================================================= */

/**
 * Registers an FCM device token.
 *
 * The route calling this function MUST obtain userId
 * from verified Firebase Authentication.
 */
async function registerDeviceToken(
    userId,
    token,
    platform = "unknown"
) {

    const normalizedUserId =
        safeString(
            userId
        );


    const normalizedToken =
        safeString(
            token
        );


    const normalizedPlatform =
        limitString(
            platform,
            30
        )
            .toLowerCase();


    if (!normalizedUserId) {

        throw new Error(
            "User ID is required."
        );

    }


    if (!normalizedToken) {

        throw new Error(
            "Device token is required."
        );

    }


    if (
        normalizedToken.length < 20 ||
        normalizedToken.length > 4096
    ) {

        throw new Error(
            "Invalid device token."
        );

    }


    const tokenCollection =
        userTokenCollection(
            normalizedUserId
        );


    const existingSnapshot =
        await tokenCollection
            .where(
                "token",
                "==",
                normalizedToken
            )
            .limit(1)
            .get();


    if (
        !existingSnapshot.empty
    ) {

        const existingDoc =
            existingSnapshot.docs[0];


        await existingDoc.ref.set(

            {

                token:
                    normalizedToken,

                platform:
                    normalizedPlatform ||
                    "unknown",

                updatedAt:
                    new Date()

            },

            {
                merge:
                    true
            }

        );


        return {

            success:
                true,

            tokenId:
                existingDoc.id

        };

    }


    /*
     * Keep device-token count bounded.
     */
    const currentSnapshot =
        await tokenCollection
            .orderBy(
                "updatedAt",
                "asc"
            )
            .get();


    if (
        currentSnapshot.size >=
        MAX_DEVICE_TOKENS_PER_USER
    ) {

        const oldest =
            currentSnapshot.docs[0];


        if (oldest) {

            await oldest.ref.delete();

        }

    }


    const tokenId =
        crypto.randomUUID();


    const now =
        new Date();


    await tokenCollection
        .doc(
            tokenId
        )
        .create({

            id:
                tokenId,

            token:
                normalizedToken,

            platform:
                normalizedPlatform ||
                "unknown",

            createdAt:
                now,

            updatedAt:
                now

        });


    return {

        success:
            true,

        tokenId

    };

}


/* =========================================================
   REMOVE DEVICE TOKEN
   ========================================================= */

async function removeDeviceToken(
    userId,
    token
) {

    const normalizedUserId =
        safeString(
            userId
        );


    const normalizedToken =
        safeString(
            token
        );


    if (
        !normalizedUserId ||
        !normalizedToken
    ) {

        return false;

    }


    const snapshot =
        await userTokenCollection(
            normalizedUserId
        )
            .where(
                "token",
                "==",
                normalizedToken
            )
            .get();


    if (
        snapshot.empty
    ) {

        return false;

    }


    const batch =
        db.batch();


    snapshot.docs.forEach(
        doc => {

            batch.delete(
                doc.ref
            );

        }
    );


    await batch.commit();


    return true;

}


/* =========================================================
   REMOVE ALL DEVICE TOKENS
   ========================================================= */

async function removeAllDeviceTokens(
    userId
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        return 0;

    }


    const snapshot =
        await userTokenCollection(
            normalizedUserId
        )
            .get();


    if (
        snapshot.empty
    ) {

        return 0;

    }


    const batch =
        db.batch();


    snapshot.docs.forEach(
        doc => {

            batch.delete(
                doc.ref
            );

        }
    );


    await batch.commit();


    return snapshot.size;

}


/* =========================================================
   GET USER NOTIFICATIONS
   ========================================================= */

async function getUserNotifications(
    userId,
    {
        limit = 30,
        cursor = null
    } = {}
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        throw new Error(
            "User ID is required."
        );

    }


    let safeLimit =
        Number(
            limit
        );


    if (
        !Number.isInteger(
            safeLimit
        )
    ) {

        safeLimit = 30;

    }


    safeLimit =
        Math.min(
            Math.max(
                safeLimit,
                1
            ),
            MAX_NOTIFICATIONS_PER_PAGE
        );


    let query =
        notificationCollection(
            normalizedUserId
        )
            .orderBy(
                "createdAt",
                "desc"
            )
            .limit(
                safeLimit + 1
            );


    /*
     * Cursor is the last notification document ID.
     *
     * Because the query already belongs to the user's
     * subcollection, a cursor cannot cross into another
     * user's notification collection.
     */
    if (cursor) {

        const cursorId =
            safeString(
                cursor
            );


        if (
            !cursorId ||
            cursorId.length > 200 ||
            cursorId.includes("/") ||
            cursorId.includes("\\")
        ) {

            throw new Error(
                "Invalid notification cursor."
            );

        }


        const cursorSnapshot =
            await notificationCollection(
                normalizedUserId
            )
                .doc(
                    cursorId
                )
                .get();


        if (
            !cursorSnapshot.exists
        ) {

            throw new Error(
                "Invalid notification cursor."
            );

        }


        query =
            query.startAfter(
                cursorSnapshot
            );

    }


    const snapshot =
        await query.get();


    const documents =
        snapshot.docs;


    const hasMore =
        documents.length >
        safeLimit;


    const visibleDocuments =
        hasMore
            ? documents.slice(
                0,
                safeLimit
            )
            : documents;


    const notifications =
        visibleDocuments.map(
            doc => {

                const data =
                    doc.data();


                return removeUndefined({

                    id:
                        doc.id,

                    type:
                        data.type,

                    title:
                        data.title,

                    body:
                        data.body,

                    data:
                        data.data || {},

                    read:
                        data.read === true,

                    createdAt:
                        data.createdAt,

                    updatedAt:
                        data.updatedAt

                });

            }
        );


    const nextCursor =
        hasMore &&
        visibleDocuments.length > 0
            ? visibleDocuments[
                visibleDocuments.length - 1
            ].id
            : null;


    return {

        notifications,

        pagination: {

            limit:
                safeLimit,

            returned:
                notifications.length,

            hasMore,

            nextCursor

        }

    };

}


/* =========================================================
   GET UNREAD COUNT
   ========================================================= */

async function getUnreadCount(
    userId
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        throw new Error(
            "User ID is required."
        );

    }


    const snapshot =
        await notificationCollection(
            normalizedUserId
        )
            .where(
                "read",
                "==",
                false
            )
            .get();


    return snapshot.size;

}


/* =========================================================
   MARK ONE NOTIFICATION AS READ
   ========================================================= */

async function markNotificationRead(
    userId,
    notificationId
) {

    const normalizedUserId =
        safeString(
            userId
        );


    const normalizedNotificationId =
        safeString(
            notificationId
        );


    if (
        !normalizedUserId ||
        !normalizedNotificationId
    ) {

        throw new Error(
            "User ID and notification ID are required."
        );

    }


    const ref =
        notificationRef(
            normalizedUserId,
            normalizedNotificationId
        );


    const snapshot =
        await ref.get();


    if (
        !snapshot.exists
    ) {

        return {

            success:
                false,

            found:
                false

        };

    }


    await ref.update({

        read:
            true,

        updatedAt:
            new Date()

    });


    return {

        success:
            true,

        found:
            true

    };

}


/* =========================================================
   MARK ALL NOTIFICATIONS AS READ
   ========================================================= */

async function markAllNotificationsRead(
    userId
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        throw new Error(
            "User ID is required."
        );

    }


    const snapshot =
        await notificationCollection(
            normalizedUserId
        )
            .where(
                "read",
                "==",
                false
            )
            .get();


    if (
        snapshot.empty
    ) {

        return 0;

    }


    const batch =
        db.batch();


    snapshot.docs.forEach(
        doc => {

            batch.update(
                doc.ref,
                {

                    read:
                        true,

                    updatedAt:
                        new Date()

                }
            );

        }
    );


    await batch.commit();


    return snapshot.size;

}


/* =========================================================
   DELETE OLD NOTIFICATIONS
   ========================================================= */

/**
 * Trusted maintenance helper.
 *
 * This is NOT exposed to browser users.
 */
async function deleteOldNotifications(
    userId,
    days = 180
) {

    const normalizedUserId =
        safeString(
            userId
        );


    if (!normalizedUserId) {

        throw new Error(
            "User ID is required."
        );

    }


    let safeDays =
        Number(
            days
        );


    if (
        !Number.isInteger(
            safeDays
        ) ||
        safeDays < 30
    ) {

        safeDays = 180;

    }


    const cutoff =
        new Date(

            Date.now() -
            safeDays *
            24 *
            60 *
            60 *
            1000

        );


    const snapshot =
        await notificationCollection(
            normalizedUserId
        )
            .where(
                "createdAt",
                "<",
                cutoff
            )
            .limit(
                500
            )
            .get();


    if (
        snapshot.empty
    ) {

        return 0;

    }


    const batch =
        db.batch();


    snapshot.docs.forEach(
        doc => {

            batch.delete(
                doc.ref
            );

        }
    );


    await batch.commit();


    return snapshot.size;

}


/* =========================================================
   TRANSACTION NOTIFICATION
   ========================================================= */

async function notifyTransaction(
    {
        userId,
        title,
        body,
        transactionId,
        reference,
        direction,
        amountKobo,
        status = "successful",
        provider = null
    }
) {

    const data =
        removeUndefined({

            transactionId:
                safeString(
                    transactionId
                ),

            reference:
                safeString(
                    reference
                ),

            direction:
                safeString(
                    direction
                ),

            amountKobo:
                Number.isSafeInteger(
                    Number(
                        amountKobo
                    )
                )
                    ? String(
                        Number(
                            amountKobo
                        )
                    )
                    : undefined,

            status:
                safeString(
                    status
                ),

            provider:
                provider
                    ? safeString(
                        provider
                    )
                    : undefined

        });


    return createNotification({

        userId,

        type:
            "transaction",

        title,

        body,

        data,

        sendPush:
            true

    });

}


/* =========================================================
   SECURITY NOTIFICATION
   ========================================================= */

async function notifySecurity(
    {
        userId,
        title,
        body,
        data = {}
    }
) {

    return createNotification({

        userId,

        type:
            "security",

        title,

        body,

        data,

        sendPush:
            true

    });

}


/* =========================================================
   ACCOUNT NOTIFICATION
   ========================================================= */

async function notifyAccount(
    {
        userId,
        title,
        body,
        data = {}
    }
) {

    return createNotification({

        userId,

        type:
            "account",

        title,

        body,

        data,

        sendPush:
            true

    });

}


/* =========================================================
   SYSTEM NOTIFICATION
   ========================================================= */

async function notifySystem(
    {
        userId,
        title,
        body,
        data = {},
        sendPush = true
    }
) {

    return createNotification({

        userId,

        type:
            "system",

        title,

        body,

        data,

        sendPush

    });

}


/* =========================================================
   EXPORTS
   ========================================================= */

module.exports = {

    createNotification,

    sendPushNotification,

    registerDeviceToken,

    removeDeviceToken,

    removeAllDeviceTokens,

    getUserNotifications,

    getUnreadCount,

    markNotificationRead,

    markAllNotificationsRead,

    deleteOldNotifications,

    notifyTransaction,

    notifySecurity,

    notifyAccount,

    notifySystem

};