"use strict";

/**
 * Tests for the API-fuzz toolchain (#1101 Workstream 4):
 *   - schema-aware valid/invalid value generation (values.js)
 *   - dependency-free JSON-schema validator (validator.js)
 *   - OpenAPI → fuzz-plan extraction (plan.js)
 *   - live conformance runner against an in-process HTTP server (conformance.js)
 *
 * All offline / deterministic — no real backend required.
 */

const http = require("http");
const {
  generateValidValue,
  mutationStrategies,
  reset,
  pick,
} = require("../../scripts/api-fuzz/values.js");
const { validate } = require("../../scripts/api-fuzz/validator.js");
const { buildPlan } = require("../../scripts/api-fuzz/plan.js");
const {
  buildCases,
  runConformance,
} = require("../../scripts/api-fuzz/conformance.js");

// ── Representative schemas (mirrors of docs/api/openapi.yaml) ─────────────

const CREATE_DONATION = {
  type: "object",
  required: ["projectId", "donorAddress", "amountXLM", "transactionHash"],
  properties: {
    projectId: { type: "string", format: "uuid" },
    donorAddress: { type: "string", pattern: "^G[A-Z0-9]{55}$" },
    amountXLM: { type: "number", minimum: 0.0000001 },
    amount: { type: "number" },
    currency: { type: "string", default: "XLM" },
    message: { type: "string", maxLength: 100 },
    transactionHash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
  },
};

const CREATE_PROJECT = {
  type: "object",
  required: ["name", "description", "location", "category", "wallet_address"],
  properties: {
    name: { type: "string", minLength: 3, maxLength: 120 },
    description: { type: "string", minLength: 10, maxLength: 5000 },
    location: { type: "string", minLength: 2, maxLength: 200 },
    category: {
      type: "string",
      enum: [
        "Reforestation",
        "Solar Energy",
        "Ocean Conservation",
        "Clean Water",
        "Wildlife Protection",
        "Carbon Capture",
        "Wind Energy",
        "Sustainable Agriculture",
        "Other",
      ],
    },
    wallet_address: { type: "string", pattern: "^G[A-Z0-9]{55}$" },
    goal_xlm: { type: "number", default: 0 },
    tags: { type: "array", items: { type: "string" } },
  },
};

// ── values.js + validator.js round-trips ──────────────────────────────────

describe("valid value generation", () => {
  beforeEach(() => reset(42));

  test.each([
    ["CreateDonationRequest", CREATE_DONATION],
    ["CreateProjectRequest", CREATE_PROJECT],
  ])("%s produces a schema-valid payload", (_name, schema) => {
    for (let i = 0; i < 50; i++) {
      const v = generateValidValue(schema, null, new Set());
      const r = validate(v, schema);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    }
  });

  test("includes all required fields", () => {
    for (let i = 0; i < 20; i++) {
      const v = generateValidValue(CREATE_DONATION, null, new Set());
      expect(v.projectId).toBeDefined();
      expect(v.donorAddress).toBeDefined();
      expect(v.amountXLM).toBeDefined();
      expect(v.transactionHash).toBeDefined();
    }
  });

  test("respects pattern constraints (stellar address + hex tx hash)", () => {
    const v = generateValidValue(CREATE_DONATION, null, new Set());
    expect(v.donorAddress).toMatch(/^G[A-Z0-9]{55}$/);
    expect(v.transactionHash).toMatch(/^[a-fA-F0-9]{64}$/);
  });
});

describe("invalid value generation", () => {
  beforeEach(() => reset(7));

  describe("guaranteed invalidators", () => {
    test("every guaranteed mutation yields a payload the validator rejects", () => {
      for (let i = 0; i < 60; i++) {
        const base = generateValidValue(CREATE_PROJECT, null, new Set());
        const guaranteed = mutationStrategies(CREATE_PROJECT, null)
          .slice(1)
          .filter((m) => m.guaranteed === true);
        const m = guaranteed[Math.floor(Math.random() * guaranteed.length)];
        const mutated = m(structuredClone(base));
        const r = validate(mutated, CREATE_PROJECT);
        expect(r.errors.length).toBeGreaterThan(0);
      }
    });

    test("soft (chaos) strategies are tagged as not-guaranteed", () => {
      const mutators = mutationStrategies(CREATE_PROJECT, null);
      const soft = mutators.filter((m) => m.guaranteed === false);
      expect(soft.map((m) => m.name)).toEqual(
        expect.arrayContaining(["seed", "sqlInjection", "unicodeHomoglyph"]),
      );
    });
  });

  test("explicit wrong-type mutation is flagged", () => {
    const v = {
      ...generateValidValue(CREATE_DONATION, null, new Set()),
      amountXLM: "not-a-number",
    };
    expect(validate(v, CREATE_DONATION).valid).toBe(false);
  });

  test("missing required field is flagged", () => {
    const v = generateValidValue(CREATE_DONATION, null, new Set());
    delete v.projectId;
    expect(validate(v, CREATE_DONATION).valid).toBe(false);
  });

  test("too-long string is flagged (maxLength)", () => {
    const v = {
      ...generateValidValue(CREATE_DONATION, null, new Set()),
      message: "x".repeat(150),
    };
    const r = validate(v, CREATE_DONATION);
    expect(r.valid).toBe(false);
  });
});

