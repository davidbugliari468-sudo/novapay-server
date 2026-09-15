// transactions/routes.js

const express = require("express");

const { requireAuth } = require("../auth");
const { db } = require("../firebase-admin");

const router = express.Router();


// =====================================================
// NOVAPAY TRANSACTION HISTORY API
// =====================================================
//
// Firebase Authentication
//        ↓
// verified req.user.uid
//        ↓
// wallet/{uid}/ledger
// airtimeTransactions
// dataTransactions
//        ↓
// read-only transaction history
//
// IMPORTANT:
//
// - The frontend never supplies a UID.
// - The backend always uses req.user.uid.
// - The frontend cannot create financial transactions.
// - The frontend cannot modify financial transactions.
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

const AIRTIME_TRANSACTIONS_COLLECTION =
    "airtimeTransactions";

const DATA_TRANSACTIONS_COLLECTION =
    "dataTransactions";

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
// SERVICE TRANSACTION STATUS
// =====================================================

function normalizeServiceStatus(
    value
) {

    const status =
        String(
            value || ""
        )
            .trim()
            .toLowerCase();


    if (
        status === "successful" ||
        status === "success" ||
        status === "completed" ||
        status === "complete" ||
        status === "paid"
    ) {

        return "successful";

    }


    if (
        status === "failed" ||
        status === "fail" ||
        status === "cancelled" ||
        status === "canceled"
    ) {

        return "failed";

    }


    if (
        status === "reversed"
    ) {

        return "reversed";

    }


    if (
        status === "pending" ||
        status === "unknown"
    ) {

        return "pending";

    }


    return "pending";

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
            `Transaction contains an invalid ${fieldName}.`
        );

    }


    return number;

}


// =====================================================
// SAFE MONEY VALUE
// =====================================================

function getSafeMoneyValue(
    value
) {

    const number =
        Number(value);


    if (
        Number.isSafeInteger(number) &&
        number >= 0
    ) {

        return number;

    }


    return null;

}


// =====================================================
// SAFE STRING
// =====================================================

function safeString(
    value
) {

    if (
        value === undefined ||
        value === null
    ) {

        return "";

    }

    return String(value).trim();

}


// =====================================================
// LEDGER TRANSACTION SERIALIZER
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

        direction:
            getTransactionDirection(
                ledger
            ),

        status:
            getTransactionStatus(
                ledger
            ),

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

        createdAt,

        _source:
            "ledger"

    };

}


// =====================================================
// SERVICE TRANSACTION SERIALIZER
// =====================================================

function serializeServiceTransaction(
    snapshot,
    service
) {

    const transaction =
        snapshot.data();


    if (
        String(
            transaction.uid || ""
        ) !==
        String(
            transaction._uid || ""
        )
    ) {

        // UID verification is performed by the caller.
        // This block intentionally does nothing.
    }


    const createdAt =
        serializeTimestamp(
            transaction.createdAt
        );


    if (!createdAt) {

        return null;

    }


    let amountKobo =
        getSafeMoneyValue(
            transaction.amountKobo
        );


    if (
        amountKobo === null
    ) {

        amountKobo =
            getSafeMoneyValue(
                transaction.customerPriceKobo
            );

    }


    if (
        amountKobo === null
    ) {

        amountKobo =
            getSafeMoneyValue(
                transaction.amount
            );

    }


    if (
        amountKobo === null
    ) {

        return null;

    }


    let reference =
        safeString(
            transaction.reference
        );


    if (!reference) {

        reference =
            safeString(
                transaction.transactionId
            );

    }


    if (!reference) {

        reference =
            snapshot.id;

    }


    return {

        id:
            snapshot.id,

        reference,

        type:
            service,

        direction:
            "debit",

        status:
            normalizeServiceStatus(
                transaction.status
            ),

        amountKobo,

        currency:
            String(
                transaction.currency ||
                "NGN"
            )
                .trim()
                .toUpperCase(),

        balanceBeforeKobo:
            getSafeMoneyValue(
                transaction.balanceBeforeKobo
            ),

        balanceAfterKobo:
            getSafeMoneyValue(
                transaction.balanceAfterKobo
            ),

        provider:
            transaction.provider
                ? String(
                    transaction.provider
                )
                : (
                    service === "airtime"
                        ? "vtu.ng"
                        : "babspay"
                ),

        createdAt,

        _source:
            service

    };

}


