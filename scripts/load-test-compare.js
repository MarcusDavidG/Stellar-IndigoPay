#!/usr/bin/env node
/**
 * load-test-compare.js — CLI for k6 load-test regression detection (#1101 WS6).
 *
 * Consumes a k6 `--summary-export` JSON file, compares each endpoint against a
 * committed baseline (scripts/load-test-baseline.json), prints a GitHub-flavored
 * PR comment, and exits non-zero when a blocking regression is found.
 *
 * Usage:
 *   node scripts/load-test-compare.js \
 *     --baseline scripts/load-test-baseline.json \
 *     --current /tmp/k6-summary.json \
 *     [--comment | --comment-path pr-comment.md] \
 *     [--warn 20] [--block 50] [--hard 500] [--throughput-warn 10]
 *
 * The comparison logic itself lives in backend/scripts/load-test-compare.js so it
 * is exercised by the backend jest suite; this file is a thin, dependency-free
 * wrapper for humans/CI.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const logic = require("../backend/scripts/load-test-compare.js");

function parseArgs(argv) {
  const args = { commentPath: null, writeComment: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--baseline":
        args.baselinePath = argv[++i];
        break;
      case "--current":
        args.currentPath = argv[++i];
        break;
      case "--comment":
        args.writeComment = true;
        break;
      case "--comment-path":
        args.writeComment = true;
        args.commentPath = argv[++i];
        break;
      case "--warn":
        args.thresholds = args.thresholds || {};
        args.thresholds.latencyWarnPct = Number(argv[++i]);
        break;
      case "--block":
        args.thresholds = args.thresholds || {};
        args.thresholds.latencyBlockPct = Number(argv[++i]);
        break;
      case "--hard":
        args.thresholds = args.thresholds || {};
        args.thresholds.hardLatencyMs = Number(argv[++i]);
        break;
      case "--throughput-warn":
        args.thresholds = args.thresholds || {};
        args.thresholds.throughputWarnPct = Number(argv[++i]);
        break;
      default:
        // ignore flags like --help handled below
        break;
    }
  }
  return args;
}

function readJson(p, label) {
  if (!p) throw new Error(`Missing required argument: ${label} path`);
  return JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`\n💥 ${err.message}\n`);
    process.exit(2);
  }

  let baseline;
  let current;
  try {
    baseline = readJson(args.baselinePath, "--baseline") || {};
    current = readJson(args.currentPath, "--current");
  } catch (err) {
    console.error(`\n💥 Failed to read input files: ${err.message}\n`);
    process.exit(2);
  }

  // --current is the raw k6 summary-export; parse it into endpoint numbers.
  const currentEndpoints = logic.parseK6Summary(current);
  const result = logic.compareBaseline({
    baseline,
    current: currentEndpoints,
    thresholds: args.thresholds,
  });

  const comment = logic.formatPrComment({
    ...result,
    summary: { ...result.summary, ...args.thresholds },
  });

  console.log(comment);
  console.log("");

  if (args.writeComment) {
    const out = args.commentPath || "pr-load-test-comment.md";
    fs.writeFileSync(path.resolve(out), comment + "\n", "utf8");
    console.log(`📝 PR comment written to ${out}`);
  }

  if (result.blocked) {
    console.log("❌ Blocking performance regression detected (exit 1).");
    process.exit(1);
  }
  console.log(
    result.warned
      ? "⚠️ Warnings present, but no blocking regression (exit 0)."
      : "✅ No blocking performance regression (exit 0).",
  );
  process.exit(0);
}

main();
