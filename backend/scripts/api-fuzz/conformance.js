"use strict";

/**
 * conformance.js — live API conformance fuzz runner (#1101 WS4).
 *
 * Drives a running backend with schema-derived valid + invalid requests and
 * verifies:
 *   - responses are within the OpenAPI-declared status codes,
 *   - invalid input never produces a 5xx (it must be a 4xx — a 5xx is a bug),
 *   - valid requests returning 2xx JSON conform to the declared response schema.
 *
 * Uses Node's global `fetch` (Node ≥18), so it needs no network dependencies.
 * The runner itself is deterministic given a seed; aggregate violations are
 * returned so CI can fail on any 5xx / schema violation.
 */

const {
  generateValidValue,
  mutationStrategies,
  reset,
} = require("./values.js");
const { validate } = require("./validator.js");

function defaultLogger(...args) {
  // no-op by default; callers pass a logger to surface progress
}

/**
 * Build the fuzz cases for a single operation.
 * @param {object} op operation descriptor from buildPlan
 * @param {object} options { validCount, invalidCount, seed }
 * @returns {Array<{kind:string,label:string,body:any}>}
 */
function buildCases(op, { validCount = 1, invalidCount = 1, seed = 1 } = {}) {
  const cases = [];
  const bodySchema = op.requestBodySchema;

  if (!bodySchema) {
    // No body → emit a single GET-style probe. There is no body schema to
    // violate, so fabricating invalid bodies would only cause transport errors
    // (e.g. GET-with-body) rather than meaningful checks.
    cases.push({ kind: "valid", label: "no-body", body: undefined });
    return cases;
  }

  const validBodies = generateValidBodies(bodySchema.schema, validCount);
  validBodies.forEach((body, i) =>
    cases.push({ kind: "valid", label: `valid-${i}`, body }),
  );

  for (let i = 0; i < invalidCount; i++) {
    const body = generateInvalidValue(bodySchema.schema, validBodies[0]);
    cases.push({
      kind: "invalid",
      label: `invalid-${i}:${body.__strategy__ || "fallback"}`,
      // Always take the unwrapped value; it may legitimately be `undefined`
      // (wrong-object-type on an empty schema), so marker on __strategy__.
      body: body.__strategy__ !== undefined ? body.__value__ : body,
    });
  }
  return cases;
}

function generateValidBodies(schema, count) {
  const out = [];
  for (let i = 0; i < count; i++)
    out.push(generateValidValue(schema, null, new Set()));
  return out;
}

/**
 * Produce a payload that the schema validator *confirms* is invalid.
 *
 * Rather than trusting a static “guaranteed” flag (over-length on an
 * unconstrained string is not provably invalid), we apply mutation strategies and
 * keep the first whose result the validator rejects. If no strategy renders the
 * payload invalid, we force-invalidate via a wrong root type — the only
 * universally-invalid construction. This guarantees every labelled-invalid case
 * truly violates the schema, which is what makes the “no 5xx for invalid input”
 * live-scan criterion mean something.
 */
function generateInvalidValue(schema, validBase) {
  const base =
    validBase !== undefined
      ? JSON.parse(JSON.stringify(validBase))
      : generateValidValue(schema, null, new Set());
  const mutators = mutationStrategies(schema, null).slice(1);
  const attempts = Math.max(1, mutators.length * 2);
  for (let i = 0; i < attempts; i++) {
    const m = mutators[Math.floor(Math.random() * mutators.length)];
    const mutated = m(JSON.parse(JSON.stringify(base)));
    const verdict = validate(mutated, schema, null, new Set());
    if (!verdict.valid) {
      return { __strategy__: m.name, __value__: mutated };
    }
  }
  return {
    __strategy__: "forced-root-type",
    __value__: forcedInvalidRoot(schema, base),
  };
}

/**
 * A value that is invalid for *any* schema: flip to the opposite root type.
 */
function forcedInvalidRoot(schema, base) {
  const s = schema && typeof schema === "object" ? schema : {};
  const type = s.type;
  if (type === "string") return { forced: "object-instead-of-string" };
  if (type === "boolean") return "true";
  if (type === "number" || type === "integer") return "NaN";
  if (type === "array") return { forced: "object-instead-of-array" };
  if (type === "object" || s.properties || Array.isArray(s.required))
    return null;
  // Unconstrained — break by returning an array when base is an object, etc.
  if (base && typeof base === "object" && !Array.isArray(base))
    return "string-for-object";
  if (Array.isArray(base)) return { array: "for-scalar" };
  return null;
}

/**
 * Run the conformance scan.
 * @param {object} opts { plan, baseUrl, iterations, seed, log }
 * @returns {Promise<object>} summary { operations, cases, violations: [], byEndpoint }
 */
