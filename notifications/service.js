const crypto = require("crypto");
const { db } = require("../firebase-admin");
const { getMessaging } = require("firebase-admin/messaging");

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 500;
const MAX_DATA_KEYS = 20;
const MAX_DATA_VALUE_LENGTH = 1000;
const MAX_TOKENS_PER_USER = 10;
const MAX_NOTIFICATIONS_PER_PAGE = 50;

const ALLOWED_TYPES = new Set([
    "transaction",
    "security",
    "account",
    "promotion",
    "system",
    "payment",
    "wallet",
    "airtime",
    "data",
    "electricity",
    "tv",
    "add_money",
    "failed",
    "reversed",
    "refund"
]);

const NOTIFICATIONS_COLLECTION = "notifications";
const FCM_TOKENS_COLLECTION = "notificationTokens";
const WEB_PUSH_COLLECTION = "notificationPushSubscriptions";

/*
|--------------------------------------------------------------------------
| Web Push
|--------------------------------------------------------------------------
*/

let webPush = null;
let webPushLoadAttempted = false;

function getWebPush() {
    if (webPushLoadAttempted) {
        return webPush;
    }

    webPushLoadAttempted = true;

    try {
        webPush = require("web-push");
    } catch (error) {
        console.error(
            "Web Push dependency is not installed. Run: npm install web-push"
        );
        webPush = null;
    }

    return webPush;
}

function configureWebPush() {
    const library = getWebPush();

    if (!library) {
        return false;
    }

    const subject = String(
        process.env.WEB_PUSH_VAPID_SUBJECT || ""
    ).trim();

    const publicKey = String(
        process.env.WEB_PUSH_VAPID_PUBLIC_KEY || ""
    ).trim();

    const privateKey = String(
        process.env.WEB_PUSH_VAPID_PRIVATE_KEY || ""
    ).trim();

    if (!subject || !publicKey || !privateKey) {
        console.warn(
            "Web Push is not configured. Missing WEB_PUSH_VAPID_SUBJECT, WEB_PUSH_VAPID_PUBLIC_KEY or WEB_PUSH_VAPID_PRIVATE_KEY."
        );

        return false;
    }

    try {
        library.setVapidDetails(
            subject,
            publicKey,
            privateKey
        );

        return true;
    } catch (error) {
        console.error(
            "Failed to configure Web Push:",
            error.message
        );

        return false;
    }
}

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function normalizeString(value, maxLength) {
    return String(value ?? "")
        .trim()
        .slice(0, maxLength);
}

function normalizeNotificationType(type) {
    const normalized = normalizeString(type, 50).toLowerCase();

    if (ALLOWED_TYPES.has(normalized)) {
        return normalized;
    }

    return "system";
}

function normalizeData(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return {};
    }

    const result = {};
    const entries = Object.entries(data).slice(0, MAX_DATA_KEYS);

    for (const [key, value] of entries) {
        const normalizedKey = normalizeString(key, 100);

        if (!normalizedKey) {
            continue;
        }

        let normalizedValue;

        if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        ) {
            normalizedValue = String(value);
        } else {
            try {
                normalizedValue = JSON.stringify(value);
            } catch {
                normalizedValue = "";
            }
        }

        result[normalizedKey] = normalizedValue.slice(
            0,
            MAX_DATA_VALUE_LENGTH
        );
    }

    return result;
}

function createNotificationId() {
    return crypto.randomUUID();
}

function normalizePushSubscription(subscription) {
    if (!subscription || typeof subscription !== "object") {
        return null;
    }

    const endpoint = normalizeString(
        subscription.endpoint,
        2000
    );

    const keys =
        subscription.keys &&
        typeof subscription.keys === "object"
            ? subscription.keys
            : {};

    const p256dh = normalizeString(
        keys.p256dh,
        1000
    );

    const auth = normalizeString(
        keys.auth,
        1000
    );

    if (!endpoint || !p256dh || !auth) {
        return null;
    }

    return {
        endpoint,
        expirationTime:
            subscription.expirationTime == null
                ? null
                : Number(subscription.expirationTime),
        keys: {
            p256dh,
            auth
        }
    };
}

/*
|--------------------------------------------------------------------------
| Create In-App Notification
|--------------------------------------------------------------------------
*/