// ── validator.js fine-grained ──────────────────────────────────────────────

describe("validator", () => {
  test("type checks", () => {
    expect(validate("a", { type: "string" }).valid).toBe(true);
    expect(validate(5, { type: "string" }).valid).toBe(false);
    expect(validate(true, { type: "boolean" }).valid).toBe(true);
    expect(validate([], { type: "array" }).valid).toBe(true);
    expect(validate({}, { type: "object" }).valid).toBe(true);
    expect(validate([], { type: "object" }).valid).toBe(false);
  });

  test("numeric bounds", () => {
    expect(validate(5, { type: "integer", minimum: 1, maximum: 5 }).valid).toBe(
      true,
    );
    expect(validate(6, { type: "integer", maximum: 5 }).valid).toBe(false);
    expect(validate(0, { type: "integer", minimum: 1 }).valid).toBe(false);
  });

  test("enum + const", () => {
    expect(validate("a", { enum: ["a", "b"] }).valid).toBe(true);
    expect(validate("z", { enum: ["a", "b"] }).valid).toBe(false);
  });

  test("format uuid + date-time", () => {
    expect(
      validate("550e8400-e29b-41d4-a716-446655440000", {
        type: "string",
        format: "uuid",
      }).valid,
    ).toBe(true);
    expect(
      validate("not-a-uuid", { type: "string", format: "uuid" }).valid,
    ).toBe(false);
    expect(
      validate(new Date().toISOString(), {
        type: "string",
        format: "date-time",
      }).valid,
    ).toBe(true);
  });

  test("$ref resolution through components", () => {
    const components = {
      schemas: {
        Donation: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
            amount: { type: "string" },
          },
        },
      },
    };
    const schema = { $ref: "#/components/schemas/Donation" };
    expect(
      validate(
        { id: "550e8400-e29b-41d4-a716-446655440000" },
        schema,
        components,
      ).valid,
    ).toBe(true);
    expect(validate({ id: "x" }, schema, components).valid).toBe(false);
    expect(validate({}, schema, components).valid).toBe(false);
  });

  test("nullable allows null", () => {
    expect(validate(null, { type: "string", nullable: true }).valid).toBe(true);
    expect(validate(null, { type: "string" }).valid).toBe(false);
  });

  test("additionalProperties: false rejects unknown keys", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    };
    expect(validate({ a: "x" }, schema).valid).toBe(true);
    expect(validate({ a: "x", extra: 1 }, schema).valid).toBe(false);
  });

  test("arrays: items + minItems/maxItems", () => {
    const schema = {
      type: "array",
      items: { type: "integer" },
      minItems: 1,
      maxItems: 3,
    };
    expect(validate([1, 2], schema).valid).toBe(true);
    expect(validate([], schema).valid).toBe(false); // below minItems
    expect(validate([1, 2, 3, 4], schema).valid).toBe(false); // above maxItems
    expect(validate(["a"], schema).valid).toBe(false); // item type
  });
});

// ── plan.js ────────────────────────────────────────────────────────────────