async function runConformance({
  plan,
  baseUrl,
  iterations = 100,
  seed = Date.now(),
  log = defaultLogger,
}) {
  reset(seed);
  const violations = [];
  let totalCases = 0;
  const byEndpoint = {};

  for (const op of plan) {
    const cases = buildCases(op, {
      validCount: 1,
      invalidCount: iterations,
      seed,
    });
    const stats = {
      sent: 0,
      twoxx: 0,
      fourxx: 0,
      fivexx: 0,
      other: 0,
      allowed: 0,
      schemaViolations: 0,
    };
    totalCases += cases.length;
    byEndpoint[op.method + " " + op.path] = stats;

    const url = buildUrl(baseUrl, op, cases[0]);

    for (const c of cases) {
      stats.sent++;
      let res;
      try {
        res = await sendCase(url, op.method, c);
      } catch (err) {
        constrain(violations, {
          op: `${op.method} ${op.path}`,
          kind: c.kind,
          label: c.label,
          level: "error",
          message: `transport error (${err.message || err})`,
        });
        log(`  ✗ [${c.kind}] ${op.method} ${op.path} — transport error`);
        stats.other++;
        continue;
      }

      const status = res.status;
      if (status >= 200 && status < 300) stats.twoxx++;
      else if (status >= 400 && status < 500) stats.fourxx++;
      else if (status >= 500) stats.fivexx++;
      else stats.other++;

      const allowed = op.allowedResponses.some(
        (code) => parseInt(String(code), 10) === status,
      );
      if (allowed) stats.allowed++;

      // A 5xx on *any* input is a bug; on invalid input it is explicitly the
      // acceptance failure.
      if (status >= 500) {
        constrain(violations, {
          op: `${op.method} ${op.path}`,
          kind: c.kind,
          label: c.label,
          body: summarizeBody(c.body),
          status,
          level: "error",
          message: `5xx returned (${status})${allowed ? "" : " and not in defined responses"} — invalid input caused a server error`,
        });
        log(`  ✗ [${c.kind}] ${op.method} ${op.path} — ${status}`);
        continue;
      }

      if (!allowed) {
        // Not a 5xx but outside the declared codes — still worth flagging.
        constrain(violations, {
          op: `${op.method} ${op.path}`,
          kind: c.kind,
          label: c.label,
          status,
          level: "warn",
          message: `status ${status} not declared in OpenAPI responses [${op.allowedResponses.join(", ")}]`,
        });
        log(`  ⚠️ [${c.kind}] ${op.method} ${op.path} — unexpected ${status}`);
        continue;
      }

      // Invalid input must never be accepted (4xx). A 2xx with garbage is a bug
      // worth surfacing as a warning.
      if (c.kind === "invalid" && status >= 200 && status < 300) {
        constrain(violations, {
          op: `${op.method} ${op.path}`,
          kind: c.kind,
          label: c.label,
          status,
          level: "warn",
          message: `invalid input accepted with ${status} — schema validation may be bypassed`,
        });
        log(
          `  ⚠️ [${c.kind}] ${op.method} ${op.path} — invalid input accepted`,
        );
      }

      // Response-schema conformance for 2xx with a JSON body.
      if (status >= 200 && status < 300 && op.successSchema) {
        const body = await readJsonSafely(res);
        if (body.parsed != null && typeof body.parsed === "object") {
          const v = validate(body.parsed, op.successSchema, null, new Set());
          if (!v.valid) {
            stats.schemaViolations++;
            constrain(violations, {
              op: `${op.method} ${op.path}`,
              kind: c.kind,
              label: c.label,
              status,
              level: "error",
              message: `response body violates OpenAPI schema: ${v.errors.slice(0, 3).join("; ")}`,
            });
            log(`  ✗ [${c.kind}] ${op.method} ${op.path} — schema violation`);
          }
        }
      }
    }
  }

  return { operations: plan.length, cases: totalCases, violations, byEndpoint };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildUrl(baseUrl, op, firstCase) {
  let url = baseUrl.replace(/\/$/, "") + fillPathParams(op.path, op.parameters);
  return url;
}

function fillPathParams(path, parameters) {
  return path.replace(/\{([^}]+)\}/g, (_, name) => {
    const p = parameters.find((x) => x.in === "path" && x.name === name);
    if (p && p.example) return p.example;
    return "00000000-0000-4000-8000-000000000000";
  });
}

async function sendCase(url, method, c) {
  const hasBody = c.body !== undefined;
  const init = { method };
  if (hasBody) {
    init.headers = { "Content-Type": "application/json" };
    // Violating bodies are still valid JSON; when a strategy yields `undefined`
    // (wrong-type object → undefined) we send `null`.
    init.body = JSON.stringify(c.body === undefined ? null : c.body);
  }
  return fetch(url, init);
}

async function readJsonSafely(res) {
  try {
    const text = await res.text();
    if (!text) return { parsed: null };
    return { parsed: JSON.parse(text) };
  } catch {
    return { parsed: null };
  }
}

function summarizeBody(body) {
  if (body === undefined || body === null) return body;
  const s = JSON.stringify(body);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

function constrain(list, item) {
  // De-duplicate near-identical violations to keep reports readable.
  const i = list.length - 1;
  if (i >= 0 && list[i].op === item.op && list[i].message === item.message)
    return;
  list.push(item);
}

module.exports = { buildCases, runConformance };
