"use strict";

/**
 * lib/webhookSign.js
 *
 * Versioned webhook signature scheme for Stellar-IndigoPay.
 *
 * Header format (v1, current)
 * ───────────────────────────
 *   X-Webhook-Signature: t=<unix>,v1=<hex hmac-sha256(secret,"<ts>.<body>")>
 *
 * The `v1=` prefix is the algorithm version identifier. Clients parse
 * the comma-separated `k=v` pairs and handle only the version(s) they
 * understand. Unknown versions MUST be rejected (fail-closed).
 *
 * Algorithm
 * ─────────
 *   HMAC-SHA256 over the concatenation  `<timestamp>.<body>`
 *   where `<timestamp>` is the decimal Unix seconds value that also
 *   appears in the `t=` part of the header. Binding the timestamp into
 *   the signed content prevents an attacker from replaying an old
 *   signature against a new timestamp.
 *
 * Replay protection
 * ─────────────────
 *   `verify()` rejects signatures whose timestamp is more than
 *   `replayWindowSeconds` (default 300 s / 5 min) away from `now`.
 *   The error code `STALE` is returned so callers can distinguish a
 *   clock-skew issue from a forgery.
 *
 * Versioning policy
 * ─────────────────
 *   See docs/webhook-signing-versioning.md for the full migration path.
 *   In brief:
 *     - v1 is the current algorithm (HMAC-SHA256).
 *     - A future v2 would be introduced by dual-signing: the server
 *       emits `t=<ts>,v1=<hex>,v2=<hex>` during a transition window.
 *     - Verifiers must accept any valid version in the list (logical OR).
 *     - Unknown versions (v3+) are rejected with UNKNOWN_VERSION.
 *     - After the transition window, v1 is dropped from outbound headers.
 *
 * Error codes
 * ───────────
 *   Returned by `verifyWithReason()` as `{ ok, reason }`:
 *
 *   MALFORMED        header is missing, empty, or not parseable
 *   MISSING_T        `t=` field absent or not a finite integer
 *   MISSING_V1       `v1=` field absent or empty
 *   UNKNOWN_VERSION  header contains no recognised version prefix
 *   STALE            timestamp outside the replay window (clock skew / replay)
 *   MISMATCH         HMAC does not match (tampered body or wrong secret)
 *
 * Cross-language test vectors
 * ───────────────────────────
 *   backend/src/lib/webhookSign.vectors.json — machine-readable, locked
 *   by webhookSign.vectors.test.js.
 */

const crypto = require("crypto");

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_REPLAY_WINDOW_SECONDS = 5 * 60; // 300 s

/**
 * Known algorithm version tokens in the header. The set is intentionally
 * small so callers can enumerate it exhaustively.
 */
const SUPPORTED_VERSIONS = Object.freeze(["v1"]);

/**
 * Error reason codes returned by verifyWithReason(). Exported so
 * callers can import and switch on them without string-matching.
 */
