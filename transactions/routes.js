// transactions/routes.js

const express = require("express");

const { requireAuth } = require("../auth");
const { db } = require("../firebase-admin");

const router = express.Router();


// =====================================================
// NOVAPAY TRANSACTION HISTORY API
// =====================================================
//
// ARCHITECTURE
//
// Firebase Authentication
//        ↓
// verified req.user.uid
//        ↓
// wallet/{uid}/ledger
//        ↓
// read-only transaction history
//
// IMPORTANT:
//
// - The frontend never supplies a UID.
// - The backend always uses req.user.uid.
// - The frontend cannot create financial transactions.
// - The frontend cannot modify financial transactions.
// - The wallet ledger contains completed balance changes.
// - Pending/failed payment attempts remain in deposits.
// - Money is always represented in kobo.
// - Pagination is cursor based.
// - Maximum page size is 50.
// =====================================================


// =====================================================
// CONFIGURATION
// =====================================================

const WALLETS_COLLECTION =
    "wallets";

const LEDGER_COLLECTION =
    "ledger";

const DEFAULT_PAGE_SIZE =
    20;

const MAX_PAGE_SIZE =
    50;


// =====================================================
// WALLET REFERENCE
// =====================================================

function getWalletRef(uid) {

    if (
        typeof uid !== "string" ||
        !uid.trim()
    ) {

        throw new Error(
            "Authenticated user ID is required."
        );

    }

    return db
        .collection(WALLETS_COLLECTION)
        .doc(uid);

}


// =====================================================
// LEDGER COLLECTION
// =====================================================

function getLedgerCollection(uid) {

    return getWalletRef(uid)
        .collection(LEDGER_COLLECTION);

}


// =====================================================
// PAGE SIZE
// =====================================================

function parseLimit(value) {

    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {

        return DEFAULT_PAGE_SIZE;

    }

    const limit =
        Number(value);

    if (
        !Number.isInteger(limit) ||
        limit < 1
    ) {

        return null;

    }

    return Math.min(
        limit,
        MAX_PAGE_SIZE
    );

}


// =====================================================
// TRANSACTION TYPE
// =====================================================

function normalizeTransactionType(
    value
) {

    const type =
        String(
            value || ""
        )
            .trim()
            .toLowerCase();

    if (!type) {

        return "unknown";

    }

    return type;

}


// =====================================================
// TRANSACTION DIRECTION
// =====================================================
//
// The ledger itself is the source of truth.
//
// Deposits/refunds/credits increase the wallet.
// Everything else in the current ledger is treated
// as a debit.
//
// Future wallet services should explicitly create
// debit/credit ledger records where appropriate.
// =====================================================

function getTransactionDirection(
    ledger
) {

    const explicitDirection =
        String(
            ledger.direction || ""
        )
            .trim()
            .toLowerCase();


    if (
        explicitDirection === "credit" ||
        explicitDirection === "debit"
    ) {

        return explicitDirection;

    }


    const type =
        normalizeTransactionType(
            ledger.type
        );


    if (
        type === "deposit" ||
        type === "refund" ||
        type === "credit" ||
        type === "wallet_deposit"
    ) {

        return "credit";

    }


    return "debit";

}


// =====================================================
// TRANSACTION STATUS
// =====================================================
//
// A wallet ledger record represents a completed balance
// change.
//
// Therefore an existing ledger record is successful.
//
// Pending/failed payment attempts are not placed into
// the wallet ledger because they have not changed the
// wallet balance.
// =====================================================

function getTransactionStatus(
    ledger
) {

    const status =
        String(
            ledger.status || ""
        )
            .trim()
            .toLowerCase();


    if (
        status === "pending" ||
        status === "failed" ||
        status === "successful" ||
        status === "reversed"
    ) {

        return status;

    }


    return "successful";

}


// =====================================================
// FIRESTORE TIMESTAMP
// =====================================================

function serializeTimestamp(
    timestamp
) {

    if (!timestamp) {

        return null;

    }


    if (
        typeof timestamp.toDate ===
        "function"
    ) {

        return timestamp
            .toDate()
            .toISOString();

    }


    if (
        timestamp instanceof Date
    ) {

        return timestamp.toISOString();

    }


    if (
        typeof timestamp === "string"
    ) {

        const date =
            new Date(timestamp);


        if (
            !Number.isNaN(
                date.getTime()
            )
        ) {

            return date.toISOString();

        }

    }


    return null;

}


