"use strict";

const express = require("express");

const { requireAuth } = require("../auth");

const {
    createNotification,
    getUserNotifications,
    getUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,

    registerDeviceToken,
    removeDeviceToken,

    registerPushSubscription,
    removePushSubscription
} = require("./service");

const router = express.Router();


// =====================================================
// CREATE NOTIFICATION
// =====================================================
//
// POST /api/notifications
//
// Creates an in-app notification for the authenticated
// user and optionally sends a push notification.
//
// The frontend NEVER supplies a UID.
// req.user.uid is always used.
// =====================================================

router.post(
    "/",
    requireAuth,
    async (req, res) => {

        try {

            const {
                type,
                title,
                body,
                message,
                data,
                sendPush
            } = req.body || {};


            const result =
                await createNotification({

                    userId:
                        req.user.uid,

                    type,

                    title,

                    body:
                        body ?? message,

                    data,

                    sendPush:
                        sendPush !== false

                });


            const {
                push,
                ...notification
            } = result;


            return res.status(201).json({

                success: true,

                notification,

                push,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay create notification error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to create notification.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// GET NOTIFICATIONS
// =====================================================
//
// GET /api/notifications
//
// Query:
//
// ?limit=30
// ?cursor=<cursor>
//
// Returns notification history belonging only to the
// authenticated user.
// =====================================================

router.get(
    "/",
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await getUserNotifications({

                    userId:
                        req.user.uid,

                    limit:
                        req.query.limit,

                    cursor:
                        req.query.cursor

                });


            return res.status(200).json({

                success: true,

                notifications:
                    result.notifications || [],

                pagination: {

                    hasMore:
                        result.hasMore === true,

                    nextCursor:
                        result.nextCursor ||
                        null

                },

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay get notifications error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to load notifications.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// GET UNREAD COUNT
// =====================================================
//
// GET /api/notifications/unread-count
// =====================================================

router.get(
    "/unread-count",
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await getUnreadCount(
                    req.user.uid
                );


            return res.status(200).json({

                success: true,

                count:
                    result.count ?? 0,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay unread notification count error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to get unread notification count.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// MARK ALL NOTIFICATIONS AS READ
// =====================================================
//
// PATCH /api/notifications/read-all
// =====================================================

router.patch(
    "/read-all",
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await markAllNotificationsRead(
                    req.user.uid
                );


            return res.status(200).json({

                success: true,

                ...result,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay mark all notifications read error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to mark notifications as read.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// MARK ONE NOTIFICATION AS READ
// =====================================================
//
// PATCH /api/notifications/:notificationId/read
// =====================================================

router.patch(
    "/:notificationId/read",
    requireAuth,
    async (req, res) => {

        try {

            const notificationId =
                String(
                    req.params.notificationId ||
                    ""
                ).trim();


            if (!notificationId) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Notification ID is required.",

                    requestId:
                        req.requestId

                });

            }


            const result =
                await markNotificationRead({

                    userId:
                        req.user.uid,

                    notificationId

                });


            return res.status(200).json({

                success: true,

                ...result,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay mark notification read error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to mark notification as read.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// GET WEB PUSH PUBLIC KEY
// =====================================================
//
// GET /api/notifications/push-public-key
//
// The browser needs the VAPID public key to create its
// Web Push subscription.
//
// The private key is NEVER returned to the browser.
// =====================================================

router.get(
    "/push-public-key",
    requireAuth,
    async (req, res) => {

        try {

            const publicKey =
                String(
                    process.env.WEB_PUSH_VAPID_PUBLIC_KEY ||
                    ""
                ).trim();


            if (!publicKey) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Web Push public key is not configured.",

                    requestId:
                        req.requestId

                });

            }


            return res.status(200).json({

                success: true,

                publicKey,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay get Web Push public key error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(500).json({

                success: false,

                error:
                    "Unable to get Web Push configuration.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// REGISTER WEB PUSH SUBSCRIPTION
// =====================================================
//
// POST /api/notifications/push-subscription
//
// Expected body:
//
// {
//     subscription: {
//         endpoint: "...",
//         keys: {
//             p256dh: "...",
//             auth: "..."
//         }
//     },
//     platform: "ios" | "android" | "desktop" | "web"
// }
//
// The UID always comes from authenticated Firebase auth.
// =====================================================

router.post(
    "/push-subscription",
    requireAuth,
    async (req, res) => {

        try {

            const {
                subscription,
                platform
            } = req.body || {};


            if (
                !subscription ||
                typeof subscription !== "object"
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "A valid push subscription is required.",

                    requestId:
                        req.requestId

                });

            }


            const result =
                await registerPushSubscription({

                    userId:
                        req.user.uid,

                    subscription,

                    platform

                });


            return res.status(201).json({

                success: true,

                ...result,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay register Web Push subscription error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to register push subscription.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// REMOVE WEB PUSH SUBSCRIPTION
// =====================================================
//
// DELETE /api/notifications/push-subscription
//
// Expected body:
//
// {
//     subscription: {
//         endpoint: "...",
//         keys: {
//             p256dh: "...",
//             auth: "..."
//         }
//     }
// }
// =====================================================

router.delete(
    "/push-subscription",
    requireAuth,
    async (req, res) => {

        try {

            const subscription =
                req.body?.subscription ||
                null;


            if (
                !subscription ||
                typeof subscription !== "object"
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "A valid push subscription is required.",

                    requestId:
                        req.requestId

                });

            }


            const result =
                await removePushSubscription({

                    userId:
                        req.user.uid,

                    subscription

                });


            return res.status(200).json({

                success: true,

                ...result,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay remove Web Push subscription error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to remove push subscription.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// REGISTER LEGACY FCM DEVICE TOKEN
// =====================================================
//
// POST /api/notifications/device-token
//
// Kept for compatibility with the existing FCM system.
// =====================================================

router.post(
    "/device-token",
    requireAuth,
    async (req, res) => {

        try {

            const {
                token,
                platform
            } = req.body || {};


            const result =
                await registerDeviceToken({

                    userId:
                        req.user.uid,

                    token,

                    platform

                });


            return res.status(201).json({

                success: true,

                ...result,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay register device token error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to register device token.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// REMOVE LEGACY FCM DEVICE TOKEN
// =====================================================
//
// DELETE /api/notifications/device-token
//
// Token can be supplied through:
//
// req.body.token
//
// or
//
// req.query.token
// =====================================================

router.delete(
    "/device-token",
    requireAuth,
    async (req, res) => {

        try {

            const token =
                req.body?.token ||
                req.query?.token ||
                null;


            const result =
                await removeDeviceToken({

                    userId:
                        req.user.uid,

                    token

                });


            return res.status(200).json({

                success: true,

                ...result,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay remove device token error:",
                {
                    requestId:
                        req.requestId,

                    uid:
                        req.user?.uid,

                    error:
                        error.message
                }
            );


            return res.status(400).json({

                success: false,

                error:
                    error?.message ||
                    "Unable to remove device token.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;