const VerifyReason = Object.freeze({
  OK: "OK",
  MALFORMED: "MALFORMED",
  MISSING_T: "MISSING_T",
  MISSING_V1: "MISSING_V1",
  UNKNOWN_VERSION: "UNKNOWN_VERSION",
  STALE: "STALE",
  MISMATCH: "MISMATCH",
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parse the `k=v,...` header into a plain object.
 * Values that contain `=` (e.g. base64) are preserved correctly because
 * we only split on the *first* `=` in each token.
 *
 * @param {string} header
 * @returns {Record<string, string>}
 */
function parseHeader(header) {
  if (typeof header !== "string" || header.length === 0) return {};
  return Object.fromEntries(
    header.split(",").map((token) => {
      const eq = token.indexOf("=");
      return eq === -1
        ? [token.trim(), ""]
        : [token.slice(0, eq).trim(), token.slice(eq + 1).trim()];
    }),
  );
}

/**
 * Constant-time HMAC comparison.
 * Returns true iff `got` (hex string) equals the HMAC of `message` under
 * `secret`. Always runs in O(digest-length) time regardless of input.
 *
 * @param {string|Buffer} message
 * @param {string}        secret
 * @param {string}        got  hex-encoded candidate digest
 * @returns {boolean}
 */
function hmacEquals(message, secret, got) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest();
  const candidate = Buffer.from(got, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a deterministic event ID from the canonical milestone fields.
 * Two identical milestones at the same raisedXlm / percentage produce
 * the same id, which receivers use for idempotent dedup.
 *
 * @param {{ projectId: string, milestoneId: string|null, percentage: number, raisedXlm: string }} input
 * @returns {string} lowercase hex sha256
 */
function computeEventId(input) {
  return crypto
    .createHash("sha256")
    .update(String(input.projectId))
    .update("|")
    .update(String(input.milestoneId ?? ""))
    .update("|")
    .update(String(input.percentage))
    .update("|")
    .update(String(input.raisedXlm ?? ""))
    .digest("hex");
}

/**
 * Sign a body with HMAC-SHA256 and return the versioned signature header.
 *
 * Format: `t=<unix>,v1=<hex>`
 *
 * @param {string|Buffer} body       raw request body bytes
 * @param {string}        secret     project-scoped HMAC secret
 * @param {number}        timestamp  unix seconds (caller supplies for testability)
 * @returns {string}
 */
function sign(body, secret, timestamp) {
  if (!Number.isSafeInteger(timestamp)) {
    throw new TypeError("sign: timestamp must be a safe integer");
  }
  const prefix = Buffer.from(`${timestamp}.`, "utf8");
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const mac = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([prefix, bodyBuf]))
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verify a signature and return a structured `{ ok, reason }` result.
 *
 * Fail-closed behaviour:
 *   - A header containing no recognised version prefix is rejected with
 *     UNKNOWN_VERSION — not silently accepted.
 *   - STALE is returned when the timestamp is outside the replay window
 *     so callers can distinguish clock-skew from forgery.
 *
 * @param {string|Buffer} body
 * @param {string}        secret
 * @param {string}        signatureHeader  value of X-Webhook-Signature
 * @param {number}        [now]            unix seconds (default: Date.now())
 * @param {number}        [replayWindowSeconds]
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyWithReason(
  body,
  secret,
  signatureHeader,
  now = Math.floor(Date.now() / 1000),
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
) {
  const parts = parseHeader(signatureHeader);

  if (Object.keys(parts).length === 0) {
    return { ok: false, reason: VerifyReason.MALFORMED };
  }

  // ── Timestamp ──────────────────────────────────────────────────────────
  const rawT = parts.t;
  if (typeof rawT !== "string" || rawT.length === 0) {
    return { ok: false, reason: VerifyReason.MISSING_T };
  }
  if (!/^-?\d+$/.test(rawT)) {
    return { ok: false, reason: VerifyReason.MISSING_T };
  }
  const t = Number(rawT);
  if (!Number.isSafeInteger(t)) {
    return { ok: false, reason: VerifyReason.MISSING_T };
  }

  // ── v1 specifically required ────────────────────────────────────────────
  // Check v1 presence/emptiness before the generic unknown-version check so
  // both an empty v1 value and a bare v1 token correctly return MISSING_V1.
  if (Object.prototype.hasOwnProperty.call(parts, "v1")) {
    const v1val = parts.v1;
    if (typeof v1val !== "string" || v1val.length === 0) {
      return { ok: false, reason: VerifyReason.MISSING_V1 };
    }
  } else if (!Object.prototype.hasOwnProperty.call(parts, "v1")) {
    // No v1 key at all — check if any recognised version present
    const presentVersions = SUPPORTED_VERSIONS.filter((v) => parts[v] !== undefined && parts[v] !== "");
    if (presentVersions.length === 0) {
      return { ok: false, reason: VerifyReason.UNKNOWN_VERSION };
    }
    return { ok: false, reason: VerifyReason.MISSING_V1 };
  }

  const v1 = parts.v1;

  // ── Replay window ───────────────────────────────────────────────────────
  if (!Number.isFinite(replayWindowSeconds) || replayWindowSeconds < 0) {
    return { ok: false, reason: VerifyReason.MALFORMED };
  }
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) {
    return { ok: false, reason: VerifyReason.MALFORMED };
  }
  if (Math.abs(now - t) > replayWindowSeconds) {
    return { ok: false, reason: VerifyReason.STALE };
  }

  // ── HMAC ────────────────────────────────────────────────────────────────
  // Preserve raw Buffer bytes: HMAC over <timestamp>.<body> where body bytes are exact.
  const prefix = Buffer.from(`${t}.`, "utf8");
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const message = Buffer.concat([prefix, bodyBuf]);
  if (!hmacEquals(message, secret, v1)) {
    return { ok: false, reason: VerifyReason.MISMATCH };
  }

  return { ok: true, reason: VerifyReason.OK };
}

/**
 * Boolean convenience wrapper around verifyWithReason().
 * Existing callers that only need true/false are unaffected.
 *
 * @param {string|Buffer} body
 * @param {string}        secret
 * @param {string}        signatureHeader
 * @param {number}        [now]
 * @param {number}        [replayWindowSeconds]
 * @returns {boolean}
 */
function verify(
  body,
  secret,
  signatureHeader,
  now = Math.floor(Date.now() / 1000),
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
) {
  return verifyWithReason(body, secret, signatureHeader, now, replayWindowSeconds).ok;
}

module.exports = {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  SUPPORTED_VERSIONS,
  VerifyReason,
  computeEventId,
  sign,
  verify,
  verifyWithReason,
  // Exposed for tests — not part of the public partner API.
  _parseHeader: parseHeader,
};
