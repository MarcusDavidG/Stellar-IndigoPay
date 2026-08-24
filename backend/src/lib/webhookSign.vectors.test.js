"use strict";

/**
 * webhookSign.vectors.test.js
 *
 * Vector conformance test — locks the canonical test vectors in
 * webhookSign.vectors.json against the live sign() / verify()
 * implementation.
 *
 * If any vector fails it means either:
 *   a) The implementation changed in a breaking way, or
 *   b) A vector was incorrectly generated.
 *
 * In both cases the test intentionally fails loudly so the change is
 * reviewed before release.
 *
 * Cross-language notes
 * ────────────────────
 * The vectors file also ships to partners. The JSON schema and notes
 * inside it describe how to reproduce each signature in Node, Python,
 * Go, Ruby, and PHP. Any implementation that matches these vectors is
 * interoperable with IndigoPay's signer.
 */

const { sign, verify, verifyWithReason, VerifyReason } = require("./webhookSign");
const vectors = require("./webhookSign.vectors.json");

// ─── Helper: expand body_repeat shorthand ────────────────────────────────────

function expandBody(v) {
  if (typeof v.body === "string") return v.body;
  if (v.body_repeat) {
    return v.body_repeat.char.repeat(v.body_repeat.count);
  }
  throw new Error(`Vector ${v.id}: no body or body_repeat field`);
}

// ─── Positive vectors (sign + verify) ────────────────────────────────────────

describe("webhookSign vector conformance — positive vectors", () => {
  for (const vec of vectors.vectors) {
    describe(`vector: ${vec.id}`, () => {
      const body = expandBody(vec);

      test("sign() produces the expected v1 hex", () => {
        const header = sign(body, vec.secret, vec.timestamp);
        const parts = Object.fromEntries(
          header.split(",").map((kv) => {
            const eq = kv.indexOf("=");
            return [kv.slice(0, eq), kv.slice(eq + 1)];
          }),
        );
        expect(parts.v1).toBe(vec.expected_v1);
      });

      test("sign() produces the exact expected header string", () => {
        expect(sign(body, vec.secret, vec.timestamp)).toBe(vec.expected_header);
      });

      test("verify() accepts the vector with matching timestamp (no replay window)", () => {
        // Pass the vector timestamp as `now` so the replay window is always 0.
        expect(
          verify(body, vec.secret, vec.expected_header, vec.timestamp),
        ).toBe(true);
      });

      test("verifyWithReason() returns OK", () => {
        const { ok, reason } = verifyWithReason(
          body,
          vec.secret,
          vec.expected_header,
          vec.timestamp,
        );
        expect(ok).toBe(true);
        expect(reason).toBe(VerifyReason.OK);
      });

      test("verify() rejects a tampered body", () => {
        expect(
          verify(body + "tamper", vec.secret, vec.expected_header, vec.timestamp),
        ).toBe(false);
      });

      test("verify() rejects a wrong secret", () => {
        expect(
          verify(body, "wrong-secret", vec.expected_header, vec.timestamp),
        ).toBe(false);
      });

      test("v1 hex is exactly 64 lowercase hex chars (SHA-256 output)", () => {
        expect(vec.expected_v1).toMatch(/^[a-f0-9]{64}$/);
      });
    });
  }
});

// ─── Rejection vectors ────────────────────────────────────────────────────────