describe("buildPlan", () => {
  const spec = {
    components: {
      schemas: { CreateDonationRequest: CREATE_DONATION },
      parameters: {
        ProjectIdParam: {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        LimitQuery: {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
    paths: {
      "/api/donations": {
        post: {
          operationId: "recordDonation",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateDonationRequest" },
              },
            },
          },
          responses: {
            200: { description: "ok" },
            400: { description: "bad" },
            429: { description: "rl" },
          },
        },
      },
      "/api/projects/{id}": {
        get: {
          operationId: "getProject",
          parameters: [{ $ref: "#/components/parameters/ProjectIdParam" }],
          responses: { 200: { description: "ok" } },
        },
      },
      "/api/projects": {
        get: {
          operationId: "listProjects",
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { success: { type: "boolean" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  test("one operation per HTTP method, with request body and allowed responses", () => {
    const plan = buildPlan(spec);
    const donations = plan.find(
      (o) => o.path === "/api/donations" && o.method === "POST",
    );
    expect(donations).toBeDefined();
    expect(donations.requestBodySchema).toBeTruthy();
    expect(donations.requestBodySchema.schema.projectId).toBeUndefined(); // no $ref leaked
    expect(donations.allowedResponses).toEqual(["200", "400", "429"]);
    expect(donations.successSchema).toBeNull(); // no 2xx json schema on donations here
  });

  test("resolves $ref parameters into query/path descriptors", () => {
    const plan = buildPlan(spec);
    const getProject = plan.find((o) => o.path === "/api/projects/{id}");
    expect(getProject.parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
        example: undefined,
      },
    ]);
  });

  test("extracts a success response schema from a 2xx", () => {
    const plan = buildPlan(spec);
    const list = plan.find((o) => o.operationId === "listProjects");
    expect(list.successSchema).toEqual({
      type: "object",
      properties: { success: { type: "boolean" } },
    });
  });
});

// ── buildCases ─────────────────────────────────────────────────────────────

describe("buildCases", () => {
  beforeEach(() => reset(99));

  const op = {
    method: "POST",
    path: "/api/donations",
    requestBodySchema: { required: true, schema: CREATE_DONATION },
    allowedResponses: ["200", "400", "429"],
    successSchema: null,
  };

  test("returns valid + invalid cases with labels", () => {
    const cases = buildCases(op, { validCount: 2, invalidCount: 5 });
    const valid = cases.filter((c) => c.kind === "valid");
    const invalid = cases.filter((c) => c.kind === "invalid");
    expect(valid.length).toBe(2);
    expect(invalid.length).toBe(5);
    expect(invalid.every((c) => /^invalid-/.test(c.label))).toBe(true);
  });
});

// ── conformance.js vs. an in-process server ─────────────────────────────────

describe("runConformance", () => {
  beforeEach(() => reset(1234));

  test("flags a 5xx returned for invalid input", async () => {
    // A server that 500s on any body missing a required field.
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          const body = JSON.parse(data || "{}");
          if (!body.projectId) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "boom" }));
            return;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              data: { id: "550e8400-e29b-41d4-a716-446655440000" },
            }),
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad" }));
        }
      });
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const op = {
      method: "POST",
      path: "/api/donations",
      requestBodySchema: { required: true, schema: CREATE_DONATION },
      allowedResponses: ["200", "201", "400"],
      successSchema: null,
    };

    try {
      const result = await runConformance({
        plan: [op],
        baseUrl: `http://127.0.0.1:${port}`,
        iterations: 30,
        seed: 5,
      });
      // We expect the runner to have detected 5xx-on-invalid cases.
      const fives = result.violations.filter((v) => v.status >= 500);
      expect(fives.length).toBeGreaterThan(0);
      expect(result.byEndpoint["POST /api/donations"].fivexx).toBeGreaterThan(
        0,
      );
    } finally {
      server.close();
    }
  });

  test("reports zero violations for a well-behaved server", async () => {
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          const body = JSON.parse(data || "{}");
          if (!body.projectId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing projectId" }));
            return;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              data: { id: "550e8400-e29b-41d4-a716-446655440000" },
            }),
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad json" }));
        }
      });
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const op = {
      method: "POST",
      path: "/api/donations",
      requestBodySchema: { required: true, schema: CREATE_DONATION },
      allowedResponses: ["200", "201", "400"],
      successSchema: null,
    };

    try {
      const result = await runConformance({
        plan: [op],
        baseUrl: `http://127.0.0.1:${port}`,
        iterations: 20,
        seed: 5,
      });
      expect(result.violations.filter((v) => v.level === "error")).toEqual([]);
    } finally {
      server.close();
    }
  });

  test("detects a response-body schema violation", async () => {
    // Server returns a body that lacks a required field for valid input.
    const successSchema = {
      type: "object",
      required: ["result"],
      properties: { result: { type: "boolean" } },
    };
    const op = {
      method: "POST",
      path: "/api/x",
      requestBodySchema: { required: true, schema: CREATE_PROJECT },
      allowedResponses: ["200", "201", "400", "422"],
      successSchema,
    };
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          const body = JSON.parse(data || "{}");
          if (!body.name) {
            res.writeHead(422, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "required name" }));
            return;
          }
          // valid input returns a body MISSING `result` → schema violation
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: "not-a-bool" }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad" }));
        }
      });
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
      const result = await runConformance({
        plan: [op],
        baseUrl: `http://127.0.0.1:${port}`,
        iterations: 5,
        seed: 1,
      });
      expect(result.byEndpoint["POST /api/x"].schemaViolations).toBeGreaterThan(
        0,
      );
    } finally {
      server.close();
    }
  });
});

// helper re-export check (keeps test surface honest about the public API)
describe("api-fuzz public helpers", () => {
  test("pick returns an element of the array", () => {
    expect(pick(["a", "b", "c"])).toMatch(/^[abc]$/);
  });
});
