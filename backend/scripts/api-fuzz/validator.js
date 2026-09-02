"use strict";

/**
 * validator.js — minimal JSON-Schema validator for API fuzz + conformance (#1101 WS4).
 *
 * Supports the keyword subset actually used by docs/api/openapi.yaml so it can
 * (a) prove generated "valid" cases are genuinely valid, (b) prove generated
 * "invalid" cases genuinely violate the schema, and (c) validate live API
 * response bodies against their declared response schema. This deliberately
 * mirrors the request/response schemas rather than pulling in a full validator,
 * keeping the module dependency-free so it runs both in the backend jest suite
 * and from the repo-root scripts/validate-openapi.js wrapper.
 *
 * Supported: $ref, oneOf/anyOf (first branch), type, enum, format (uuid,
 * date-time, date, email, byte — format is advisory), pattern, minLength,
 * maxLength, minimum, maximum, exclusiveMinimum/Maximum, required, properties,
 * additionalProperties, items, minItems, maxItems, nullable, default, const.
 */

const SUPPORTED_FORMATS = {
  "date-time": (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
  date: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
  uuid: (v) =>
    typeof v === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
      v,
    ),
  email: (v) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  byte: (v) => typeof v === "string",
  // Advisory numeric/other formats: accept, but only check the types above.
  double: () => true,
  float: () => true,
  int32: () => true,
  int64: () => true,
  null: () => true,
};

const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  null(v) {
    return v === null;
  },
};

function resolveRef(schema, components, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const name = String(schema.$ref).split("/").pop();
    if (seen.has(name)) return schema;
    const next = new Set(seen).add(name);
    const target = components && components.schemas && components.schemas[name];
    return target ? resolveRef(target, components, next) : {};
  }
  return schema;
}

/**
 * Validate `value` against `schema`.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(value, schema, components = {}, seen = new Set()) {
  const errors = [];
  check(value, schema, components, seen, errors, "$");
  return { valid: errors.length === 0, errors };
}

function check(value, schema, components, seen, errors, pathName) {
  const s = resolveRef(schema, components, seen);
  if (!s || typeof s !== "object") return;

  if (s.const !== undefined && s.const !== value) {
    errors.push(`${pathName}: expected const ${JSON.stringify(s.const)}`);
    return;
  }

  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || !s.enum.includes(value)) {
      errors.push(`${pathName}: not in enum ${JSON.stringify(s.enum)}`);
      return;
    }
  }

  if (Array.isArray(s.oneOf) && s.oneOf.length) {
    const ok = s.oneOf.some((b) => validate(value, b, components).valid);
    if (!ok) errors.push(`${pathName}: does not match any oneOf branch`);
    return;
  }
  if (Array.isArray(s.anyOf) && s.anyOf.length) {
    const ok = s.anyOf.some((b) => validate(value, b, components).valid);
    if (!ok) errors.push(`${pathName}: does not match any anyOf branch`);
    return;
  }

  // nullable — allow null in addition to the declared type (must be checked
  // before the type guard, otherwise null fails the type check and returns).
  if (value === null && s.nullable === true) return;

  const type = s.type;
  if (type) {
    if (Array.isArray(type)) {
      if (!type.some((t) => (TYPE_CHECKS[t] ? TYPE_CHECKS[t](value) : false))) {
        errors.push(`${pathName}: expected one of [${type.join(", ")}]`);
        return;
      }
    } else if (!(TYPE_CHECKS[type] && TYPE_CHECKS[type](value))) {
      errors.push(`${pathName}: expected type ${type}, got ${jsonType(value)}`);
      return;
    }
  }

  switch (type) {
  case "string":
    checkString(value, s, errors, pathName);
    break;
  case "number":
  case "integer":
    checkNumber(value, s, errors, pathName);
    break;
  case "array":
    checkArray(value, s, components, seen, errors, pathName);
    break;
  case "object":
    checkObject(value, s, components, seen, errors, pathName);
    break;
  default:
    // no explicit type: try structural checks
    if (s.properties) checkObject(value, s, components, seen, errors, pathName);
    if (s.items) checkArray(value, s, components, seen, errors, pathName);
    break;
  }
}

function checkString(value, s, errors, pathName) {
  if (typeof value !== "string") return;
  if (typeof s.minLength === "number" && value.length < s.minLength)
    errors.push(`${pathName}: shorter than minLength ${s.minLength}`);
  if (typeof s.maxLength === "number" && value.length > s.maxLength)
    errors.push(`${pathName}: longer than maxLength ${s.maxLength}`);
  if (s.pattern) {
    let re;
    try {
      re = new RegExp(s.pattern);
    } catch {
      re = null;
    }
    if (re && !re.test(value))
      errors.push(`${pathName}: does not match ${s.pattern}`);
  }
  if (
    s.format &&
    SUPPORTED_FORMATS[s.format] &&
    !SUPPORTED_FORMATS[s.format](value)
  )
    errors.push(`${pathName}: invalid ${s.format} format`);
}

function checkNumber(value, s, errors, pathName) {
  if (typeof value !== "number") return;
  if (typeof s.minimum === "number" && value < s.minimum)
    errors.push(`${pathName}: below minimum ${s.minimum}`);
  if (typeof s.maximum === "number" && value > s.maximum)
    errors.push(`${pathName}: above maximum ${s.maximum}`);
  if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum)
    errors.push(`${pathName}: below exclusiveMinimum ${s.exclusiveMinimum}`);
  if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum)
    errors.push(`${pathName}: above exclusiveMaximum ${s.exclusiveMaximum}`);
  if (s.type === "integer" && !Number.isInteger(value))
    errors.push(`${pathName}: expected integer`);
}

function checkArray(value, s, components, seen, errors, pathName) {
  if (!Array.isArray(value)) return;
  if (typeof s.minItems === "number" && value.length < s.minItems)
    errors.push(`${pathName}: fewer than minItems ${s.minItems}`);
  if (typeof s.maxItems === "number" && value.length > s.maxItems)
    errors.push(`${pathName}: more than maxItems ${s.maxItems}`);
  if (s.items) {
    value.forEach((item, i) =>
      check(item, s.items, components, seen, errors, `${pathName}[${i}]`),
    );
  }
}

function checkObject(value, s, components, seen, errors, pathName) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const props = s.properties || {};
  const required = Array.isArray(s.required) ? s.required : [];
  const extraAllowed = s.additionalProperties !== false;

  for (const key of required) {
    if (!(key in value))
      errors.push(`${pathName}: missing required property "${key}"`);
  }
  for (const [key, sub] of Object.entries(props)) {
    if (key in value) {
      check(value[key], sub, components, seen, errors, `${pathName}.${key}`);
    }
  }
  if (!extraAllowed) {
    for (const key of Object.keys(value)) {
      if (!(key in props))
        errors.push(`${pathName}: unexpected property "${key}"`);
    }
  }
}

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Convenience: single boolean result (renamed to avoid shadowing Node's util).
 */
function isValid(value, schema, components) {
  return validate(value, schema, components).valid;
}

module.exports = {
  validate,
  isValid,
  resolveRef,
  SUPPORTED_FORMATS,
};
