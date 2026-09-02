# Stellar-IndigoPay Webhook Receiver Guide

IndigoPay sends signed HTTP POSTs to project-configured URLs whenever
a milestone is reached. The body, headers, retry policy, and
verification flow are designed to be easy to consume in any language.

## Delivery Headers

| Header                  | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `X-Webhook-Id`          | Stable event id (sha256 of canonical milestone fields). Use for **idempotent dedup**. |
| `X-Webhook-Event-Type`  | Currently always `milestone.reached`.                                                 |
| `X-Webhook-Delivery-Id` | Internal `webhook_deliveries` row uuid.                                               |
| `X-Webhook-Timestamp`   | Unix seconds at sign time.                                                            |
| `X-Webhook-Signature`   | `t=<unix>,v1=<hex hmac-sha256(secret, "<ts>.<body>")>` — see [Algorithm Versioning](webhook-signing-versioning.md) |
| `X-Webhook-Attempt`     | 1-based attempt counter.                                                              |
| `User-Agent`            | `Stellar-IndigoPay-Webhook/1.0`                                                       |
| `Content-Type`          | `application/json`                                                                    |

### Signature header format

```text
X-Webhook-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
```

The header is a comma-separated list of `k=v` pairs. `v1` is the algorithm
version identifier — **always check for it explicitly**. Headers containing
only unrecognised version prefixes (e.g. `v3=...`) must be rejected. During
a future algorithm transition the server will emit both `v1=` and `v2=`;
accept if any recognised version validates.

See [webhook-signing-versioning.md](webhook-signing-versioning.md) for the
full versioning policy, error codes, and migration path.

### Signature error codes

Your verifier should return structured reason codes so you can distinguish
different failure modes:

| Reason | HTTP (inbound) | Meaning |
|--------|---------------|---------|
| `MALFORMED` | 400 | Header absent, empty, or not parseable |
| `MISSING_T` | 400 | `t=` field absent or not a finite safe integer (exact decimal) |
| `MISSING_V1` | 400 | `v1=` field absent or empty |
| `UNKNOWN_VERSION` | 403 | No recognised version prefix — fail-closed |
| `STALE` | 408 | Timestamp outside replay window — check clock sync |
| `MISMATCH` | 401 | HMAC mismatch — tampered body or wrong secret |

## Body

```json
{
  "id": "8e1b…", // mirrors X-Webhook-Id
  "type": "milestone.reached",
  "event": "milestone.reached",
  "projectId": "f0c9…",
  "milestoneId": "0d3a…",
  "milestone": "First canopy planted",
  "percentage": 25,
  "totalRaisedXLM": "1234.5000000",
  "timestamp": "2026-07-09T10:30:00.000Z"
}
```

The raw body **must** be used verbatim for signature verification. If
your framework re-serializes the JSON, sign the bytes you actually
received, not the parsed object.

## Signature Verification