describe("webhookSign vector conformance — rejection vectors", () => {
  const secret = "test-secret-1";
  const body = '{"event":"milestone.reached"}';
  // Use a fixed timestamp that is in the distant past so we control skew.
  const signedAt = 1700000000;
  const freshNow = signedAt; // "now" = same as signing time → within window

  test("STALE: timestamp more than 5 min in the past", () => {
    const header = sign(body, secret, signedAt);
    const now = signedAt + 10 * 60; // 10 minutes later
    const { ok, reason } = verifyWithReason(body, secret, header, now);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.STALE);
  });

  test("STALE: timestamp more than 5 min in the future", () => {
    const header = sign(body, secret, signedAt);
    const now = signedAt - 10 * 60; // 10 minutes earlier
    const { ok, reason } = verifyWithReason(body, secret, header, now);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.STALE);
  });

  test("within replay window: ±4 min is accepted", () => {
    const header = sign(body, secret, signedAt);
    expect(verify(body, secret, header, signedAt + 4 * 60)).toBe(true);
    expect(verify(body, secret, header, signedAt - 4 * 60)).toBe(true);
  });

  test("at exact boundary: ±300 s is accepted, ±301 s is rejected", () => {
    const header = sign(body, secret, signedAt);
    expect(verify(body, secret, header, signedAt + 300, 300)).toBe(true);
    expect(verify(body, secret, header, signedAt - 300, 300)).toBe(true);
    expect(verify(body, secret, header, signedAt + 301, 300)).toBe(false);
    expect(verify(body, secret, header, signedAt - 301, 300)).toBe(false);
  });

  test("MISMATCH: tampered body", () => {
    const header = sign(body, secret, signedAt);
    const { ok, reason } = verifyWithReason(body + "tamper", secret, header, freshNow);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISMATCH);
  });

  test("UNKNOWN_VERSION: header with only unrecognised version prefix", () => {
    const { ok, reason } = verifyWithReason(
      body,
      secret,
      "t=1700000000,v3=abc123",
      freshNow,
    );
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("UNKNOWN_VERSION: fails closed — does not fall through to accept", () => {
    // Even if the body+secret+timestamp would produce a valid HMAC for v1,
    // a header advertising only v3 must be rejected.
    const validV1Header = sign(body, secret, signedAt);
    const v1sig = validV1Header.split(",")[1]; // "v1=<hex>"
    const fakev3Header = `t=${signedAt},v3=${v1sig.slice(3)}`; // same hex, wrong prefix
    const { ok, reason } = verifyWithReason(body, secret, fakev3Header, freshNow);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("MISSING_T: no t= field", () => {
    const validV1Header = sign(body, secret, signedAt);
    const v1Part = validV1Header.split(",")[1];
    const { ok, reason } = verifyWithReason(body, secret, v1Part, freshNow);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISSING_T);
  });

  test("MALFORMED: empty header", () => {
    const { ok, reason } = verifyWithReason(body, secret, "", freshNow);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MALFORMED);
  });

  test("MALFORMED: non-string header", () => {
    const { ok, reason } = verifyWithReason(body, secret, null, freshNow);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MALFORMED);
  });

  test("MISSING_T: t= field is not a finite integer", () => {
    const { ok, reason } = verifyWithReason(body, secret, "t=NaN,v1=abc", freshNow);
    expect(ok).toBe(false);
    // NaN.parseInt → NaN → not finite → MISSING_T
    expect(reason).toBe(VerifyReason.MISSING_T);
  });

  test("MISMATCH: v1 length wrong (short hex, not a valid digest)", () => {
    const { ok, reason } = verifyWithReason(body, secret, `t=${signedAt},v1=abcd`, freshNow);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISMATCH);
  });
});

// ─── Version-prefix parsing ───────────────────────────────────────────────────

describe("webhookSign version-prefix parsing", () => {
  const secret = "test-secret-1";
  const body = '{"event":"test"}';
  const ts = 1700000000;

  test("v1 prefix is recognised", () => {
    const header = sign(body, secret, ts);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(verify(body, secret, header, ts)).toBe(true);
  });

  test("future v2 prefix (only v2=, no v1=) is rejected as UNKNOWN_VERSION", () => {
    // We don't know v2 yet; it should fail closed.
    const fakeV2Header = `t=${ts},v2=deadbeefdeadbeef`;
    const { reason } = verifyWithReason(body, secret, fakeV2Header, ts);
    expect(reason).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("dual-sign header (v1 + hypothetical v2 both present) accepts via v1", () => {
    // During a future algorithm transition the server may emit both v1 and v2.
    // The verifier accepts if *any* known version validates correctly.
    const v1Header = sign(body, secret, ts);
    const v1sig = v1Header.split(",")[1]; // "v1=<hex>"
    const dualHeader = `t=${ts},${v1sig},v2=somefuturehex`;
    // Our current verifier only understands v1; v2 is ignored after v1 passes.
    expect(verify(body, secret, dualHeader, ts)).toBe(true);
  });

  test("header with extra unknown k=v pairs is still accepted if v1 is valid", () => {
    // Tolerate forward-compatible extra fields.
    const validHeader = sign(body, secret, ts);
    const extended = `${validHeader},x-custom=some-value`;
    expect(verify(body, secret, extended, ts)).toBe(true);
  });
});

// ─── Configurable replay window ───────────────────────────────────────────────

describe("webhookSign configurable replay window", () => {
  const secret = "mysecret";
  const body = "hello";
  const ts = 1700000000;

  test("custom 60-second window rejects a 90-second-old signature", () => {
    const header = sign(body, secret, ts);
    expect(verify(body, secret, header, ts + 90, 60)).toBe(false);
  });

  test("custom 600-second window accepts a 9-minute-old signature", () => {
    const header = sign(body, secret, ts);
    expect(verify(body, secret, header, ts + 540, 600)).toBe(true);
  });

  test("zero-second window rejects anything not at exactly now", () => {
    const header = sign(body, secret, ts);
    expect(verify(body, secret, header, ts, 0)).toBe(true);
    expect(verify(body, secret, header, ts + 1, 0)).toBe(false);
  });
});