async function createNotification({
    userId,
    type,
    title,
    body,
    message,
    data = {},
    sendPush = true
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const normalizedType = normalizeNotificationType(type);

    const normalizedTitle = normalizeString(
        title || "NovaPay",
        MAX_TITLE_LENGTH
    );

    const normalizedBody = normalizeString(
        body || message || "You have a new notification.",
        MAX_BODY_LENGTH
    );

    const normalizedData = normalizeData(data);

    const notificationId = createNotificationId();

    const notificationRef = db
        .collection("users")
        .doc(userId)
        .collection(NOTIFICATIONS_COLLECTION)
        .doc(notificationId);

    const notification = {
        id: notificationId,
        type: normalizedType,
        title: normalizedTitle,
        body: normalizedBody,
        message: normalizedBody,
        data: normalizedData,
        isRead: false,
        createdAt: new Date()
    };

    await notificationRef.set(notification);

    let pushResult = {
        attempted: false,
        sent: 0,
        failed: 0
    };

    if (sendPush === true) {
        try {
            pushResult = await sendPushNotification({
                userId,
                notificationId,
                type: normalizedType,
                title: normalizedTitle,
                body: normalizedBody,
                data: normalizedData
            });
        } catch (error) {
            console.error(
                "Push notification failed:",
                error.message
            );

            pushResult = {
                attempted: true,
                sent: 0,
                failed: 1,
                error: error.message
            };
        }
    }

    return {
        success: true,
        notification: {
            ...notification,
            createdAt: notification.createdAt.toISOString()
        },
        push: pushResult
    };
}

/*
|--------------------------------------------------------------------------
| Send Push Notification
|--------------------------------------------------------------------------
*/

async function sendPushNotification({
    userId,
    notificationId,
    type,
    title,
    body,
    data = {}
}) {
    const results = {
        attempted: true,
        webPush: {
            attempted: false,
            sent: 0,
            failed: 0
        },
        fcm: {
            attempted: false,
            sent: 0,
            failed: 0
        },
        sent: 0,
        failed: 0
    };

    try {
        const webPushResult = await sendWebPushNotification({
            userId,
            notificationId,
            type,
            title,
            body,
            data
        });

        results.webPush = webPushResult;
    } catch (error) {
        console.error(
            "Standard Web Push error:",
            error.message
        );

        results.webPush = {
            attempted: true,
            sent: 0,
            failed: 1,
            error: error.message
        };
    }

    try {
        const fcmResult = await sendLegacyFCMNotification({
            userId,
            notificationId,
            type,
            title,
            body,
            data
        });

        results.fcm = fcmResult;
    } catch (error) {
        console.error(
            "Legacy FCM error:",
            error.message
        );

        results.fcm = {
            attempted: true,
            sent: 0,
            failed: 1,
            error: error.message
        };
    }

    results.sent =
        results.webPush.sent +
        results.fcm.sent;

    results.failed =
        results.webPush.failed +
        results.fcm.failed;

    return results;
}

/*
|--------------------------------------------------------------------------
| Standard Web Push
|--------------------------------------------------------------------------
*/

async function sendWebPushNotification({
    userId,
    notificationId,
    type,
    title,
    body,
    data = {}
}) {
    const library = getWebPush();

    if (!library) {
        return {
            attempted: false,
            sent: 0,
            failed: 0,
            error: "Web Push dependency is not installed."
        };
    }

    if (!configureWebPush()) {
        return {
            attempted: false,
            sent: 0,
            failed: 0,
            error: "Web Push is not configured."
        };
    }

    const snapshot = await db
        .collection(WEB_PUSH_COLLECTION)
        .doc(userId)
        .collection("subscriptions")
        .limit(MAX_TOKENS_PER_USER)
        .get();

    if (snapshot.empty) {
        return {
            attempted: false,
            sent: 0,
            failed: 0,
            error: "No Web Push subscriptions found."
        };
    }

    const payload = JSON.stringify({
        notification: {
            title,
            body,
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            tag: notificationId,
            data: {
                notificationId,
                type,
                ...data
            }
        },
        data: {
            notificationId,
            type,
            ...data
        }
    });

    let sent = 0;
    let failed = 0;

    for (const document of snapshot.docs) {
        const subscriptionRecord = document.data();

        const subscription =
            subscriptionRecord.subscription;

        if (!subscription) {
            failed += 1;
            continue;
        }

        try {
            await library.sendNotification(
                subscription,
                payload,
                {
                    TTL: 60 * 60 * 24
                }
            );

            sent += 1;
        } catch (error) {
            failed += 1;

            const statusCode =
                Number(error.statusCode) || 0;

            console.error(
                "Web Push delivery failed:",
                {
                    userId,
                    subscriptionId: document.id,
                    statusCode,
                    message: error.message
                }
            );

            if (
                statusCode === 404 ||
                statusCode === 410
            ) {
                await document.ref.delete().catch(
                    deleteError => {
                        console.error(
                            "Failed to remove expired Web Push subscription:",
                            deleteError.message
                        );
                    }
                );
            }
        }
    }

    return {
        attempted: true,
        sent,
        failed
    };
}

/*
|--------------------------------------------------------------------------
| Register Web Push Subscription
|--------------------------------------------------------------------------
*/

async function registerPushSubscription({
    userId,
    subscription,
    platform = "web"
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const normalizedSubscription =
        normalizePushSubscription(subscription);

    if (!normalizedSubscription) {
        throw new Error(
            "A valid Web Push subscription is required."
        );
    }

    const endpointHash = crypto
        .createHash("sha256")
        .update(normalizedSubscription.endpoint)
        .digest("hex");

    const subscriptionRef = db
        .collection(WEB_PUSH_COLLECTION)
        .doc(userId)
        .collection("subscriptions")
        .doc(endpointHash);

    await subscriptionRef.set(
        {
            subscription: normalizedSubscription,
            platform: normalizeString(
                platform,
                50
            ) || "web",
            endpoint: normalizedSubscription.endpoint,
            updatedAt: new Date()
        },
        {
            merge: true
        }
    );

    return {
        success: true,
        subscriptionId: endpointHash
    };
}

/*
|--------------------------------------------------------------------------
| Remove Web Push Subscription
|--------------------------------------------------------------------------
*/

async function removePushSubscription({
    userId,
    subscription
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const normalizedSubscription =
        normalizePushSubscription(subscription);

    if (!normalizedSubscription) {
        throw new Error(
            "A valid Web Push subscription is required."
        );
    }

    const endpointHash = crypto
        .createHash("sha256")
        .update(normalizedSubscription.endpoint)
        .digest("hex");

    await db
        .collection(WEB_PUSH_COLLECTION)
        .doc(userId)
        .collection("subscriptions")
        .doc(endpointHash)
        .delete();

    return {
        success: true
    };
}

async function removePushSubscriptionById({
    userId,
    subscriptionId
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const normalizedId = normalizeString(
        subscriptionId,
        200
    );

    if (!normalizedId) {
        throw new Error(
            "subscriptionId is required."
        );
    }

    await db
        .collection(WEB_PUSH_COLLECTION)
        .doc(userId)
        .collection("subscriptions")
        .doc(normalizedId)
        .delete();

    return {
        success: true
    };
}

async function removeAllPushSubscriptions(userId) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const collectionRef = db
        .collection(WEB_PUSH_COLLECTION)
        .doc(userId)
        .collection("subscriptions");

    const snapshot = await collectionRef.get();

    if (snapshot.empty) {
        return {
            success: true,
            removed: 0
        };
    }

    const batch = db.batch();

    snapshot.docs.forEach(document => {
        batch.delete(document.ref);
    });

    await batch.commit();

    return {
        success: true,
        removed: snapshot.size
    };
}

/*
|--------------------------------------------------------------------------
| Legacy Firebase Cloud Messaging
|--------------------------------------------------------------------------
*/

async function sendLegacyFCMNotification({
    userId,
    notificationId,
    type,
    title,
    body,
    data = {}
}) {
    const snapshot = await db
        .collection(FCM_TOKENS_COLLECTION)
        .doc(userId)
        .collection("tokens")
        .limit(MAX_TOKENS_PER_USER)
        .get();

    if (snapshot.empty) {
        return {
            attempted: false,
            sent: 0,
            failed: 0,
            error: "No FCM tokens found."
        };
    }

    const tokens = snapshot.docs
        .map(document => document.data()?.token)
        .filter(Boolean);

    if (!tokens.length) {
        return {
            attempted: false,
            sent: 0,
            failed: 0,
            error: "No valid FCM tokens found."
        };
    }

    const messaging = getMessaging();

    const stringData = {
        notificationId: String(notificationId),
        type: String(type),
        ...normalizeData(data)
    };

    const message = {
        tokens,
        notification: {
            title,
            body
        },
        data: stringData,
        webpush: {
            notification: {
                title,
                body,
                icon: "/icon-192.png",
                badge: "/icon-192.png"
            },
            fcmOptions: {
                link: "/notifications.html"
            }
        }
    };

    const response =
        await messaging.sendEachForMulticast(message);

    const invalidTokens = [];

    response.responses.forEach(
        (result, index) => {
            if (!result.success) {
                const errorCode =
                    result.error?.code || "";

                if (
                    errorCode.includes(
                        "registration-token-not-registered"
                    ) ||
                    errorCode.includes(
                        "invalid-registration-token"
                    )
                ) {
                    invalidTokens.push(
                        tokens[index]
                    );
                }
            }
        }
    );

    if (invalidTokens.length) {
        const deleteBatch = db.batch();

        snapshot.docs.forEach(document => {
            const token = document.data()?.token;

            if (invalidTokens.includes(token)) {
                deleteBatch.delete(document.ref);
            }
        });

        await deleteBatch.commit();
    }

    return {
        attempted: true,
        sent: response.successCount,
        failed: response.failureCount
    };
}

/*
|--------------------------------------------------------------------------
| FCM Device Token Management
|--------------------------------------------------------------------------
*/

async function registerDeviceToken({
    userId,
    token,
    platform = "web"
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const normalizedToken = normalizeString(
        token,
        4000
    );

    if (!normalizedToken) {
        throw new Error("FCM token is required.");
    }

    const tokenHash = crypto
        .createHash("sha256")
        .update(normalizedToken)
        .digest("hex");

    const tokenRef = db
        .collection(FCM_TOKENS_COLLECTION)
        .doc(userId)
        .collection("tokens")
        .doc(tokenHash);

    await tokenRef.set(
        {
            token: normalizedToken,
            platform: normalizeString(
                platform,
                50
            ) || "web",
            updatedAt: new Date()
        },
        {
            merge: true
        }
    );

    return {
        success: true,
        tokenId: tokenHash
    };
}

async function removeDeviceToken({
    userId,
    token
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const normalizedToken = normalizeString(
        token,
        4000
    );

    if (!normalizedToken) {
        throw new Error("FCM token is required.");
    }

    const tokenHash = crypto
        .createHash("sha256")
        .update(normalizedToken)
        .digest("hex");

    await db
        .collection(FCM_TOKENS_COLLECTION)
        .doc(userId)
        .collection("tokens")
        .doc(tokenHash)
        .delete();

    return {
        success: true
    };
}

async function removeAllDeviceTokens(userId) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const collectionRef = db
        .collection(FCM_TOKENS_COLLECTION)
        .doc(userId)
        .collection("tokens");

    const snapshot = await collectionRef.get();

    if (snapshot.empty) {
        return {
            success: true,
            removed: 0
        };
    }

    const batch = db.batch();

    snapshot.docs.forEach(document => {
        batch.delete(document.ref);
    });

    await batch.commit();

    return {
        success: true,
        removed: snapshot.size
    };
}

/*
|--------------------------------------------------------------------------
| Notification History
|--------------------------------------------------------------------------
*/

async function getUserNotifications({
    userId,
    limit = 30,
    cursor = null
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const safeLimit = Math.min(
        Math.max(Number(limit) || 30, 1),
        MAX_NOTIFICATIONS_PER_PAGE
    );

    let query = db
        .collection("users")
        .doc(userId)
        .collection(NOTIFICATIONS_COLLECTION)
        .orderBy("createdAt", "desc")
        .limit(safeLimit);

    if (cursor) {
        const cursorDocument =
            await db
                .collection("users")
                .doc(userId)
                .collection(NOTIFICATIONS_COLLECTION)
                .doc(cursor)
                .get();

        if (cursorDocument.exists) {
            query = query.startAfter(
                cursorDocument
            );
        }
    }

    const snapshot = await query.get();

    const notifications = snapshot.docs.map(
        document => {
            const data = document.data();

            let createdAt = null;

            if (
                data.createdAt &&
                typeof data.createdAt.toDate === "function"
            ) {
                createdAt =
                    data.createdAt.toDate().toISOString();
            } else if (
                data.createdAt instanceof Date
            ) {
                createdAt =
                    data.createdAt.toISOString();
            } else if (data.createdAt) {
                createdAt = String(
                    data.createdAt
                );
            }

            return {
                id: document.id,
                ...data,
                createdAt
            };
        }
    );

    const lastDocument =
        snapshot.docs[snapshot.docs.length - 1];

    return {
        success: true,
        notifications,
        nextCursor:
            lastDocument?.id || null,
        hasMore:
            snapshot.docs.length === safeLimit
    };
}

/*
|--------------------------------------------------------------------------
| Unread Count
|--------------------------------------------------------------------------
*/

async function getUnreadCount(userId) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const snapshot = await db
        .collection("users")
        .doc(userId)
        .collection(NOTIFICATIONS_COLLECTION)
        .where("isRead", "==", false)
        .limit(100)
        .get();

    return {
        success: true,
        count: snapshot.size
    };
}

/*
|--------------------------------------------------------------------------
| Mark Notification Read
|--------------------------------------------------------------------------
*/

async function markNotificationRead({
    userId,
    notificationId
}) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    if (!notificationId) {
        throw new Error(
            "notificationId is required."
        );
    }

    const notificationRef = db
        .collection("users")
        .doc(userId)
        .collection(NOTIFICATIONS_COLLECTION)
        .doc(notificationId);

    const snapshot =
        await notificationRef.get();

    if (!snapshot.exists) {
        throw new Error(
            "Notification not found."
        );
    }

    await notificationRef.update({
        isRead: true,
        readAt: new Date()
    });

    return {
        success: true
    };
}

/*
|--------------------------------------------------------------------------
| Mark All Notifications Read
|--------------------------------------------------------------------------
*/

async function markAllNotificationsRead(userId) {
    if (!userId) {
        throw new Error("userId is required.");
    }

    const collectionRef = db
        .collection("users")
        .doc(userId)
        .collection(NOTIFICATIONS_COLLECTION);

    const snapshot = await collectionRef
        .where("isRead", "==", false)
        .limit(500)
        .get();

    if (snapshot.empty) {
        return {
            success: true,
            updated: 0
        };
    }

    const batch = db.batch();

    snapshot.docs.forEach(document => {
        batch.update(document.ref, {
            isRead: true,
            readAt: new Date()
        });
    });

    await batch.commit();

    return {
        success: true,
        updated: snapshot.size
    };
}

/*
|--------------------------------------------------------------------------
| Convenience Notification Helpers
|--------------------------------------------------------------------------
*/

async function notifyTransaction({
    userId,
    title,
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "transaction",
        title,
        body,
        data,
        sendPush
    });
}

async function notifySecurity({
    userId,
    title,
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "security",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyAccount({
    userId,
    title,
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "account",
        title,
        body,
        data,
        sendPush
    });
}

async function notifySystem({
    userId,
    title,
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "system",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyAirtime({
    userId,
    title = "Airtime purchase",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "airtime",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyData({
    userId,
    title = "Data purchase",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "data",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyElectricity({
    userId,
    title = "Electricity payment",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "electricity",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyTV({
    userId,
    title = "TV subscription",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "tv",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyAddMoney({
    userId,
    title = "Money added",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "add_money",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyFailed({
    userId,
    title = "Transaction failed",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "failed",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyReversed({
    userId,
    title = "Transaction reversed",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "reversed",
        title,
        body,
        data,
        sendPush
    });
}

async function notifyRefund({
    userId,
    title = "Refund processed",
    body,
    data = {},
    sendPush = true
}) {
    return createNotification({
        userId,
        type: "refund",
        title,
        body,
        data,
        sendPush
    });
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
    createNotification,

    sendPushNotification,
    sendWebPushNotification,
    sendLegacyFCMNotification,

    registerPushSubscription,
    removePushSubscription,
    removePushSubscriptionById,
    removeAllPushSubscriptions,

    registerDeviceToken,
    removeDeviceToken,
    removeAllDeviceTokens,

    getUserNotifications,
    getUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,

    notifyTransaction,
    notifySecurity,
    notifyAccount,
    notifySystem,

    notifyAirtime,
    notifyData,
    notifyElectricity,
    notifyTV,
    notifyAddMoney,
    notifyFailed,
    notifyReversed,
    notifyRefund
};