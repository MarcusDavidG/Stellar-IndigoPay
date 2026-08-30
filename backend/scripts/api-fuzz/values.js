"use strict";

/**
 * values.js — schema-aware request-value generation for API fuzzing (#1101 WS4).
 *
 * Two families of value producers:
 *   - `generateValidValue(schema, components)`: produces a payload that *satisfies*
 *     the schema (correct types, in-range, enums, patterns, lengths, nested
 *     objects/arrays, required fields present). Used both to sanity-check the
 *     generator and to seed realistic traffic.
 *   - `mutationStrategies`: each returns a *schema-violating* value — wrong type,
 *     over-length strings, out-of-range numbers, enum violations, missing
 *     required fields, extra unknown fields, SQL-injection strings, and Unicode
 *     homoglyphs. Feeding these to the live conformance scan verifies the "no 5xx
 *     on invalid input — only 4xx" acceptance criterion.
 *
 * Depends only on Node built-ins (must stay dependency-free so it can run both in
 * the backend jest suite and from the repo-root validate-openapi.js wrapper).
 */

// ── RNG (deterministic under a per-run seed for reproducibility) ─────────────

const rngState = { seed: 0x2dfc6f3d };

function hashSeed(x) {
  let h = (x ^ 0xdeadbeef) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function reset(seed = Date.now()) {
  rngState.seed = hashSeed(seed >>> 0);
}

function nextUint() {
  // xorshift32
  let x = rngState.seed;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;
  x >>>= 0;
  rngState.seed = x;
  return x;
}

function rand() {
  return nextUint() / 4294967296;
}

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function intInRange(minInclusive, maxInclusive) {
  const lo = Math.ceil(minInclusive);
  const hi = Math.floor(maxInclusive);
  if (hi <= lo) return lo;
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function intInclusive(max) {
  return Math.floor(rand() * (max + 1));
}

function numInRange(minInclusive, maxInclusive, integer) {
  if (integer) return intInRange(minInclusive, maxInclusive);
  return minInclusive + rand() * (maxInclusive - minInclusive);
}

// ── Format-aware scalar generators ───────────────────────────────────────────

const HEX = "0123456789abcdef";

function randomString(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += HEX.charAt(Math.floor(rand() * 16));
  return s;
}

function randomAlnum(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++)
    s += chars.charAt(Math.floor(rand() * chars.length));
  return s;
}

function randomUuid() {
  const s = randomString(32);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${pick(["8", "9", "a", "b"])}${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

function randomDateTime() {
  const ms = new Date(
    Date.now() - intInclusive(365 * 24 * 3600 * 1000),
  ).getTime();
  return new Date(ms).toISOString();
}

function randomStellarAddress() {
  // G + 55 base32 uppercase chars (matches ^G[A-Z0-9]{55}$)
  return "G" + randomAlnum(55);
}

function randomTxHash() {
  // 64 lowercase hex (matches ^[a-fA-F0-9]{64}$)
  return randomString(64);
}

function formatValue(format) {
  switch (format) {
  case "uuid":
    return randomUuid();
  case "date-time":
    return randomDateTime();
  case "date":
    return randomDateTime().slice(0, 10);
  case "email":
    return `donor+${intInclusive(999)}@example.com`;
  case "byte":
    return Buffer.from(randomString(16)).toString("base64");
  default:
    return null;
  }
}

// ── $ref resolution ───────────────────────────────────────────────────────────

function resolveRef(schema, components, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const ref = schema.$ref; // "#/components/schemas/Name"
    const name = ref.split("/").pop();
    if (seen.has(name)) return schema; // guard recursion
    seen = new Set(seen).add(name);
    const target = components && components.schemas && components.schemas[name];
    if (target) return resolveRef(target, components, seen);
    return {};
  }
  return schema;
}

// ── VALID value generation ────────────────────────────────────────────────────

/**
 * Produce a value that conforms to `schema`.
 */
function generateValidValue(schema, components, seen = new Set()) {
  let s = resolveRef(schema, components, seen);
  if (!s || typeof s !== "object") return s;

  if (s.oneOf && Array.isArray(s.oneOf) && s.oneOf.length) {
    return generateValidValue(s.oneOf[0], components, seen);
  }
  if (s.anyOf && Array.isArray(s.anyOf) && s.anyOf.length) {
    return generateValidValue(s.anyOf[0], components, seen);
  }
  if (s.enum && Array.isArray(s.enum) && s.enum.length) {
    return s.enum[0];
  }

  const type = s.type;

  // Numeric formats (e.g. `format: float` on a number) must NOT be routed
  // through the string generator — only a declared string type (or an untyped
  // format) goes the string route.
  if (
    type === "string" ||
    (!type && s.format && typeof s.format === "string")
  ) {
    return validString(s, components, seen);
  }
  if (type === "number" || type === "integer") {
    return validNumber(s);
  }
  if (type === "boolean") {
    return rand() < 0.5;
  }
  if (type === "null") {
    return null;
  }
  if (type === "array") {
    return validArray(s, components, seen);
  }
  if (type === "object" || (!type && s.properties)) {
    return validObject(s, components, seen);
  }

  // No declared type → attempt a structural guess.
  if (s.properties) return validObject(s, components, seen);
  if (s.items) return validArray(s, components, seen);
  return null;
}

function validString(s) {
  if (s.format) {
    const fv = formatValue(s.format);
    if (fv != null) return fv;
  }
  if (s.pattern) {
    return patternSample(s.pattern);
  }
  const min = s.minLength && s.minLength > 0 ? s.minLength : 1;
  const max =
    s.maxLength && s.maxLength > min ? s.maxLength : Math.min(24, min + 8);
  return randomString(intInRange(min, max));
}

function patternSample(pattern) {
  // Produce something that satisfies the common anchored patterns in this spec
  // (stellar addresses, tx hashes, fixed-width numeric codes). Fall back to
  // plausible text.
  const p = String(pattern);
  if (p.includes("G[") && p.includes("55}")) return randomStellarAddress();
  if (p.includes("64")) return randomTxHash();
  if (p.includes("A-Z0-9")) return randomStellarAddress();
  // Fixed-width digit patterns such as `^[0-9]{6}$` (e.g. TOTP codes).
  const digitLen = /\[0-9\]\{(\d+)\}/.exec(p);
  if (digitLen) {
    const n = Math.max(1, parseInt(digitLen[1], 10));
    let s = "";
    for (let i = 0; i < n; i++) s += Math.floor(rand() * 10);
    return s;
  }
  const letters = p.length > 0 ? 8 : 8;
  return randomString(intInRange(letters, letters + 8));
}

function validNumber(s) {
  const integer = s.type === "integer";
  const min =
    typeof s.minimum === "number" ? s.minimum : integer ? -1000 : -1000;
  const max = typeof s.maximum === "number" ? s.maximum : integer ? 1000 : 1000;
  if (max < min) return numInRange(max, min, integer);
  return numInRange(
    Math.max(min, integer ? -1e6 : -1e6),
    Math.min(max, integer ? 1e6 : 1e6),
    integer,
  );
}

function validArray(s, components, seen) {
  const min = s.minItems || 0;
  const max = Math.max(min, s.maxItems || Math.min(4, min + 3));
  const len = intInRange(min, Math.min(max, 6));
  const items = s.items ? s.items : { type: "string" };
  const out = [];
  for (let i = 0; i < len; i++)
    out.push(generateValidValue(items, components, seen));
  return out;
}

function validObject(s, components, seen) {
  const props = s.properties || {};
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const obj = {};
  const includeAllRequired = Math.random() < 1; // always include required in valid payloads
  for (const [key, sub] of Object.entries(props)) {
    if (required.has(key) || includeAllRequired || rand() < 0.6) {
      obj[key] = generateValidValue(sub, components, seen);
    }
  }
  return obj;
}

// ── INVALID value strategies ──────────────────────────────────────────────────

/**
 * Return an array of mutation functions. Each mutates a *valid* payload into a
 * value that violates the schema (wrong type, bounds, length, enum, pattern,
 * missing required, extra unknown field, SQL injection, unicode homoglyph).
 */
function named(name, fn, guaranteed) {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  fn.guaranteed = guaranteed;
  return fn;
}

/**
 * List of mutation strategies applied on top of a valid payload to produce a
 * (likely) schema-violating request.
 *
 * `guaranteed === true` means the mutation is *provably* schema-violating (wrong
 * type, out-of-range, over-length, enum/pattern violation, missing required
 * field, extra unknown field). Only these are used to fabricate labelled
 * "invalid" cases so the offline self-test can prove each invalid case truly
 * violates the schema — this is what makes the "no 5xx on invalid input"
 * acceptance claim meaningful.
 *
 * `guaranteed === false` (SQL injection, Unicode homoglyphs) substitute content
 * that can still satisfy free-form string schemas; they are kept as “chaos”
 * payloads for live sending to shift unusual bytes at handlers.
 */
function mutationStrategies(schema, components) {
  return [
    named("seed", (s) => s, false), // 0. seed (handled by caller)
    named("wrongTypeObject", wrongTypeObject, true), // 1. wrong top-level type
    named(
      "deepWrongType",
      (payload) =>
        injectIntoDeep(payload, schema, components, (val, sub) =>
          wrongTypeValue(sub),
        ),
      true,
    ),
    named(
      "deepOverLength",
      (payload) =>
        injectIntoDeep(payload, schema, components, (val, sub) =>
          overLengthString(sub),
        ),
      true,
    ),
    named(
      "deepOutOfRange",
      (payload) =>
        injectIntoDeep(payload, schema, components, (val, sub) =>
          outOfRangeNumber(sub),
        ),
      true,
    ),
    named(
      "deepEnumViolation",
      (payload) =>
        injectIntoDeep(payload, schema, components, (val, sub) =>
          enumViolation(sub),
        ),
      true,
    ),
    named(
      "deepPatternViolation",
      (payload) =>
        injectIntoDeep(payload, schema, components, (val, sub) =>
          patternViolation(sub),
        ),
      true,
    ),
    named(
      "missingRequired",
      (payload) => missingRequired(payload, schema, components),
      true,
    ),
    // Only *provably* invalid when the schema forbids undeclared fields.
    named("extraUnknownField", extraUnknownField, extraIsGuaranteed(schema)),
    named("sqlInjection", sqlInjection, false),
    named("unicodeHomoglyph", unicodeHomoglyph, false),
  ].filter(Boolean);
}

function wrongTypeValue(sub) {
  const t = sub && sub.type;
  switch (t) {
  case "string":
    return intInclusive(999);
  case "number":
  case "integer":
    return "NaN";
  case "boolean":
    return {};
  case "array":
    return "array";
  case "object":
    return 3.14;
  default:
    return null;
  }
}

function wrongTypeObject(payload) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    return Object.keys(payload).length === 0 ? null : undefined;
  }
  return payload;
}

