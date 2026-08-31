/* =========================================================
   NOVAPAY — NOTIFICATION ROUTES
   ---------------------------------------------------------
   Responsibilities:
   - Return authenticated user's notifications
   - Return unread notification count
   - Mark one notification as read
   - Mark all notifications as read
   - Register authenticated user's FCM device token
   - Remove authenticated user's FCM device token
   -
   IMPORTANT:
   - User identity ALWAYS comes from Firebase Auth
   - Client cannot choose another user's userId
   - Notification creation is NOT exposed to browsers
   - Backend-only notification creation stays in service.js
   ========================================================= */

const express = require("express");

const {
    requireAuth
} = require("../auth");

const {
    getUserNotifications,
    getUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,
    registerDeviceToken,
    removeDeviceToken
} = require("./service");


const router =
    express.Router();


/* =========================================================
   GET USER NOTIFICATIONS
   ========================================================= */

router.get(
    "/",
    requireAuth,
    async (req, res) => {

        try {

            const userId =
                req.user.uid;


            const limit =
                req.query.limit;


            const cursor =
                req.query.cursor ||
                null;


            const result =
                await getUserNotifications(
                    userId,
                    {
                        limit,
                        cursor
                    }
                );


            return res.status(200).json({

                success:
                    true,

                notifications:
                    result.notifications,

                pagination:
                    result.pagination,

                requestId:
                    req.requestId

            });

        } catch (error) {

            console.error(
                "NovaPay notification retrieval error:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                error:
                    "Unable to load notifications.",

                requestId:
                    req.requestId

            });

        }

    }
);


/* =========================================================
   GET UNREAD COUNT
   ========================================================= */

router.get(
    "/unread-count",
    requireAuth,
    async (req, res) => {

        try {

            const userId =
                req.user.uid;


            const count =
                await getUnreadCount(
                    userId
                );


            return res.status(200).json({

                success:
                    true,

                unreadCount:
                    count,

                requestId:
                    req.requestId

            });

        } catch (error) {

            console.error(
                "NovaPay unread notification count error:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                error:
                    "Unable to load notification status.",

                requestId:
                    req.requestId

            });

        }

    }
);


/* =========================================================
   MARK ALL AS READ
   ---------------------------------------------------------
   This route uses the authenticated Firebase UID.
   The browser cannot specify another user's UID.
   ========================================================= */

router.patch(
    "/read-all",
    requireAuth,
    async (req, res) => {

        try {

            const userId =
                req.user.uid;


            const updatedCount =
                await markAllNotificationsRead(
                    userId
                );


            return res.status(200).json({

                success:
                    true,

                updatedCount,

                requestId:
                    req.requestId

            });

        } catch (error) {

            console.error(
                "NovaPay mark-all-notifications-read error:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                error:
                    "Unable to update notifications.",

                requestId:
                    req.requestId

            });

        }

    }
);


/* =========================================================
   MARK ONE NOTIFICATION AS READ
   ========================================================= */

router.patch(
    "/:notificationId/read",
    requireAuth,
    async (req, res) => {

        try {

            const userId =
                req.user.uid;


            const notificationId =
                String(
                    req.params.notificationId ||
                    ""
                ).trim();


            if (!notificationId) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Notification could not be identified.",

                    requestId:
                        req.requestId

                });

            }


            const result =
                await markNotificationRead(
                    userId,
                    notificationId
                );


            if (
                result.found !== true
            ) {

                /*
                 * Do not reveal whether another user's
                 * notification exists.
                 */
                return res.status(404).json({

                    success:
                        false,

                    error:
                        "Notification not found.",

                    requestId:
                        req.requestId

                });

            }


            return res.status(200).json({

                success:
                    true,

                requestId:
                    req.requestId

            });

        } catch (error) {

            console.error(
                "NovaPay mark-notification-read error:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                error:
                    "Unable to update notification.",

                requestId:
                    req.requestId

            });

        }

    }
);


/* =========================================================
   REGISTER FCM DEVICE TOKEN
   ---------------------------------------------------------
   The browser supplies only the token and platform.
   The authenticated UID comes from Firebase Auth.
   ========================================================= */

router.post(
    "/device-token",
    requireAuth,
    async (req, res) => {

        try {

            const userId =
                req.user.uid;


            const token =
                String(
                    req.body?.token ||
                    ""
                ).trim();


            const platform =
                String(
                    req.body?.platform ||
                    "unknown"
                ).trim();


            if (!token) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Device notification registration could not be completed.",

                    requestId:
                        req.requestId

                });

            }


            const result =
                await registerDeviceToken(
                    userId,
                    token,
                    platform
                );


            return res.status(200).json({

                success:
                    true,

                tokenId:
                    result.tokenId,

                requestId:
                    req.requestId

            });

        } catch (error) {

            console.error(
                "NovaPay device token registration error:",
                error
            );


            return res.status(400).json({

                success:
                    false,

                error:
                    "Unable to register this device for notifications.",

                requestId:
                    req.requestId

            });

        }

    }
);


/* =========================================================
   REMOVE FCM DEVICE TOKEN
   ---------------------------------------------------------
   Only removes a token belonging to the authenticated user.
   ========================================================= */

router.delete(
    "/device-token",
    requireAuth,
    async (req, res) => {

        try {

            const userId =
                req.user.uid;


            const token =
                String(
                    req.body?.token ||
                    ""
                ).trim();


            if (!token) {

                return res.status(400).json({

                    success:
                        false,

                    error:
                        "Device notification registration could not be removed.",

                    requestId:
                        req.requestId

                });

            }


            await removeDeviceToken(
                userId,
                token
            );


            /*
             * Return a generic success response.
             * We do not expose whether the token existed.
             */
            return res.status(200).json({

                success:
                    true,

                requestId:
                    req.requestId

            });

        } catch (error) {

            console.error(
                "NovaPay device token removal error:",
                error
            );


            return res.status(500).json({

                success:
                    false,

                error:
                    "Unable to update notification settings.",

                requestId:
                    req.requestId

            });

        }

    }
);


/* =========================================================
   EXPORT ROUTER
   ========================================================= */

module.exports =
    router;