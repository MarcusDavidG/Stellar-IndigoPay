"use strict";

/**
 * middleware/webhookVerify.js
 *
 * Express middleware that verifies inbound webhook signatures using the
 * same scheme that webhookQueue.js uses to *send* signed deliveries.
 *
 * This is used by any route that receives webhooks from external partners
 * (e.g. a cross-chain bridge reporting back, or a test harness replaying
 * deliveries). It is NOT the same as the outbound signing in webhookQueue.js
 * — that code signs payloads we send; this code verifies payloads we receive.
 *
 * Usage
 * ─────
 *   const webhookVerify = require('../middleware/webhookVerify');
 *
 *   router.post(
 *     '/receive',
 *     express.raw({ type: 'application/json' }),  // ← raw body required
 *     webhookVerify({ getSecret: (req) => process.env.PARTNER_WEBHOOK_SECRET }),
 *     (req, res) => { ... }
 *   );
 *
 * Options
 * ───────
 *   getSecret(req) → string | Promise<string>
 *     Required. Called with the request; returns the HMAC secret to use.
 *     Throw or return a falsy value to reject the request.
 *
 *   replayWindowSeconds — default: DEFAULT_REPLAY_WINDOW_SECONDS (300)
 *     How many seconds of clock skew are tolerated. Configurable via
 *     WEBHOOK_REPLAY_WINDOW_SECONDS env var.
 *
 * Response codes
 * ──────────────
 *   400  header malformed, missing t=, or missing v1=
 *   401  HMAC mismatch (tampered body or wrong secret)
 *   403  unknown algorithm version (fail-closed)
 *   408  timestamp outside replay window (STALE) — lets caller distinguish
 *        clock issues from forgery
 *
 * The `X-Webhook-Signature-Reason` response header is set on all errors
 * so clients can log the machine-readable reason code.
 */

const {
  verifyWithReason,
  VerifyReason,
  DEFAULT_REPLAY_WINDOW_SECONDS,
} = require("../lib/webhookSign");

const logger = require("../logger");

/** Map VerifyReason → HTTP status code. */
const REASON_TO_STATUS = {
  [VerifyReason.MALFORMED]: 400,
  [VerifyReason.MISSING_T]: 400,
  [VerifyReason.MISSING_V1]: 400,
  [VerifyReason.UNKNOWN_VERSION]: 403,
  [VerifyReason.STALE]: 408,
  [VerifyReason.MISMATCH]: 401,
};

/**
 * @param {object} options
 * @param {(req: import('express').Request) => string | Promise<string>} options.getSecret
 * @param {number} [options.replayWindowSeconds]
 */
function webhookVerify(options = {}) {
  if (typeof options.getSecret !== "function") {
    throw new TypeError("webhookVerify: options.getSecret must be a function");
  }

  const replayWindowSeconds =
    options.replayWindowSeconds ??
    Number(process.env.WEBHOOK_REPLAY_WINDOW_SECONDS || DEFAULT_REPLAY_WINDOW_SECONDS);

  return async function webhookVerifyMiddleware(req, res, next) {
    const signatureHeader = req.get("x-webhook-signature");

    if (!signatureHeader) {
      return res
        .status(400)
        .set("X-Webhook-Signature-Reason", VerifyReason.MALFORMED)
        .json({ error: "missing X-Webhook-Signature header", reason: VerifyReason.MALFORMED });
    }

    let secret;
    try {
      secret = await options.getSecret(req);
    } catch (err) {
      logger.warn(
        { event: "webhook_verify_secret_error", err: err.message },
        "webhookVerify: getSecret threw",
      );
      return res.status(500).json({ error: "internal error resolving webhook secret" });
    }

    if (!secret) {
      logger.warn(
        { event: "webhook_verify_no_secret" },
        "webhookVerify: getSecret returned empty secret",
      );
      return res.status(500).json({ error: "webhook secret not configured" });
    }

    // Body must be raw bytes/string. express.raw() gives a Buffer; toString()
    // gives the UTF-8 string that was signed.
    const rawBody =
      Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

    const now = Math.floor(Date.now() / 1000);
    const { ok, reason } = verifyWithReason(
      rawBody,
      secret,
      signatureHeader,
      now,
      replayWindowSeconds,
    );

    if (!ok) {
      const status = REASON_TO_STATUS[reason] ?? 401;
      logger.warn(
        {
          event: "webhook_signature_rejected",
          reason,
          status,
          deliveryId: req.get("x-webhook-delivery-id"),
          eventType: req.get("x-webhook-event-type"),
        },
        `webhookVerify: signature rejected — ${reason}`,
      );
      return res
        .status(status)
        .set("X-Webhook-Signature-Reason", reason)
        .json({ error: "webhook signature verification failed", reason });
    }

    next();
  };
}

module.exports = webhookVerify;