function overLengthString(sub) {
  if (sub && sub.type === "string") {
    const max = typeof sub.maxLength === "number" ? sub.maxLength : 256;
    return randomString(max + 1 + intInclusive(32));
  }
  if (sub && sub.type === "string" && sub.minLength && !sub.maxLength) {
    return randomString(4096);
  }
  return null;
}

function outOfRangeNumber(sub) {
  if (sub && (sub.type === "number" || sub.type === "integer")) {
    if (typeof sub.minimum === "number")
      return sub.minimum - 1 - intInclusive(1000);
    if (typeof sub.maximum === "number")
      return sub.maximum + 1 + intInclusive(1000);
    return Number.MAX_SAFE_INTEGER;
  }
  return null;
}

function enumViolation(sub) {
  if (sub && Array.isArray(sub.enum) && sub.enum.length) {
    return `__not_in_enum_${intInclusive(999)}__`;
  }
  return null;
}

function patternViolation(sub) {
  if (sub && sub.pattern) {
    if (/^G\[A-Z0-9\]\{55\}$/.test(sub.pattern)) return "bad" + randomString(4);
    if (/\{64\}/.test(sub.pattern)) return randomString(16);
    return "!!!";
  }
  return null;
}

function missingRequired(payload, schema, components) {
  const s = resolveRef(schema, components, new Set());
  if (!s || typeof s !== "object" || !Array.isArray(s.required)) return payload;
  const copy = Array.isArray(payload) ? [...payload] : { ...payload };
  if (typeof copy === "object" && copy !== null && !Array.isArray(copy)) {
    for (const key of s.required) {
      delete copy[key];
    }
  }
  return copy;
}

