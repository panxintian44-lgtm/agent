"use strict";

// CNY has two decimal places. Keep all arithmetic in integer minor units.
const MAX_MINOR = 1_000_000_000_000;
const SAFE_MINOR = Number.MAX_SAFE_INTEGER;

class MoneyAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MoneyAdapterError";
    this.code = code;
  }
}

function fail(code, message) { throw new MoneyAdapterError(code, message); }

function settings(options) {
  if (!options || typeof options !== "object" || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => key !== "allowNegative" && key !== "maxMinor")) {
    fail("INVALID_MONEY_OPTIONS", "Money options must contain only allowNegative and maxMinor.");
  }
  if (options.allowNegative !== undefined && typeof options.allowNegative !== "boolean") {
    fail("INVALID_MONEY_OPTIONS", "allowNegative must be a boolean.");
  }
  const maxMinor = options.maxMinor === undefined ? MAX_MINOR : options.maxMinor;
  if (!Number.isSafeInteger(maxMinor) || maxMinor < 0) {
    fail("INVALID_MONEY_OPTIONS", "maxMinor must be a nonnegative safe integer.");
  }
  return { allowNegative: options.allowNegative === true, maxMinor: BigInt(maxMinor) };
}

function bounded(minor, options) {
  if (!options.allowNegative && minor < 0n) fail("NEGATIVE_AMOUNT_NOT_ALLOWED", "Negative money requires allowNegative=true.");
  const absolute = minor < 0n ? -minor : minor;
  if (absolute > options.maxMinor || absolute > BigInt(SAFE_MINOR)) fail("AMOUNT_OUT_OF_RANGE", "Amount exceeds the supported minor-unit range.");
  // Normalize negative zero before returning JSON-compatible values.
  return minor === 0n ? 0 : Number(minor);
}

function yuanToMinor(value, options = {}) {
  const config = settings(options);
  if (value === null) return null;
  if (typeof value !== "number" && typeof value !== "string") fail("INVALID_AMOUNT", "Yuan must be a decimal string, a finite number, or null.");
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > SAFE_MINOR || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    fail("INVALID_AMOUNT", "Yuan must not be non-finite or an unsafe number.");
  }
  const decimal = typeof value === "string" ? value : String(value);
  if (decimal.length > 64) fail("AMOUNT_TEXT_TOO_LONG", "Yuan text exceeds the 64-character technical input limit.");
  // Do not trim, remove separators, expand scientific notation, or round input.
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) fail("INVALID_AMOUNT", "Yuan must use plain decimal notation without spaces or separators.");
  if ((match[3] || "").length > 2) fail("INVALID_AMOUNT_PRECISION", "Yuan accepts at most two decimal places; rounding is not implicit.");
  const minor = BigInt(match[2]) * 100n + BigInt((match[3] || "").padEnd(2, "0"));
  return bounded(match[1] ? -minor : minor, config);
}

function minorToYuan(value, options = {}) {
  const config = settings(options);
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) fail("INVALID_AMOUNT", "Minor units must be a safe integer number or null.");
  const checked = bounded(BigInt(value), config), negative = checked < 0;
  const absolute = negative ? -BigInt(checked) : BigInt(checked);
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function minorToYuanNumber(value, options = {}) {
  const decimal = minorToYuan(value, options);
  if (decimal === null) return null;
  const numeric = Number(decimal);
  let roundtrip;
  try { roundtrip = yuanToMinor(numeric, options); }
  catch { fail("AMOUNT_NUMBER_PRECISION_LOSS", "The existing numeric yuan field cannot preserve this minor-unit amount; retain the exact decimal string."); }
  if (roundtrip !== value) fail("AMOUNT_NUMBER_PRECISION_LOSS", "The existing numeric yuan field cannot preserve this minor-unit amount; retain the exact decimal string.");
  return Object.is(numeric, -0) ? 0 : numeric;
}

function normalizeMoney(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Reflect.ownKeys(input).length !== 3 ||
      Reflect.ownKeys(input).some(key => !["amount", "unit", "currency"].includes(key)) ||
      !["amount", "unit", "currency"].every(key => Object.hasOwn(input, key))) {
    fail("INVALID_MONEY_ENVELOPE", "Money requires exactly amount, unit, and currency.");
  }
  if (input.currency !== "CNY") fail("UNSUPPORTED_CURRENCY", "This adapter supports CNY only.");
  if (!["YUAN", "MINOR"].includes(input.unit)) fail("UNSUPPORTED_AMOUNT_UNIT", "Money unit must explicitly be YUAN or MINOR.");
  let minor;
  if (input.unit === "YUAN") minor = yuanToMinor(input.amount, options);
  else {
    // Reuse validation; an already normalized amount must never be multiplied again.
    minorToYuan(input.amount, options);
    minor = input.amount === null ? null : Object.is(input.amount, -0) ? 0 : input.amount;
  }
  return { currency: "CNY", unit: "MINOR", amount_minor: minor, source_unit: input.unit };
}

module.exports = { MoneyAdapterError, yuanToMinor, minorToYuan, minorToYuanNumber, normalizeMoney, MAX_MINOR };
