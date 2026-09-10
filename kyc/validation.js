"use strict";

const { z } = require("zod");

const ninSchema = z
  .string()
  .trim()
  .regex(/^\d{11}$/, "NIN must contain exactly 11 digits.");

const bvnSchema = z
  .string()
  .trim()
  .regex(/^\d{11}$/, "BVN must contain exactly 11 digits.");

const slipTypeSchema = z.enum([
  "info",
  "regular",
  "standard",
  "premium",
]);

function validateNIN(nin) {
  return ninSchema.safeParse(nin);
}

function validateBVN(bvn) {
  return bvnSchema.safeParse(bvn);
}

function validateSlipType(slipType) {
  return slipTypeSchema.safeParse(slipType);
}

function maskIdentifier(value) {
  if (typeof value !== "string" || value.length < 4) {
    return "****";
  }

  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

function normalizeNIN(nin) {
  if (typeof nin !== "string") {
    return null;
  }

  const normalized = nin.trim();

  return /^\d{11}$/.test(normalized) ? normalized : null;
}

function normalizeBVN(bvn) {
  if (typeof bvn !== "string") {
    return null;
  }

  const normalized = bvn.trim();

  return /^\d{11}$/.test(normalized) ? normalized : null;
}

function getNINSlipFee(slipType) {
  const fees = {
    info: 20000,
    regular: 20000,
    standard: 35000,
    premium: 35000,
  };

  return fees[slipType] ?? null;
}

module.exports = {
  validateNIN,
  validateBVN,
  validateSlipType,
  normalizeNIN,
  normalizeBVN,
  maskIdentifier,
  getNINSlipFee,
};