function extraIsGuaranteed(schema) {
  return !!(
    schema &&
    typeof schema === "object" &&
    schema.additionalProperties === false
  );
}

function extraUnknownField(payload) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    return {
      ...payload,
      [`__extra_${intInclusive(99)}__`]: "unexpected",
      [`__sql__${intInclusive(99)}__`]: "' OR '1'='1",
    };
  }
  return payload;
}

function sqlInjection(payload) {
  const attacks = [
    "' OR '1'='1",
    "1; DROP TABLE projects; --",
    "admin'--",
    "' UNION SELECT * FROM donations--",
    "<script>alert(1)</script>",
  ];
  const atk = pick(attacks);
  if (typeof payload === "object" && payload !== null) {
    const copy = Array.isArray(payload) ? [...payload] : { ...payload };
    const keys = Object.keys(copy);
    if (Array.isArray(copy)) {
      return keys.map((_, i) => (i ? copy[i] : atk));
    }
    if (keys.length) copy[keys[0]] = atk;
    return copy;
  }
  return atk;
}

function unicodeHomoglyph(payload) {
  // Unicode homoglyphs / NFC vs NFD confusion strings.
  const homoglyphs = [
    "Ｈｅｌｌｏ",
    "ḥṱṯṗṩ",
    "🎉捐赠",
    "café\u0301",
    "\u202eOVERFLOW",
  ];
  if (typeof payload === "object" && payload !== null) {
    const copy = { ...payload };
    const key = Object.keys(copy)[0];
    if (key && (typeof copy[key] === "string" || copy[key] == null)) {
      copy[key] = pick(homoglyphs);
    }
    return copy;
  }
  return pick(homoglyphs);
}