```js
const crypto = require("crypto");

// Error reason codes — mirror VerifyReason in webhookSign.js
const Reason = {
  OK: "OK",
  MALFORMED: "MALFORMED",
  MISSING_T: "MISSING_T",
  MISSING_V1: "MISSING_V1",
  UNKNOWN_VERSION: "UNKNOWN_VERSION",
  STALE: "STALE",
  MISMATCH: "MISMATCH",
};

function verify(body, secret, header) {
  if (typeof header !== "string" || header.length === 0)
    return { ok: false, reason: Reason.MALFORMED };

  // Parse comma-separated k=v pairs (split on first '=' only)
  const parts = Object.fromEntries(
    header.split(",").map((token) => {
      const eq = token.indexOf("=");
      return eq === -1
        ? [token.trim(), ""]
        : [token.slice(0, eq).trim(), token.slice(eq + 1).trim()];
    }),
  );

  // Timestamp must be exact decimal safe integer (no partial/fractional)
  if (typeof parts.t !== "string" || !/^-?\d+$/.test(parts.t)) return { ok: false, reason: Reason.MISSING_T };
  const t = Number(parts.t);
  if (!Number.isSafeInteger(t)) return { ok: false, reason: Reason.MISSING_T };

  // v1 presence/emptiness before generic unknown-version check
  if (Object.prototype.hasOwnProperty.call(parts, "v1")) {
    if (typeof parts.v1 !== "string" || parts.v1.length === 0) return { ok: false, reason: Reason.MISSING_V1 };
  } else {
    const hasKnown = ["v1"].some((v) => parts[v] !== undefined && parts[v] !== "");
    if (!hasKnown) return { ok: false, reason: Reason.UNKNOWN_VERSION };
    return { ok: false, reason: Reason.MISSING_V1 };
  }
  const v1 = parts.v1;

  // Replay window: reject events whose timestamp is more than the configured
  // window (default 5 minutes) away from local clock. STALE is distinct from
  // MISMATCH so you can alert on clock-synchronisation issues separately.
  const REPLAY_WINDOW_SECONDS = 5 * 60; // configurable — must match server
  const skew = Math.abs(Math.floor(Date.now() / 1000) - t);
  if (skew > REPLAY_WINDOW_SECONDS) return { ok: false, reason: Reason.STALE };

  const prefix = Buffer.from(`${t}.`, "utf8");
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([prefix, bodyBuf]))
    .digest();
  const got = Buffer.from(v1, "hex");
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected))
    return { ok: false, reason: Reason.MISMATCH };

  return { ok: true, reason: Reason.OK };
}
```

## Retry Policy

IndigoPay retries on any non-2xx response or network failure with the
following backoff: 30s → 2m → 10m → 30m → 2h → 6h (six attempts).
After the final failure the event is moved to `webhook_dlq` and the
project owner is expected to inspect it via the admin audit log.

## Idempotency

Use `X-Webhook-Id` as a **stable dedup key**. IndigoPay will never
deliver two different bodies with the same id. Persist it alongside
the processing result so retries are safe.

## Replay Defense

- Reject events whose `X-Webhook-Timestamp` is more than **5 minutes**
  away from your local clock.
- Persist `X-Webhook-Id` for at least the project's retry window
  (~6 hours) to absorb a slow receiver that eventually catches up.

## Sample Receivers

### Node (Express)

```js
app.post(
  "/indigopay/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const result = verify(
      req.body,
      process.env.WEBHOOK_SECRET,
      req.get("X-Webhook-Signature"),
    );
    if (!result.ok) return res.status(401).json({ error: result.reason });
    const event = JSON.parse(req.body.toString("utf8"));
    // process event.id idempotently
    res.status(204).end();
  },
);
```

### Go (net/http)

```go
func verify(secret, body, header string) (bool, string) {
  parts := strings.SplitN(header, ",", 2)
  if len(parts) != 2 { return false, "malformed" }
  ts, v1 := strings.TrimPrefix(parts[0], "t="), strings.TrimPrefix(parts[1], "v1=")
  mac := hmac.New(sha256.New, []byte(secret))
  mac.Write([]byte(ts + "." + body))
  expected := hex.EncodeToString(mac.Sum(nil))
  if !hmac.Equal([]byte(expected), []byte(v1)) { return false, "mismatch" }
  if math.Abs(float64(time.Now().Unix() - parseTs(ts))) > 300 {
    return false, "stale"
  }
  return true, ""
}
```

### Python (Flask)

```python
import hmac, hashlib, time
from flask import request, abort

def verify(secret: str, body: bytes, header: str) -> bool:
    t, _, v1 = header.partition(",")
    if not t.startswith("t=") or not v1.startswith("v1="):
        return False
    ts = int(t[2:]); sig = v1[3:]
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, sig): return False
    if abs(int(time.time()) - ts) > 300: return False
    return True

@app.post("/indigopay/webhook")
def webhook():
    if not verify(SECRET, request.get_data(), request.headers["X-Webhook-Signature"]):
        abort(401)
    # process request.get_json() idempotently using request.headers["X-Webhook-Id"]
    return "", 204
```

## Rotating the Secret

The signing secret is stored per project in `projects.webhook_secret`.
Update it from the admin console (or via a direct SQL update if you
provisioned it manually). IndigoPay will use the new value on the
**next** signed delivery — there is no overlap window, so coordinate
the cutover with your receiver's first successful verification.