// =====================================================
// CURSOR ENCODING
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
// READ SERVICE TRANSACTIONS
// =====================================================
//
// IMPORTANT:
//
// These queries intentionally use only:
//
// where("uid", "==", uid)
//
// They do NOT combine where() with orderBy().
// This avoids introducing a new Firestore composite
// index requirement.
// =====================================================

async function readServiceTransactions(
    collectionName,
    uid
) {

    const snapshot =
        await db
            .collection(
                collectionName
            )
            .where(
                "uid",
                "==",
                uid
            )
            .get();


    return snapshot.docs;

}


// =====================================================
// TRANSACTION SORT
// =====================================================

function sortTransactions(
    transactions
) {

    return transactions.sort(
        (
            first,
            second
        ) => {

            const firstTime =
                new Date(
                    first.createdAt
                ).getTime();

            const secondTime =
                new Date(
                    second.createdAt
                ).getTime();


            if (
                secondTime !==
                firstTime
            ) {

                return (
                    secondTime -
                    firstTime
                );

            }


            return String(
                second.id
            ).localeCompare(
                String(
                    first.id
                )
            );

        }
    );

}


// =====================================================
// TRANSACTION IDENTITY
// =====================================================

function transactionIdentity(
    transaction
) {

    const reference =
        safeString(
            transaction.reference
        )
            .toLowerCase();


    if (reference) {

        return `reference:${reference}`;

    }


    return `id:${safeString(
        transaction.id
    ).toLowerCase()}`;

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


            // -------------------------------------------------
            // KEEP THE ORIGINAL LEDGER QUERY STRUCTURE
            // -------------------------------------------------

            const ledgerCollection =
                getLedgerCollection(
                    uid
                );


            let ledgerQuery =
                ledgerCollection
                    .orderBy(
                        "createdAt",
                        "desc"
                    )
                    .limit(
                        limit + 1
                    );


            if (cursor) {

                ledgerQuery =
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


            const [
                ledgerSnapshot,
                airtimeDocuments,
                dataDocuments
            ] =
                await Promise.all([

                    ledgerQuery.get(),

                    readServiceTransactions(
                        AIRTIME_TRANSACTIONS_COLLECTION,
                        uid
                    ),

                    readServiceTransactions(
                        DATA_TRANSACTIONS_COLLECTION,
                        uid
                    )

                ]);


            const transactions = [];


            // -------------------------------------------------
            // LEDGER
            // -------------------------------------------------

            for (
                const document
                of ledgerSnapshot.docs
            ) {

                try {

                    transactions.push(
                        serializeTransaction(
                            document
                        )
                    );

                }

                catch {

                    // Preserve existing behavior of allowing
                    // the rest of transaction history to load.
                    continue;

                }

            }


            // -------------------------------------------------
            // AIRTIME
            // -------------------------------------------------

            for (
                const document
                of airtimeDocuments
            ) {

                const data =
                    document.data();


                if (
                    String(
                        data.uid || ""
                    ) !== uid
                ) {

                    continue;

                }


                const transaction =
                    serializeServiceTransaction(
                        document,
                        "airtime"
                    );


                if (transaction) {

                    transactions.push(
                        transaction
                    );

                }

            }


            // -------------------------------------------------
            // DATA
            // -------------------------------------------------

            for (
                const document
                of dataDocuments
            ) {

                const data =
                    document.data();


                if (
                    String(
                        data.uid || ""
                    ) !== uid
                ) {

                    continue;

                }


                const transaction =
                    serializeServiceTransaction(
                        document,
                        "data"
                    );


                if (transaction) {

                    transactions.push(
                        transaction
                    );

                }

            }


            // -------------------------------------------------
            // SORT ALL TRANSACTIONS
            // -------------------------------------------------

            sortTransactions(
                transactions
            );


            // -------------------------------------------------
            // REMOVE DUPLICATES
            //
            // A successful transaction can exist in both
            // the service collection and wallet ledger.
            // Keep the wallet ledger copy when both exist.
            // -------------------------------------------------

            const uniqueTransactions =
                [];

            const seenReferences =
                new Map();


            for (
                const transaction
                of transactions
            ) {

                const identity =
                    transactionIdentity(
                        transaction
                    );


                const existingIndex =
                    seenReferences.get(
                        identity
                    );


                if (
                    existingIndex === undefined
                ) {

                    seenReferences.set(
                        identity,
                        uniqueTransactions.length
                    );

                    uniqueTransactions.push(
                        transaction
                    );

                    continue;

                }


                const existing =
                    uniqueTransactions[
                        existingIndex
                    ];


                if (
                    existing._source !==
                    "ledger" &&
                    transaction._source ===
                    "ledger"
                ) {

                    uniqueTransactions[
                        existingIndex
                    ] =
                        transaction;

                }

            }


            // -------------------------------------------------
            // APPLY CURSOR
            // -------------------------------------------------

            const filteredTransactions =
                uniqueTransactions.filter(
                    (
                        transaction
                    ) => {

                        if (!cursor) {

                            return true;

                        }


                        const transactionTime =
                            new Date(
                                transaction.createdAt
                            ).getTime();


                        const cursorTime =
                            cursor.createdAt.getTime();


                        if (
                            transactionTime <
                            cursorTime
                        ) {

                            return true;

                        }


                        if (
                            transactionTime >
                            cursorTime
                        ) {

                            return false;

                        }


                        return String(
                            transaction.id
                        ) <
                        String(
                            cursor.documentId
                        );

                    }
                );


            const hasMore =
                filteredTransactions.length >
                limit;


            const pageTransactions =
                hasMore
                    ? filteredTransactions.slice(
                        0,
                        limit
                    )
                    : filteredTransactions;


            // -------------------------------------------------
            // NEXT CURSOR
            // -------------------------------------------------

            let nextCursor =
                null;


            if (
                hasMore &&
                pageTransactions.length > 0
            ) {

                const lastTransaction =
                    pageTransactions[
                        pageTransactions.length - 1
                    ];


                nextCursor =
                    encodeCursor(
                        lastTransaction.createdAt,
                        lastTransaction.id
                    );

            }


            // -------------------------------------------------
            // REMOVE INTERNAL SOURCE FIELD
            // -------------------------------------------------

            const cleanTransactions =
                pageTransactions.map(
                    (
                        transaction
                    ) => {

                        const clean =
                            {
                                ...transaction
                            };


                        delete clean._source;


                        return clean;

                    }
                );


            return res.status(200).json({

                success: true,

                transactions:
                    cleanTransactions,

                pagination: {

                    limit,

                    returned:
                        cleanTransactions.length,

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
// The authenticated user's records are ALWAYS used.
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


            // -------------------------------------------------
            // LEDGER
            // -------------------------------------------------

            const ledgerRef =
                getLedgerCollection(
                    uid
                ).doc(
                    transactionId
                );


            const ledgerSnapshot =
                await ledgerRef.get();


            if (
                ledgerSnapshot.exists
            ) {

                const transaction =
                    serializeTransaction(
                        ledgerSnapshot
                    );


                delete transaction._source;


                return res.status(200).json({

                    success: true,

                    transaction,

                    requestId:
                        req.requestId

                });

            }


            // -------------------------------------------------
            // AIRTIME
            // -------------------------------------------------

            const airtimeRef =
                db
                    .collection(
                        AIRTIME_TRANSACTIONS_COLLECTION
                    )
                    .doc(
                        transactionId
                    );


            const airtimeSnapshot =
                await airtimeRef.get();


            if (
                airtimeSnapshot.exists
            ) {

                const airtime =
                    airtimeSnapshot.data();


                if (
                    String(
                        airtime.uid || ""
                    ) !== uid
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
                    serializeServiceTransaction(
                        airtimeSnapshot,
                        "airtime"
                    );


                if (!transaction) {

                    return res.status(500).json({

                        success: false,

                        error:
                            "Unable to retrieve transaction.",

                        requestId:
                            req.requestId

                    });

                }


                delete transaction._source;


                return res.status(200).json({

                    success: true,

                    transaction,

                    requestId:
                        req.requestId

                });

            }


            // -------------------------------------------------
            // DATA
            // -------------------------------------------------

            const dataRef =
                db
                    .collection(
                        DATA_TRANSACTIONS_COLLECTION
                    )
                    .doc(
                        transactionId
                    );


            const dataSnapshot =
                await dataRef.get();


            if (
                dataSnapshot.exists
            ) {

                const data =
                    dataSnapshot.data();


                if (
                    String(
                        data.uid || ""
                    ) !== uid
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
                    serializeServiceTransaction(
                        dataSnapshot,
                        "data"
                    );


                if (!transaction) {

                    return res.status(500).json({

                        success: false,

                        error:
                            "Unable to retrieve transaction.",

                        requestId:
                            req.requestId

                    });

                }


                delete transaction._source;


                return res.status(200).json({

                    success: true,

                    transaction,

                    requestId:
                        req.requestId

                });

            }


            return res.status(404).json({

                success: false,

                error:
                    "Transaction not found.",

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