/**
 * Walk `payload` (matching `subSchema`'s structure) and apply `mutate` at the
 * first leaf/child that can be mutated; return a deep-cloned, mutated payload.
 * Returns the original payload if no mutation site matched.
 */
function injectIntoDeep(payload, subSchema, components, mutate, _seen) {
  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === "object") return { ...v };
    return v;
  }
  function walk(val, sub) {
    const s = resolveRef(sub, components, new Set());
    if (!s || typeof s !== "object") return mutate(val, {});
    if (s.oneOf) return walk(val, s.oneOf[0] || {});
    if (s.anyOf) return walk(val, s.anyOf[0] || {});
    const type = s.type;
    if (type === "object" || (!type && s.properties)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const out = {};
        for (const [k, subv] of Object.entries(val)) {
          const childSchema = (s.properties && s.properties[k]) || {};
          const mutatedChild = walk(subv, childSchema);
          if (mutatedChild.mutated) {
            out[k] = mutatedChild.value;
            break;
          }
          out[k] = subv;
        }
        if (Object.keys(out).length < Object.keys(val).length) {
          return { value: out, mutated: true };
        }
        const full = { ...val, ...out };
        if (
          Object.getOwnPropertyNames(full).length !==
          Object.getOwnPropertyNames(val).length
        ) {
          return { value: full, mutated: true };
        }
        return { value: full, mutated: false };
      }
      return { value: mutate(val, s), mutated: mutate(val, s) !== val };
    }
    if (type === "array") {
      if (Array.isArray(val)) {
        const out = val.map((x) => {
          const r = walk(x, s.items || {});
          return r.mutated ? r.value : x;
        });
        return { value: out, mutated: false };
      }
      return { value: mutate(val, s), mutated: mutate(val, s) !== val };
    }
    const res = mutate(val, s);
    return { value: res, mutated: res !== val };
  }
  const result = walk(clone(payload), subSchema);
  return result.value;
}

module.exports = {
  reset,
  rand,
  pick,
  intInRange,
  generateValidValue,
  mutationStrategies,
  formatValue,
  resolveRef,
};
