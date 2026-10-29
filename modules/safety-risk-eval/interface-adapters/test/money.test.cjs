"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MoneyAdapterError, yuanToMinor, minorToYuan, minorToYuanNumber, normalizeMoney, MAX_MINOR } = require("../money.cjs");
const error = code => value => value instanceof MoneyAdapterError && value.code === code;

for (const [yuan, minor] of [[0, 0], [0.01, 1], [0.1, 10], [1.23, 123], [12000, 1200000], ["0", 0], ["0.00", 0], ["0001.20", 120], ["2000.01", 200001], ["10000000000.00", MAX_MINOR], [null, null]]) {
  test(`yuan conversion preserves ${JSON.stringify(yuan)}`, () => assert.equal(yuanToMinor(yuan), minor));
}

for (const value of [undefined, true, false, "", " ", " 1.00", "1.00 ", "1,000", "1e3", "+1", ".50", "1.", {}, [], NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid yuan is rejected: ${String(value)}`, () => assert.throws(() => yuanToMinor(value), error("INVALID_AMOUNT")));
}

for (const value of ["1.005", 1.005, 0.30000000000000004, "1.000", "0.000", "0.001", 0.001]) {
  test(`excess decimal precision is never rounded: ${String(value)}`, () => assert.throws(() => yuanToMinor(value), error("INVALID_AMOUNT_PRECISION")));
}

test("negative values require explicit permission and negative zero becomes zero", () => {
  assert.throws(() => yuanToMinor("-0.01"), error("NEGATIVE_AMOUNT_NOT_ALLOWED"));
  assert.throws(() => minorToYuan(-1), error("NEGATIVE_AMOUNT_NOT_ALLOWED"));
  assert.equal(yuanToMinor("-12.34", { allowNegative: true }), -1234);
  assert.equal(minorToYuan(-1234, { allowNegative: true }), "-12.34");
  assert.equal(Object.is(yuanToMinor("-0.00"), -0), false);
  assert.equal(minorToYuan(-0), "0.00");
});

test("unbounded decimal strings fail before BigInt conversion", () => {
  assert.equal(yuanToMinor("0".repeat(63) + "1"), 100);
  assert.throws(() => yuanToMinor("0".repeat(64) + "1"), error("AMOUNT_TEXT_TOO_LONG"));
  assert.throws(() => yuanToMinor("9".repeat(10000)), error("AMOUNT_TEXT_TOO_LONG"));
});

test("default and custom limits include the boundary and reject one minor unit more", () => {
  assert.equal(yuanToMinor("10000000000.00"), MAX_MINOR);
  assert.throws(() => yuanToMinor("10000000000.01"), error("AMOUNT_OUT_OF_RANGE"));
  assert.throws(() => minorToYuan(MAX_MINOR + 1), error("AMOUNT_OUT_OF_RANGE"));
  assert.equal(yuanToMinor("0.00", { maxMinor: 0 }), 0);
  assert.throws(() => yuanToMinor("0.01", { maxMinor: 0 }), error("AMOUNT_OUT_OF_RANGE"));
  assert.equal(yuanToMinor("1.23", { maxMinor: 123 }), 123);
  assert.throws(() => yuanToMinor("1.24", { maxMinor: 123 }), error("AMOUNT_OUT_OF_RANGE"));
  assert.throws(() => yuanToMinor("-1.24", { maxMinor: 123, allowNegative: true }), error("AMOUNT_OUT_OF_RANGE"));
});

test("exact decimal formatting uses integer arithmetic through safe integer limits", () => {
  for (const [minor, yuan] of [[0, "0.00"], [1, "0.01"], [10, "0.10"], [100, "1.00"], [123, "1.23"], [MAX_MINOR, "10000000000.00"], [null, null]]) assert.equal(minorToYuan(minor), yuan);
  assert.equal(minorToYuan(Number.MAX_SAFE_INTEGER, { maxMinor: Number.MAX_SAFE_INTEGER }), "90071992547409.91");
  assert.equal(yuanToMinor("90071992547409.91", { maxMinor: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER);
  assert.throws(() => yuanToMinor("90071992547409.92", { maxMinor: Number.MAX_SAFE_INTEGER }), error("AMOUNT_OUT_OF_RANGE"));
  for (const value of [1.1, "100", undefined, true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => minorToYuan(value), error("INVALID_AMOUNT"));
});

test("options reject misspellings, unsafe ranges and non-boolean permissions", () => {
  for (const options of [null, [], { round: true }, { allowNegative: "true" }, { maxMinor: -1 }, { maxMinor: 1.2 }, { maxMinor: Infinity }, { maxMinor: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => yuanToMinor("1", options), error("INVALID_MONEY_OPTIONS"));
  assert.throws(() => yuanToMinor(null, { round: true }), error("INVALID_MONEY_OPTIONS"));
});

test("explicit units prevent double scaling and preserve unknown values", () => {
  assert.deepEqual(normalizeMoney({ amount: "1.23", unit: "YUAN", currency: "CNY" }), { amount_minor: 123, unit: "MINOR", currency: "CNY", source_unit: "YUAN" });
  assert.deepEqual(normalizeMoney({ amount: 123, unit: "MINOR", currency: "CNY" }), { amount_minor: 123, unit: "MINOR", currency: "CNY", source_unit: "MINOR" });
  for (const unit of ["YUAN", "MINOR"]) assert.equal(normalizeMoney({ amount: null, unit, currency: "CNY" }).amount_minor, null);
  assert.throws(() => normalizeMoney({ amount: "123", unit: "MINOR", currency: "CNY" }), error("INVALID_AMOUNT"));
  assert.throws(() => normalizeMoney({ amount: 1.23, unit: "MINOR", currency: "CNY" }), error("INVALID_AMOUNT"));
});

test("money envelopes reject implicit units, unsupported currencies and extra fields", () => {
  for (const input of [null, [], { amount: 1, currency: "CNY" }, { amount: 1, unit: "YUAN", currency: "CNY", approved: true }, Object.create({ amount: 1, unit: "YUAN", currency: "CNY" })]) assert.throws(() => normalizeMoney(input), error("INVALID_MONEY_ENVELOPE"));
  assert.throws(() => normalizeMoney({ amount: 1, unit: "YUAN", currency: "USD" }), error("UNSUPPORTED_CURRENCY"));
  assert.throws(() => normalizeMoney({ amount: 1, unit: "yuan", currency: "CNY" }), error("UNSUPPORTED_AMOUNT_UNIT"));
});

test("exact strings and legacy JSON numeric fields roundtrip through normal and maximum amounts", () => {
  for (const minor of [0, 1, 10, 29, 123, 199999, 1200000, MAX_MINOR - 1, MAX_MINOR]) {
    assert.equal(yuanToMinor(minorToYuan(minor)), minor);
    const numeric = minorToYuanNumber(minor);
    assert.equal(typeof numeric, "number");
    assert.equal(yuanToMinor(JSON.parse(JSON.stringify(numeric))), minor);
  }
  assert.equal(minorToYuanNumber(null), null);
  assert.equal(minorToYuanNumber(-123, { allowNegative: true }), -1.23);
});

test("legacy number conversion fails explicitly when safe integer minor units lose precision in yuan", () => {
  const options = { maxMinor: Number.MAX_SAFE_INTEGER };
  assert.throws(() => minorToYuanNumber(Number.MAX_SAFE_INTEGER, options), error("AMOUNT_NUMBER_PRECISION_LOSS"));
  assert.equal(minorToYuanNumber(9007199254740900, options), 90071992547409);
});
