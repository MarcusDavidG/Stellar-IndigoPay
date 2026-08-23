"use strict";

/**
 * webhookSign.test.js
 *
 * Unit tests for lib/webhookSign.js covering:
 *   - sign() output format and determinism
 *   - verify() boolean convenience wrapper (backward-compatible)
 *   - verifyWithReason() structured error codes
 *   - computeEventId() determinism and sensitivity
 *   - VerifyReason enum values
 *   - _parseHeader() internal helper (exported for tests)
 *
 * Vector conformance (locked signatures, cross-language) is in
 * webhookSign.vectors.test.js.
 */

const {
  sign,
  verify,
  verifyWithReason,
  computeEventId,
  VerifyReason,
  SUPPORTED_VERSIONS,
  DEFAULT_REPLAY_WINDOW_SECONDS,
  _parseHeader,
} = require("./webhookSign");

const secret = "shhh";
const body = JSON.stringify({ hello: "world" });
const t = 1_700_000_000;

// ─── sign() ──────────────────────────────────────────────────────────────────

describe("sign()", () => {
  test("produces t=<unix>,v1=<64-char hex> header", () => {
    const header = sign(body, secret, t);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(header.startsWith(`t=${t},`)).toBe(true);
  });

  test("two calls with the same inputs produce the same signature", () => {
    expect(sign(body, secret, t)).toBe(sign(body, secret, t));
  });

  test("changing the body invalidates the signature", () => {
    expect(sign(body, secret, t)).not.toBe(sign(body + "tamper", secret, t));
  });

  test("changing the secret invalidates the signature", () => {
    expect(sign(body, secret, t)).not.toBe(sign(body, "other-secret", t));
  });

  test("changing the timestamp invalidates the signature", () => {
    expect(sign(body, secret, t)).not.toBe(sign(body, secret, t + 1));
  });

  test("empty body produces a valid header", () => {
    const header = sign("", secret, t);
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });
});

// ─── verify() — boolean wrapper ───────────────────────────────────────────────

describe("verify() — boolean backward-compatible wrapper", () => {
  test("accepts a fresh, valid signature", () => {
    expect(verify(body, secret, sign(body, secret, t), t)).toBe(true);
  });

  test("rejects a signature from > 5 min in the future", () => {
    expect(verify(body, secret, sign(body, secret, t), t + 10 * 60)).toBe(false);
  });

  test("rejects a signature from > 5 min in the past", () => {
    expect(verify(body, secret, sign(body, secret, t), t - 10 * 60)).toBe(false);
  });

  test("rejects a tampered body", () => {
    expect(verify(body + "tamper", secret, sign(body, secret, t), t)).toBe(false);
  });

  test("rejects a malformed header (no parseable k=v)", () => {
    expect(verify(body, secret, "garbage", t)).toBe(false);
  });

  test("rejects an empty header", () => {
    expect(verify(body, secret, "", t)).toBe(false);
  });

  test("rejects when v1 hex is truncated (length mismatch)", () => {
    const header = sign(body, secret, t);
    const [tPart, v1Part] = header.split(",");
    expect(verify(body, secret, `${tPart},${v1Part.slice(2)}`, t)).toBe(false);
  });
});

// ─── verifyWithReason() — structured error codes ─────────────────────────────

describe("verifyWithReason() — structured error codes", () => {
  test("OK: valid signature within window", () => {
    const { ok, reason } = verifyWithReason(body, secret, sign(body, secret, t), t);
    expect(ok).toBe(true);
    expect(reason).toBe(VerifyReason.OK);
  });

  test("MALFORMED: empty header", () => {
    const { ok, reason } = verifyWithReason(body, secret, "", t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MALFORMED);
  });

  test("MALFORMED: null header", () => {
    const { ok, reason } = verifyWithReason(body, secret, null, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MALFORMED);
  });

  test("MALFORMED: undefined header", () => {
    const { ok, reason } = verifyWithReason(body, secret, undefined, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MALFORMED);
  });

  test("MISSING_T: no t= field in header", () => {
    const header = sign(body, secret, t);
    const v1Part = header.split(",")[1]; // just "v1=<hex>"
    const { ok, reason } = verifyWithReason(body, secret, v1Part, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISSING_T);
  });

  test("MISSING_T: t= is not a finite number", () => {
    const { ok, reason } = verifyWithReason(body, secret, "t=abc,v1=deadbeef", t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISSING_T);
  });

  test("MISSING_T: t= is NaN", () => {
    const { ok, reason } = verifyWithReason(body, secret, `t=NaN,v1=abc`, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISSING_T);
  });

  test("UNKNOWN_VERSION: header has only unrecognised version", () => {
    const { ok, reason } = verifyWithReason(
      body, secret, `t=${t},v3=somehex`, t,
    );
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("UNKNOWN_VERSION: completely absent version key", () => {
    // Header has t= but no vN= key at all.
    const { ok, reason } = verifyWithReason(body, secret, `t=${t}`, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.UNKNOWN_VERSION);
  });

  test("STALE: timestamp 10 minutes in the past", () => {
    const header = sign(body, secret, t);
    const { ok, reason } = verifyWithReason(body, secret, header, t + 10 * 60);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.STALE);
  });

  test("STALE: timestamp 10 minutes in the future", () => {
    const header = sign(body, secret, t);
    const { ok, reason } = verifyWithReason(body, secret, header, t - 10 * 60);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.STALE);
  });

  test("MISMATCH: body tampered after signing", () => {
    const header = sign(body, secret, t);
    const { ok, reason } = verifyWithReason(body + "x", secret, header, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISMATCH);
  });

  test("MISMATCH: wrong secret", () => {
    const header = sign(body, secret, t);
    const { ok, reason } = verifyWithReason(body, "wrong", header, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISMATCH);
  });

  test("MISMATCH: short v1 (digest length mismatch)", () => {
    const { ok, reason } = verifyWithReason(body, secret, `t=${t},v1=abcd`, t);
    expect(ok).toBe(false);
    expect(reason).toBe(VerifyReason.MISMATCH);
  });
});

