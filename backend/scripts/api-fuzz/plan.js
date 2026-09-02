"use strict";

/**
 * plan.js — derive a fuzz plan from the OpenAPI spec (#1101 WS4).
 *
 * Walks `paths` and produces a list of operations (method + path + parameter
 * schemas + request-body schema + allowed response codes + success response
 * schema) that the conformance runner and the offline self-test operate on.
 *
 * Depends only on other api-fuzz modules (dependency-free).
 */

const { resolveRef } = require("./values.js");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * Build a fuzz plan from a loaded OpenAPI spec (object).
 * @param {object} spec parsed OpenAPI document
 * @returns {object[]} list of operation descriptors
 */
function buildPlan(spec) {
  if (!spec || !spec.paths || typeof spec.paths !== "object") return [];
  const components = spec.components || {};
  const plan = [];

  for (const [pathName, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      const operation = {
        method: method.toUpperCase(),
        path: pathName,
        operationId: op.operationId || `${method.toUpperCase()} ${pathName}`,
        parameters: [],
        requestBodySchema: null,
        allowedResponses: Object.keys(op.responses || {}),
        successSchema: findSuccessSchema(op, components),
        jsonResponse:
          (op.responses && "200" in op.responses) ||
          (op.responses && "201" in op.responses),
      };
      collectParameters(op, components, operation.parameters);
      operation.requestBodySchema = findRequestBodySchema(op, components);
      plan.push(operation);
    }
  }
  return plan;
}

function collectParameters(op, components, out) {
  const params = op.parameters || [];
  for (const p of params) {
    const resolved = resolveParam(p, components);
    if (!resolved) continue;
    out.push({
      name: resolved.name,
      in: resolved.in, // "query" | "header" | "path"
      required: resolved.required === true,
      schema: resolved.schema
        ? resolveRef(resolved.schema, components, new Set())
        : {},
      example: resolved.example,
    });
  }
}

function resolveParam(p, components) {
  if (p.$ref) {
    const name = String(p.$ref).split("/").pop();
    const target = components.parameters && components.parameters[name];
    return target ? { ...target } : null;
  }
  return p;
}

function findRequestBodySchema(op, components) {
  const rb = op.requestBody;
  if (!rb) return null;
  let body = rb;
  if (rb.$ref) {
    const name = String(rb.$ref).split("/").pop();
    body = (components.requestBodies && components.requestBodies[name]) || {};
  }
  const content = body.content || {};
  const json = content["application/json"];
  if (!json) return null;
  return {
    required: body.required === true,
    schema: json.schema ? resolveRef(json.schema, components, new Set()) : {},
  };
}

function findSuccessSchema(op, components) {
  const responses = op.responses || {};
  // Prefer the first 2xx with a JSON schema.
  for (const code of ["200", "201", "202", "204"]) {
    const resp = responses[code];
    if (!resp || typeof resp !== "object") continue;
    let r = resp;
    if (r.$ref) {
      const name = String(r.$ref).split("/").pop();
      r = (components.responses && components.responses[name]) || {};
    }
    const content = r.content || {};
    const json = content["application/json"];
    if (json && json.schema) {
      return resolveRef(json.schema, components, new Set());
    }
  }
  return null;
}

module.exports = {
  buildPlan,
  collectParameters,
  findRequestBodySchema,
  findSuccessSchema,
};
