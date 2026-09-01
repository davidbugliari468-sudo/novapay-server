// airtime/index.js

const router =
    require("./routes");


// =====================================================
// NOVAPAY — AIRTIME MODULE
// =====================================================
//
// RESPONSIBILITY
//
// This file is the entry point for the Airtime backend
// module.
//
// Architecture:
//
// Main application
//       ↓
// airtime/index.js
//       ↓
// airtime/routes.js
//       ↓
// airtime/service.js
//       ↓
// wallet/reservation.js
//       ↓
// airtime/vtu.js
//       ↓
// VTU.ng
//
// IMPORTANT
//
// This file MUST NOT:
//
// - authenticate users itself
// - validate Airtime requests itself
// - modify wallet balances
// - create reservations
// - commit reservations
// - release reservations
// - call VTU.ng directly
// - contain provider credentials
// - decide transaction status
//
// Those responsibilities belong to their respective
// layers.
//
// Keeping this file thin prevents the module entry point
// from becoming another business-logic layer.
//
// =====================================================


// =====================================================
// ROUTER EXPORT
// =====================================================
//
// The main application can mount this module:
//
//     app.use("/airtime", airtime);
//
// Therefore:
//
//     POST /airtime/purchase
//     GET  /airtime/transaction/:transactionId
//
// are handled by airtime/routes.js.
//
// =====================================================

module.exports =
    router;