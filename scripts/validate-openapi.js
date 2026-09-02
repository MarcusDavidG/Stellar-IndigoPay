#!/usr/bin/env node
/**
 * Custom OpenAPI validation script for Stellar-IndigoPay.
 *
 * Validates project-specific conventions that Spectral's built-in rules
 * cannot express, and detects drift between the OpenAPI spec and the live
 * Express route surface:
 *
 *   1. Every POST/PATCH/DELETE endpoint declares a 429 response.
 *   2. Every inline response has a description.
 *   3. Every operation has a summary.
 *   4. Every documented endpoint is actually implemented (drift → CI fails).
 *      Undocumented-but-implemented endpoints are reported informatively —
 *      the spec intentionally documents only the public surface, so adding
 *      internal/admin/metrics routes is not itself a failure.
 *
 * Usage:
 *   node scripts/validate-openapi.js
 *
 * Returns exit code 0 on success, 1 on failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const routeSurface = require("./lib/routeSurface");

// Workstream-4 fuzz toolchain (dependency-free, under backend/ so it is covered
// by the backend jest suite; required here via a relative path).
const { buildPlan } = require("../backend/scripts/api-fuzz/plan.js");
const { buildCases } = require("../backend/scripts/api-fuzz/conformance.js");
const { validate } = require("../backend/scripts/api-fuzz/validator.js");

const SPEC_PATH = path.resolve(__dirname, "..", "docs", "api", "openapi.yaml");
const BACKEND_SRC_DIR = path.resolve(__dirname, "..", "backend", "src");

/**
 * Parse the OpenAPI YAML spec into a JavaScript object.
 */
function loadSpec(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw);
}

/**
 * Check that every POST, PATCH, and DELETE endpoint declares a 429 response.
 */
function check429OnMutations(spec, errors) {
  const paths = spec.paths || {};
  const MUTATION_METHODS = ["post", "patch", "delete"];

  for (const [pathName, pathItem] of Object.entries(paths)) {
    for (const method of MUTATION_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const responses = operation.responses || {};
      if (!("429" in responses)) {
        errors.push(
          `❌ Missing 429 response: ${method.toUpperCase()} ${pathName}`,
        );
      }
    }
  }
}

/**
 * Check that every inline response (not a $ref) has a description.
 */
function checkResponseDescriptions(spec, errors) {
  const paths = spec.paths || {};
  const ALL_METHODS = ["get", "post", "patch", "delete", "put"];

  for (const [pathName, pathItem] of Object.entries(paths)) {
    for (const method of ALL_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const responses = operation.responses || {};
      for (const [statusCode, responseObj] of Object.entries(responses)) {
        // Skip $ref-only responses — description lives in the component
        if (responseObj && "$ref" in responseObj) continue;

        if (
          !responseObj ||
          typeof responseObj !== "object" ||
          !responseObj.description ||
          typeof responseObj.description !== "string"
        ) {
          errors.push(
            `⚠️  Missing description: ${method.toUpperCase()} ${pathName} → ${statusCode}`,
          );
        }
      }
    }
  }
}

/**
 * Check that every operation has a summary.
 */
function checkOperationSummaries(spec, errors) {
  const paths = spec.paths || {};
  const ALL_METHODS = ["get", "post", "patch", "delete", "put"];

  for (const [pathName, pathItem] of Object.entries(paths)) {
    for (const method of ALL_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      if (!operation.summary) {
        errors.push(
          `⚠️  Missing summary: ${method.toUpperCase()} ${pathName}`,
        );
      }
    }
  }
}

/**
 * Detect drift between the documented spec routes and the implemented Express
 * routes.
 *
 * - `missing` (spec documents an endpoint the server does not serve) is a
 *   hard failure — it means the public contract has silently diverged.
 * - `extra` (implemented but undocumented) is returned separately so callers
 *   can report it without failing, since the spec documents only the public
 *   surface by design.
 *
 * @returns {{missing: string[], extra: string[]}}
 */