// ─── VerifyReason enum ────────────────────────────────────────────────────────

describe("VerifyReason enum", () => {
  test("exports all expected reason codes", () => {
    expect(VerifyReason.OK).toBe("OK");
    expect(VerifyReason.MALFORMED).toBe("MALFORMED");
    expect(VerifyReason.MISSING_T).toBe("MISSING_T");
    expect(VerifyReason.MISSING_V1).toBe("MISSING_V1");
    expect(VerifyReason.UNKNOWN_VERSION).toBe("UNKNOWN_VERSION");
    expect(VerifyReason.STALE).toBe("STALE");
    expect(VerifyReason.MISMATCH).toBe("MISMATCH");
  });

  test("is frozen (immutable)", () => {
    expect(Object.isFrozen(VerifyReason)).toBe(true);
  });
});

// ─── SUPPORTED_VERSIONS ───────────────────────────────────────────────────────

describe("SUPPORTED_VERSIONS", () => {
  test("includes v1", () => {
    expect(SUPPORTED_VERSIONS).toContain("v1");
  });

  test("is frozen", () => {
    expect(Object.isFrozen(SUPPORTED_VERSIONS)).toBe(true);
  });
});

// ─── DEFAULT_REPLAY_WINDOW_SECONDS ────────────────────────────────────────────

describe("DEFAULT_REPLAY_WINDOW_SECONDS", () => {
  test("is 300 seconds (5 minutes)", () => {
    expect(DEFAULT_REPLAY_WINDOW_SECONDS).toBe(300);
  });
});

// ─── _parseHeader() ──────────────────────────────────────────────────────────

describe("_parseHeader() internal helper", () => {
  test("parses well-formed k=v pairs", () => {
    expect(_parseHeader("t=1700000000,v1=abc")).toEqual({
      t: "1700000000",
      v1: "abc",
    });
  });

  test("handles values that contain = (e.g. base64)", () => {
    expect(_parseHeader("t=123,v2=abc=def==")).toEqual({
      t: "123",
      v2: "abc=def==",
    });
  });

  test("returns empty object for empty string", () => {
    expect(_parseHeader("")).toEqual({});
  });

  test("returns empty object for non-string", () => {
    expect(_parseHeader(null)).toEqual({});
    expect(_parseHeader(undefined)).toEqual({});
  });

  test("trims whitespace from keys", () => {
    expect(_parseHeader(" t =1700000000, v1 =abc")).toEqual({
      t: "1700000000",
      v1: "abc",
    });
  });
});

// ─── computeEventId() ────────────────────────────────────────────────────────

describe("computeEventId()", () => {
  const base = { projectId: "p1", milestoneId: "m1", percentage: 25, raisedXlm: "1.5" };

  test("is deterministic for the same canonical fields", () => {
    expect(computeEventId(base)).toBe(computeEventId({ ...base }));
    expect(computeEventId(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("changes when projectId changes", () => {
    expect(computeEventId(base)).not.toBe(computeEventId({ ...base, projectId: "p2" }));
  });

  test("changes when milestoneId changes", () => {
    expect(computeEventId(base)).not.toBe(computeEventId({ ...base, milestoneId: "m2" }));
  });

  test("changes when percentage changes", () => {
    expect(computeEventId(base)).not.toBe(computeEventId({ ...base, percentage: 26 }));
  });

  test("changes when raisedXlm changes", () => {
    expect(computeEventId(base)).not.toBe(computeEventId({ ...base, raisedXlm: "1.6" }));
  });

  test("handles null milestoneId", () => {
    expect(computeEventId({ ...base, milestoneId: null })).toMatch(/^[a-f0-9]{64}$/);
  });
});
