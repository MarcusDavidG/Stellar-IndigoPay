"use strict";

/**
 * webhookVerify.test.js
 *
 * Integration tests for the webhookVerify middleware through a real
 * Express app (no mocking of the signing library). Tests cover:
 *
 *   - Happy path: valid signature, fresh timestamp
 *   - Replay rejection outside window
 *   - Clock-skew tolerance inside window
 *   - Version-prefix parsing: v1, unknown version (fail-closed)
 *   - Transition-window compatibility: dual-sign header (v1 + v2)
 *   - Each structured error code and its HTTP status mapping
 *   - Missing header → 400
 *   - Missing secret → 500
 */

const express = require("express");
const request = require("supertest");

const { sign, VerifyReason } = require("../lib/webhookSign");
const webhookVerify = require("./webhookVerify");

// ─── Test app factory ─────────────────────────────────────────────────────────

function buildApp({ secret, getSecret, replayWindowSeconds } = {}) {
  const app = express();

  // Use raw body so the middleware receives the exact bytes that were signed.
  app.post(
    "/webhook",
    express.raw({ type: "*/*" }),
    webhookVerify({
      getSecret: getSecret ?? (async () => (secret === undefined ? "test-secret" : secret)),
      ...(replayWindowSeconds !== undefined ? { replayWindowSeconds } : {}),
    }),
    (req, res) => {
      res.status(200).json({ ok: true });
    },
  );

  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BODY = JSON.stringify({ event: "milestone.reached", projectId: "proj-1" });
const SECRET = "test-secret";

function freshTs() {
  return Math.floor(Date.now() / 1000);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("webhookVerify middleware", () => {
  test("200: valid signature with fresh timestamp", async () => {
    const ts = freshTs();
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts))
      .send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("400: missing X-Webhook-Signature header", async () => {
    const app = buildApp();
    const res = await request(app).post("/webhook").send(BODY);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe(VerifyReason.MALFORMED);
    expect(res.headers["x-webhook-signature-reason"]).toBe(VerifyReason.MALFORMED);
  });

  test("408: timestamp outside replay window (STALE)", async () => {
    const oldTs = freshTs() - 10 * 60; // 10 minutes ago
    const app = buildApp(); // default 5-min window
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, oldTs))
      .send(BODY);
    expect(res.status).toBe(408);
    expect(res.body.reason).toBe(VerifyReason.STALE);
    expect(res.headers["x-webhook-signature-reason"]).toBe(VerifyReason.STALE);
  });

  test("408: timestamp in the future outside replay window", async () => {
    const futureTs = freshTs() + 10 * 60;
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, futureTs))
      .send(BODY);
    expect(res.status).toBe(408);
    expect(res.body.reason).toBe(VerifyReason.STALE);
  });

  test("200: timestamp within clock-skew tolerance (4 min old, 5-min window)", async () => {
    const ts = freshTs() - 4 * 60;
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts))
      .send(BODY);
    expect(res.status).toBe(200);
  });

  test("401: tampered body (MISMATCH)", async () => {
    const ts = freshTs();
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts))
      .send(BODY + "tamper"); // body differs from what was signed
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe(VerifyReason.MISMATCH);
    expect(res.headers["x-webhook-signature-reason"]).toBe(VerifyReason.MISMATCH);
  });

  test("401: wrong secret (MISMATCH)", async () => {
    const ts = freshTs();
    const app = buildApp({ secret: "wrong-secret" });
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts)) // signed with different secret
      .send(BODY);
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe(VerifyReason.MISMATCH);
  });

  test("403: unknown algorithm version only (UNKNOWN_VERSION, fail-closed)", async () => {
    const ts = freshTs();
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", `t=${ts},v3=deadbeefdeadbeef`)
      .send(BODY);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe(VerifyReason.UNKNOWN_VERSION);
    expect(res.headers["x-webhook-signature-reason"]).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("400: malformed header (no k=v pairs) → MISSING_T", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", "not-a-valid-header")
      .send(BODY);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe(VerifyReason.MISSING_T);
  });

  test("403: header with t= but no version key (UNKNOWN_VERSION)", async () => {
    const ts = freshTs();
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", `t=${ts}`)
      .send(BODY);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("200: dual-sign header (v1 + hypothetical v2) accepted via v1", async () => {
    // During algorithm transition the sender may emit both v1 and v2.
    // The middleware honours v1 if it validates, ignoring the unknown v2.
    const ts = freshTs();
    const v1Header = sign(BODY, SECRET, ts);
    const v1Sig = v1Header.split(",")[1]; // "v1=<hex>"
    const dualHeader = `t=${ts},${v1Sig},v2=somefuturehex`;
    const app = buildApp();
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", dualHeader)
      .send(BODY);
    expect(res.status).toBe(200);
  });

  test("configurable replay window: custom 60-second window rejects 2-min-old sig", async () => {
    const ts = freshTs() - 2 * 60; // 2 minutes ago
    const app = buildApp({ replayWindowSeconds: 60 });
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts))
      .send(BODY);
    expect(res.status).toBe(408);
    expect(res.body.reason).toBe(VerifyReason.STALE);
  });

  test("configurable replay window: custom 600-second window accepts 9-min-old sig", async () => {
    const ts = freshTs() - 9 * 60;
    const app = buildApp({ secret: SECRET, replayWindowSeconds: 600 });
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts))
      .send(BODY);
    expect(res.status).toBe(200);
  });

  test("X-Webhook-Signature-Reason response header is set on all error responses", async () => {
    const ts = freshTs();
    const app = buildApp();

    const stale = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts - 10 * 60))
      .send(BODY);
    expect(stale.headers["x-webhook-signature-reason"]).toBe(VerifyReason.STALE);

    const mismatch = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, "wrong", ts))
      .send(BODY);
    expect(mismatch.headers["x-webhook-signature-reason"]).toBe(VerifyReason.MISMATCH);

    const unknown = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", `t=${ts},v3=abc`)
      .send(BODY);
    expect(unknown.headers["x-webhook-signature-reason"]).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("500: getSecret returns an empty secret", async () => {
    const ts = freshTs();
    const app = buildApp({ secret: "" });
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts))
      .send(BODY);
    expect(res.status).toBe(500);
  });

  test("500: getSecret throws", async () => {
    const ts = freshTs();
    const app = buildApp({
      getSecret: async () => {
        throw new Error("vault unavailable");
      },
    });
    const res = await request(app)
      .post("/webhook")
      .set("X-Webhook-Signature", sign(BODY, SECRET, ts))
      .send(BODY);
    expect(res.status).toBe(500);
  });

  test("throws TypeError if getSecret is not provided", () => {
    expect(() => webhookVerify({})).toThrow(TypeError);
    expect(() => webhookVerify({ getSecret: "not-a-function" })).toThrow(TypeError);
  });

  test("throws TypeError if replayWindowSeconds is invalid", () => {
    expect(() => webhookVerify({ getSecret: async () => "s", replayWindowSeconds: -1 })).toThrow(TypeError);
    expect(() => webhookVerify({ getSecret: async () => "s", replayWindowSeconds: NaN })).toThrow(TypeError);
    expect(() => webhookVerify({ getSecret: async () => "s", replayWindowSeconds: "300" })).toThrow(TypeError);
  });
});