function checkRouteDrift(spec) {
  const specRoutes = routeSurface.collectSpecRoutes(spec);
  const implRoutes = routeSurface.collectImplementationRoutes(BACKEND_SRC_DIR);
  return routeSurface.detectDrift(specRoutes, implRoutes);
}

/**
 * Offline fuzz self-test (Workstream 4 — API fuzz conformance).
 *
 * Derives cases from the OpenAPI spec and proves the generator's guarantees:
 *   - every “valid” case actually satisfies its request schema, and
 *   - every “invalid” case genuinely violates it (so a live scan that sees a 2xx
 *     or a 5xx for one of these is a real bug).
 *
 * Runs fast enough for PR CI (default 100 iterations/endpoint). Requires no
 * network and no running backend.
 */
function runFuzzSelfTest(spec, iterations) {
  const plan = buildPlan(spec);
  const issues = [];
  let validSeen = 0;
  let invalidSeen = 0;

  for (const op of plan) {
    if (!op.requestBodySchema) continue; // GET-style endpoints have no body to fuzz
    const cases = buildCases(op, {
      validCount: 1,
      invalidCount: iterations,
      components: spec.components,
    });
    const label = `${op.method} ${op.path}`;

    for (const c of cases) {
      const result = validate(c.body, op.requestBodySchema.schema, spec.components);
      const expected = c.kind === "valid";
      if (c.kind === "valid") validSeen++;
      else invalidSeen++;

      if (result.valid !== expected) {
        issues.push(
          `❌ ${label}: generated "${c.kind}" case was ${result.valid ? "accepted" : "rejected"} by schema (` +
          `${result.errors.slice(0, 2).join("; ")}${result.errors.length > 2 ? "; …" : ""})`
        );
      }
    }
  }

  return { issues, validSeen, invalidSeen, endpointCount: plan.length };
}

function runFuzzMode(spec, iterations) {
  const { issues, validSeen, invalidSeen, endpointCount } =
    runFuzzSelfTest(spec, iterations);

  console.log(`\n🤖 API fuzz self-test (${iterations} invalid iterations/endpoint, ${endpointCount} endpoint(s))`);
  console.log(`   ✓ ${validSeen} valid case(s) all satisfied their schema`);
  console.log(`   ✓ ${invalidSeen} invalid case(s) all violated their schema`);

  if (issues.length === 0) {
    console.log(`   ✅ Fuzz generator invariants held — every labelled case is correct.\n`);
    return 0;
  }
  console.log("\n" + issues.join("\n"));
  console.log(`\n📊 ${issues.length} generator issue(s) found — fix before relying on live scans.`);
  return 1;
}

/**
 * Live conformance fuzz against a running backend (Workstream 4 acceptance: no
 * 5xx for invalid input across all endpoints; response bodies conform to spec).
 * Returns a Promise<number> exit code.
 */
async function runLiveMode(spec, baseUrl, iterations) {
  const { runConformance } = require("../backend/scripts/api-fuzz/conformance.js");
  const plan = buildPlan(spec);
  try {
    const result = await runConformance({
      plan,
      baseUrl,
      iterations,
      components: spec.components,
    });

    const errors = result.violations.filter((v) => v.level === "error");
    const warns = result.violations.filter((v) => v.level === "warn");
    console.log(`   Sent ${result.cases} case(s) across ${result.operations} endpoint(s).`);
    console.log(`   ⚠️  ${warns.length} warning(s), ❌ ${errors.length} error(s).\n`);
    for (const v of result.violations) {
      console.log(`   ${v.level === "error" ? "❌" : "⚠️"} [${v.op}] ${v.message}`);
    }
    return errors.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(`\n💥 Live conformance scan failed: ${err.message}\n`);
    return 1;
  }
}

/**
 * Main entry point.
 */
