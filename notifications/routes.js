"use strict";

const express = require("express");

const { requireAuth } = require("../middleware/auth");

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

/*
|--------------------------------------------------------------------------
| Create notification
|--------------------------------------------------------------------------
| Creates an in-app notification for the currently authenticated user.
| If sendPush is true, the notification service will also attempt FCM push.
|--------------------------------------------------------------------------
*/
router.post("/", requireAuth, async (req, res) => {
    try {
        const {
            type,
            title,
            body,
            message,
            data,
            sendPush
        } = req.body || {};

        const result = await createNotification({
            userId: req.user.uid,
            type,
            title,
            body: body ?? message,
            data,
            sendPush: sendPush !== false
        });

        const {
            push,
            ...notification
        } = result;

        return res.status(201).json({
            success: true,
            notification,
            push,
            requestId: req.requestId
        });
    } catch (error) {
        console.error("Create notification route error:", error);

        return res.status(400).json({
            success: false,
            error: error?.message || "Unable to create notification.",
            requestId: req.requestId
        });
    }
});

/*
|--------------------------------------------------------------------------
| Get notifications
|--------------------------------------------------------------------------
*/
router.get("/", requireAuth, async (req, res) => {
    try {
        const limit = req.query.limit;
        const cursor = req.query.cursor;

        const result = await getUserNotifications(
            req.user.uid,
            {
                limit,
                cursor
            }
        );

        return res.json({
            success: true,
            notifications: result.notifications || [],
            pagination: {
                hasMore: result.hasMore === true,
                nextCursor: result.nextCursor || null
            },
            requestId: req.requestId
        });
    } catch (error) {
        console.error("Get notifications route error:", error);

        return res.status(400).json({
            success: false,
            error: error?.message || "Unable to load notifications.",
            requestId: req.requestId
        });
    }
});

/*
|--------------------------------------------------------------------------
| Get unread notification count
|--------------------------------------------------------------------------
*/
router.get("/unread-count", requireAuth, async (req, res) => {
    try {
        const count = await getUnreadCount(req.user.uid);

        return res.json({
            success: true,
            count,
            requestId: req.requestId
        });
    } catch (error) {
        console.error("Unread notification count route error:", error);

        return res.status(400).json({
            success: false,
            error: error?.message || "Unable to get unread notification count.",
            requestId: req.requestId
        });
    }
});

/*
|--------------------------------------------------------------------------
| Mark all notifications as read
|--------------------------------------------------------------------------
*/
router.patch("/read-all", requireAuth, async (req, res) => {
    try {
        const result = await markAllNotificationsRead(req.user.uid);

        return res.json({
            success: true,
            ...result,
            requestId: req.requestId
        });
    } catch (error) {
        console.error("Mark all notifications read route error:", error);

        return res.status(400).json({
            success: false,
            error: error?.message || "Unable to mark notifications as read.",
            requestId: req.requestId
        });
    }
});

/*
|--------------------------------------------------------------------------
| Mark one notification as read
|--------------------------------------------------------------------------
*/
router.patch("/:notificationId/read", requireAuth, async (req, res) => {
    try {
        const notificationId = String(
            req.params.notificationId || ""
        ).trim();

        if (!notificationId) {
            return res.status(400).json({
                success: false,
                error: "Notification ID is required.",
                requestId: req.requestId
            });
        }

        const result = await markNotificationRead(
            req.user.uid,
            notificationId
        );

        return res.json({
            success: true,
            ...result,
            requestId: req.requestId
        });
    } catch (error) {
        console.error("Mark notification read route error:", error);

        return res.status(400).json({
            success: false,
            error: error?.message || "Unable to mark notification as read.",
            requestId: req.requestId
        });
    }
});

/*
|--------------------------------------------------------------------------
| Register FCM device token
|--------------------------------------------------------------------------
*/
router.post("/device-token", requireAuth, async (req, res) => {
    try {
        const {
            token,
            platform
        } = req.body || {};

        const result = await registerDeviceToken(
            req.user.uid,
            token,
            platform
        );

        return res.status(201).json({
            success: true,
            ...result,
            requestId: req.requestId
        });
    } catch (error) {
        console.error("Register device token route error:", error);

        return res.status(400).json({
            success: false,
            error: error?.message || "Unable to register device token.",
            requestId: req.requestId
        });
    }
});

/*
|--------------------------------------------------------------------------
| Remove FCM device token
|--------------------------------------------------------------------------
*/
router.delete("/device-token", requireAuth, async (req, res) => {
    try {
        const token =
            req.body?.token ||
            req.query?.token ||
            null;

        const result = await removeDeviceToken(
            req.user.uid,
            token
        );

        return res.json({
            success: true,
            ...result,
            requestId: req.requestId
        });
    } catch (error) {
        console.error("Remove device token route error:", error);

        return res.status(400).json({
            success: false,
            error: error?.message || "Unable to remove device token.",
            requestId: req.requestId
        });
    }
});

module.exports = router;