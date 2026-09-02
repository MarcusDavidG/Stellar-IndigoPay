# Webhook Signature Algorithm Versioning Policy

This document describes how IndigoPay versions its webhook signature algorithm,
how clients should parse the signature header, and how future algorithm upgrades
will be rolled out without breaking existing integrations.

## Current algorithm — v1

| Property | Value |
|----------|-------|
| Algorithm | HMAC-SHA256 |
| Signed content | `<timestamp>.<body>` (UTF-8) |
| Header format | `t=<unix seconds>,v1=<hex digest>` |
| Replay window | ±300 s (configurable via `WEBHOOK_REPLAY_WINDOW_SECONDS`) |

The `v1=` prefix is the algorithm version identifier. It is a fixed part of
the header and must be present for a signature to be accepted.

## Header format

```text
X-Webhook-Signature: t=<unix>,v1=<hex hmac-sha256>
```

The header is a comma-separated list of `k=v` pairs. Parsers must:

1. Split on `,` to get tokens.
2. For each token, split on the **first** `=` only (values may contain `=`,
   e.g. future base64-encoded signatures).
3. Handle the `t` key (timestamp) and any recognised version key (`v1`).
4. Ignore unknown keys for forward compatibility — **unless** no recognised
   version key is present, in which case the signature must be rejected
   (`UNKNOWN_VERSION`, fail-closed).

## Error codes

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `OK` | — | Signature valid |
| `MALFORMED` | 400 | Header absent, empty, or not parseable |
| `MISSING_T` | 400 | `t=` field absent or not a finite safe integer (exact decimal) |
| `MISSING_V1` | 400 | `v1=` field absent or empty |
| `UNKNOWN_VERSION` | 403 | Header contains no recognised version prefix |
| `STALE` | 408 | Timestamp outside the replay window (clock skew or replay) |
| `MISMATCH` | 401 | HMAC does not match (tampered body or wrong secret) |

The `X-Webhook-Signature-Reason` response header carries the machine-readable
code on all error responses so clients can log it without parsing the body.

## Replay protection

The timestamp `t` is bound into the signed content (`<t>.<body>`), so an
attacker cannot replay an old signature against a new timestamp. Receivers must
reject signatures whose `t` differs from local clock by more than the replay
window (default ±300 s).

`STALE` is a separate error code from `MISMATCH` so receivers can alert on
clock-synchronisation issues independently of actual forgery attempts.

## Introducing a future v2 algorithm

When a new algorithm becomes necessary (e.g. migration away from HMAC-SHA256):

### Phase 1 — dual-sign (minimum 90 days)

The server begins emitting **both** v1 and v2 in every outbound signature:

```text
X-Webhook-Signature: t=<unix>,v1=<hex-hmac-sha256>,v2=<new-algo-output>
```

Receivers that only understand v1 continue to work — they validate `v1` and
ignore `v2`. Receivers that have upgraded can validate `v2` and ignore `v1`.

The verifier accepts if **any** valid version passes (logical OR over
recognised version keys).

### Phase 2 — v2 only

After the dual-sign window, the server stops emitting `v1`. Receivers that
have not upgraded will start receiving `UNKNOWN_VERSION` errors, which is the
intended failure signal.

### Phase 3 — v1 key retirement

The v1 signing keys are rotated out of the secret store. The verifier no
longer accepts `v1=` in inbound headers.

### Timeline

| Phase | Duration | What changes |
|-------|----------|--------------|
| Announcement | 30 days before Phase 1 | Release notes + email to webhook partners |
| Dual-sign | ≥ 90 days | Both v1 and v2 in every outbound header |
| v2 only | Indefinite | v1 dropped from outbound; UNKNOWN_VERSION returned to legacy clients |
| v1 retirement | After ≥ 180 days total | v1 verification keys retired |

### Accept-Signature negotiation (future consideration)

If the partner ecosystem adopts an `Accept-Signature` request header
(analogous to `Accept` for content negotiation), receivers could advertise
which versions they support:

```text
Accept-Signature: v1, v2
```

The server would then emit only the intersection. This is not currently
implemented but the header parsing model is compatible with it.

## Canonical test vectors

`backend/src/lib/webhookSign.vectors.json` contains machine-readable test
vectors that any implementation must reproduce exactly. The vectors are locked
by `webhookSign.vectors.test.js` — CI fails if the implementation diverges.

See `docs/webhook-receiver.md` for cross-language verification examples
(Node, Python, Go, Ruby, PHP).

## Secret rotation

Signing secrets are stored per project in `projects.webhook_secret`. Rotation
is a one-step cutover: update the secret in the admin console; IndigoPay uses
the new value on the next delivery. There is no overlap window for secrets —
coordinate the cutover with the receiver before rotating.

For bulk secret rotation (e.g. following a compromise), use the admin API
`POST /admin/projects/:id/rotate-webhook-secret` which invalidates the old
secret immediately and re-enqueues any pending deliveries with the new secret.