// =====================================================
// SAFE INTEGER VALIDATION
// =====================================================

function validateMoneyValue(
    value,
    fieldName,
    allowZero = true
) {

    const number =
        Number(value);


    const valid =
        Number.isSafeInteger(
            number
        ) &&
        (
            allowZero
                ? number >= 0
                : number > 0
        );


    if (!valid) {

        throw new Error(
            `Ledger contains an invalid ${fieldName}.`
        );

    }


    return number;

}


// =====================================================
// SAFE TRANSACTION SERIALIZER
// =====================================================
//
// Only intentionally exposed fields are returned.
//
// Internal Firestore fields are never passed directly
// to the client.
// =====================================================

function serializeTransaction(
    snapshot
) {

    const ledger =
        snapshot.data();


    const amountKobo =
        validateMoneyValue(
            ledger.amountKobo,
            "transaction amount",
            false
        );


    const balanceBeforeKobo =
        validateMoneyValue(
            ledger.balanceBeforeKobo,
            "previous balance"
        );


    const balanceAfterKobo =
        validateMoneyValue(
            ledger.balanceAfterKobo,
            "resulting balance"
        );


    const createdAt =
        serializeTimestamp(
            ledger.createdAt
        );


    if (!createdAt) {

        throw new Error(
            "Ledger contains an invalid transaction date."
        );

    }


    const direction =
        getTransactionDirection(
            ledger
        );


    const status =
        getTransactionStatus(
            ledger
        );


    return {

        id:
            snapshot.id,

        reference:
            String(
                ledger.reference || ""
            ),

        type:
            normalizeTransactionType(
                ledger.type
            ),

        direction,

        status,

        amountKobo,

        currency:
            String(
                ledger.currency ||
                "NGN"
            )
                .trim()
                .toUpperCase(),

        balanceBeforeKobo,

        balanceAfterKobo,

        provider:
            ledger.provider
                ? String(
                    ledger.provider
                )
                : null,

        createdAt

    };

}


// =====================================================
// CURSOR ENCODING
// =====================================================
//
// Cursor contains:
//
// - createdAt
// - document ID
//
// UID is NEVER stored in or accepted from the cursor.
// =====================================================

function encodeCursor(
    createdAt,
    documentId
) {

    const date =
        createdAt instanceof Date
            ? createdAt
            : new Date(createdAt);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        throw new Error(
            "Unable to create transaction cursor."
        );

    }


    const payload = {

        createdAt:
            date.toISOString(),

        documentId:
            String(
                documentId
            )

    };


    return Buffer
        .from(
            JSON.stringify(
                payload
            ),
            "utf8"
        )
        .toString(
            "base64url"
        );

}


// =====================================================
// CURSOR DECODING
// =====================================================

function decodeCursor(
    cursor
) {

    if (
        cursor === undefined ||
        cursor === null ||
        cursor === ""
    ) {

        return null;

    }


    if (
        typeof cursor !== "string" ||
        cursor.length > 1000
    ) {

        throw new Error(
            "Invalid transaction cursor."
        );

    }


    let decoded;


    try {

        decoded =
            JSON.parse(
                Buffer
                    .from(
                        cursor,
                        "base64url"
                    )
                    .toString(
                        "utf8"
                    )
            );

    }

    catch {

        throw new Error(
            "Invalid transaction cursor."
        );

    }


    if (
        !decoded ||
        typeof decoded !== "object"
    ) {

        throw new Error(
            "Invalid transaction cursor."
        );

    }


    if (
        typeof decoded.createdAt !==
        "string" ||
        typeof decoded.documentId !==
        "string"
    ) {

        throw new Error(
            "Invalid transaction cursor."
        );

    }


    const createdAt =
        new Date(
            decoded.createdAt
        );


    if (
        Number.isNaN(
            createdAt.getTime()
        )
    ) {

        throw new Error(
            "Invalid transaction cursor date."
        );

    }


    if (
        !decoded.documentId ||
        decoded.documentId.length > 200
    ) {

        throw new Error(
            "Invalid transaction cursor document ID."
        );

    }


    return {

        createdAt,

        documentId:
            decoded.documentId

    };

}