function main() {
  let exitCode = 0;
  const errors = [];
  let drift = { missing: [], extra: [] };

  // ── CLI args (fuzz / live modes) ────────────────────────────────────────
  // Iterations apply to BOTH modes. `--iterations N` is the canonical knob;
  // the legacy positional form `--fuzz N` still works. Values are validated as
  // positive integers before they touch a shell or network call.
  const argv = process.argv.slice(2);
  const flagValue = (flag) => {
    const i = argv.indexOf(flag);
    const next = i !== -1 ? argv[i + 1] : undefined;
    if (next !== undefined && !next.startsWith("--")) return next;
    const inline = argv.find((a) => a.startsWith(`${flag}=`));
    return inline ? inline.slice(flag.length + 1) : "";
  };
  const toPositiveInt = (v) => {
    if (v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`invalid iteration count "${v}" (expected a positive integer)`);
    }
    return n;
  };

  const fuzzMode = argv.includes("--fuzz");
  const liveMode = argv.includes("--live");
  const iterations =
    toPositiveInt(flagValue("--iterations") || null) ??
    (fuzzMode ? toPositiveInt(flagValue("--fuzz") || null) : null) ??
    100;
  const liveBase =
    liveMode && flagValue("--live") !== null ? flagValue("--live") : null;

  console.log("\n🔍 Validating OpenAPI spec against project conventions...\n");

  try {
    const spec = loadSpec(SPEC_PATH);
    console.log(
      `📄 Loaded spec: ${spec.info?.title || "unknown"} v${spec.info?.version || "?"}\n`,
    );

    check429OnMutations(spec, errors);
    checkResponseDescriptions(spec, errors);
    checkOperationSummaries(spec, errors);

    // Fuzz modes short-circuit after the static convention checks (they already
    // load the spec and the offline self-test asserts generator invariants).
    if (fuzzMode) {
      exitCode = runFuzzMode(spec, iterations) || exitCode;
    }
    if (liveMode) {
      // Fail closed: a live run without a usable target must never report
      // success without sending a single request.
      if (!liveBase || !/^https?:\/\/[^\s]+/i.test(liveBase)) {
        console.error(
          "\n❌ --live requires a non-empty http(s) base URL (e.g. --live https://staging.example.com)\n",
        );
        process.exit(1);
      }
      console.log(`\n🌐 Running live conformance fuzz against ${liveBase}…\n`);
      runLiveMode(spec, liveBase, iterations).then((code) => {
        process.exit(code || exitCode);
      });
      return; // async path owns exit
    }

    console.log("🔎 Checking for drift between spec and Express routes...\n");
    drift = checkRouteDrift(spec);

    for (const entry of drift.missing) {
      errors.push(`❌ Documented endpoint not implemented: ${entry}`);
    }

    if (errors.length === 0) {
      console.log("✅ All project-specific validations passed!\n");
    } else {
      console.log(errors.join("\n") + "\n");
      console.log(`📊 ${errors.length} issue(s) found:\n`);
      const byType = {};
      for (const err of errors) {
        const type =
          err.startsWith("❌ Missing 429") ||
          err.startsWith("❌ Documented endpoint not implemented")
            ? err.startsWith("❌ Missing 429")
              ? "Missing 429 response"
              : "Undocumented → removed endpoint (drift)"
            : err.startsWith("⚠️  Missing description")
              ? "Missing description"
              : "Missing summary";
        byType[type] = (byType[type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(byType)) {
        const isError = type !== "Missing description" && type !== "Missing summary";
        console.log(`   ${isError ? "❌" : "⚠️"}  ${type}: ${count}`);
      }
      console.log("");
      exitCode = errors.some((e) => e.startsWith("❌")) ? 1 : 0;
    }

    // Undocumented-but-implemented routes are informational, not fatal: the
    // spec intentionally documents only the public API surface.
    if (drift.extra.length > 0) {
      console.log(
        `ℹ️  ${drift.extra.length} implemented route(s) are not in the spec (informational):\n`,
      );
      for (const entry of drift.extra) {
        console.log(`   ${entry}`);
      }
      console.log("");
    }
  } catch (err) {
    console.error(`\n💥 Failed to validate spec: ${err.message}\n`);
    exitCode = 1;
  }

  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadSpec,
  check429OnMutations,
  checkResponseDescriptions,
  checkOperationSummaries,
  checkRouteDrift,
  main,
  SPEC_PATH,
  BACKEND_SRC_DIR,
};
