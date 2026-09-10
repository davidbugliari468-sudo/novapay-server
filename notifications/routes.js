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
    removeDeviceToken
} = require("./service");

const router = express.Router();


// =====================================================
// CREATE NOTIFICATION
// =====================================================
//
// POST /api/notifications
//
// Creates a notification for the authenticated user.
//
// The frontend NEVER supplies a UID.
// req.user.uid is always used.
//
// body/message are both accepted for compatibility.
// The notification service stores the final value as
// "body".
//
// sendPush defaults to true.
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
// The authenticated Firebase UID determines which
// user's notifications are returned.
// =====================================================

router.get(
    "/",
    requireAuth,
    async (req, res) => {

        try {

            const result =
                await getUserNotifications(

                    req.user.uid,

                    {
                        limit:
                            req.query.limit,

                        cursor:
                            req.query.cursor
                    }

                );


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

            const count =
                await getUnreadCount(
                    req.user.uid
                );


            return res.status(200).json({

                success: true,

                count,

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
                await markNotificationRead(

                    req.user.uid,

                    notificationId

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
// REGISTER DEVICE TOKEN
// =====================================================
//
// POST /api/notifications/device-token
//
// Stores an FCM registration token for the authenticated
// user's device.
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
                await registerDeviceToken(

                    req.user.uid,

                    token,

                    platform

                );


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
// REMOVE DEVICE TOKEN
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
                await removeDeviceToken(

                    req.user.uid,

                    token

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