// =====================================================
// GET TRANSACTION HISTORY
// =====================================================
//
// GET /api/transactions
//
// Query:
//
// ?limit=20
// ?cursor=<cursor>
//
// The authenticated Firebase UID determines which
// wallet ledger is queried.
// =====================================================

router.get(
    "/",
    requireAuth,
    async (req, res) => {

        try {

            const uid =
                req.user.uid;


            if (
                typeof uid !== "string" ||
                !uid.trim()
            ) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Authentication required.",

                    requestId:
                        req.requestId

                });

            }


            const limit =
                parseLimit(
                    req.query.limit
                );


            if (limit === null) {

                return res.status(400).json({

                    success: false,

                    error:
                        `Transaction limit must be between 1 and ${MAX_PAGE_SIZE}.`,

                    requestId:
                        req.requestId

                });

            }


            let cursor;


            try {

                cursor =
                    decodeCursor(
                        req.query.cursor
                    );

            }

            catch (cursorError) {

                return res.status(400).json({

                    success: false,

                    error:
                        cursorError.message,

                    requestId:
                        req.requestId

                });

            }


            const ledgerCollection =
                getLedgerCollection(
                    uid
                );


            let query =
                ledgerCollection
                    .orderBy(
                        "createdAt",
                        "desc"
                    )
                    .limit(
                        limit + 1
                    );


            if (cursor) {

                query =
                    ledgerCollection
                        .orderBy(
                            "createdAt",
                            "desc"
                        )
                        .startAfter(
                            cursor.createdAt
                        )
                        .limit(
                            limit + 1
                        );

            }


            const snapshot =
                await query.get();


            const documents =
                snapshot.docs;


            const hasMore =
                documents.length >
                limit;


            const pageDocuments =
                hasMore
                    ? documents.slice(
                        0,
                        limit
                    )
                    : documents;


            const transactions =
                pageDocuments.map(
                    serializeTransaction
                );


            let nextCursor =
                null;


            if (
                hasMore &&
                pageDocuments.length > 0
            ) {

                const lastDocument =
                    pageDocuments[
                        pageDocuments.length - 1
                    ];


                const lastCreatedAt =
                    lastDocument.get(
                        "createdAt"
                    );


                if (lastCreatedAt) {

                    nextCursor =
                        encodeCursor(
                            lastCreatedAt.toDate
                                ? lastCreatedAt.toDate()
                                : lastCreatedAt,
                            lastDocument.id
                        );

                }

            }


            return res.status(200).json({

                success: true,

                transactions,

                pagination: {

                    limit,

                    returned:
                        transactions.length,

                    hasMore,

                    nextCursor

                },

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay transaction history error:",
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
                    "Unable to retrieve transaction history.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// GET SINGLE TRANSACTION
// =====================================================
//
// GET /api/transactions/:id
//
// The authenticated user's wallet is ALWAYS used.
//
// =====================================================

router.get(
    "/:id",
    requireAuth,
    async (req, res) => {

        try {

            const uid =
                req.user.uid;


            if (
                typeof uid !== "string" ||
                !uid.trim()
            ) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Authentication required.",

                    requestId:
                        req.requestId

                });

            }


            const transactionId =
                String(
                    req.params.id || ""
                ).trim();


            if (
                !transactionId ||
                transactionId.length > 200 ||
                transactionId.includes("/") ||
                transactionId.includes("\\")
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid transaction ID.",

                    requestId:
                        req.requestId

                });

            }


            const ledgerRef =
                getLedgerCollection(
                    uid
                ).doc(
                    transactionId
                );


            const snapshot =
                await ledgerRef.get();


            if (
                !snapshot.exists
            ) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Transaction not found.",

                    requestId:
                        req.requestId

                });

            }


            const transaction =
                serializeTransaction(
                    snapshot
                );


            return res.status(200).json({

                success: true,

                transaction,

                requestId:
                    req.requestId

            });

        }

        catch (error) {

            console.error(
                "NovaPay transaction detail error:",
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
                    "Unable to retrieve transaction.",

                requestId:
                    req.requestId

            });

        }

    }
);


// =====================================================
// FINANCIAL WRITE PROTECTION
// =====================================================
//
// There are intentionally NO client transaction-write
// endpoints.
//
// POST   /api/transactions
// PUT    /api/transactions/:id
// PATCH  /api/transactions/:id
// DELETE /api/transactions/:id
//
// These operations must only happen through controlled
// backend payment/wallet services.
// =====================================================


module.exports = router;