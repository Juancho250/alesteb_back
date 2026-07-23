const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  AURA_STAGING_MODE: process.env.AURA_STAGING_MODE,
  AURA_MOCK_PROVIDER_ENABLED: process.env.AURA_MOCK_PROVIDER_ENABLED,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
};

process.env.NODE_ENV = "test";
process.env.AURA_STAGING_MODE = "false";
process.env.AURA_MOCK_PROVIDER_ENABLED = "false";
process.env.OPENAI_API_KEY = "sk-test-aura-provider-secret";
process.env.OPENAI_MODEL = ' "gpt-5.6-luna" ';

const validTool = {
  type: "function",
  name: "get_sales_summary",
  description: "Resumen de ventas.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      period: { type: "string", enum: ["today"] },
    },
    required: ["period"],
  },
};

const toolsPath = require.resolve("../services/auraTools.service");
const originalToolsCache = require.cache[toolsPath];
require.cache[toolsPath] = {
  id: toolsPath,
  filename: toolsPath,
  loaded: true,
  exports: {
    MAX_TOOL_ROUNDS: 3,
    MAX_TOOLS_PER_RUN: 5,
    getOpenAITools: () => [validTool],
    async runAuraToolCall() {
      throw new Error("No tool call expected in provider contract tests");
    },
  },
};

const openAIPath = require.resolve("../src/modules/aura/core/openai.service");
delete require.cache[openAIPath];
const auraOpenAI = require("../src/modules/aura/core/openai.service");

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantMarker = "TENANT_PRIVATE_REVENUE_999";

function input() {
  return {
    message: "Resume el negocio sin exponer owner@example.test",
    history: [{ role: "assistant", content: "Contexto anterior privado" }],
    businessContext: {
      insights: {},
      promptContext: {
        period: { today: "2026-07-19" },
        metrics: { privateMarker: tenantMarker },
      },
    },
    toolContext: {
      ownerAdminId: 101,
      userId: 11,
      roles: ["admin"],
      requestId,
    },
  };
}

function completedResponse() {
  return {
    data: {
      id: "resp-test",
      model: "gpt-5.6-luna",
      output_text: JSON.stringify({ reply: "OK", suggestedActions: [] }),
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  };
}

function openAIError(status, error, axiosCode = "ERR_BAD_REQUEST") {
  const err = new Error(`Request failed with status code ${status}`);
  err.code = axiosCode;
  err.response = { status, data: { error } };
  return err;
}

async function withAxiosPost(implementation, operation) {
  const originalPost = axios.post;
  axios.post = implementation;
  try {
    return await operation();
  } finally {
    axios.post = originalPost;
  }
}

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[openAIPath];
  if (originalToolsCache) require.cache[toolsPath] = originalToolsCache;
  else delete require.cache[toolsPath];
});

test("minimal Responses API payload contains only normalized model and input", () => {
  const payload = auraOpenAI.buildOpenAIResponsePayload({
    model: ' "gpt-5.6-luna" ',
    input: "Responde unicamente OK",
  });

  assert.deepEqual(payload, {
    model: "gpt-5.6-luna",
    input: "Responde unicamente OK",
  });
});

test("complete Responses API payload uses current field and function tool shapes", async () => {
  let captured;
  const result = await withAxiosPost(async (url, payload, config) => {
    captured = { url, payload, config };
    return completedResponse();
  }, () => auraOpenAI.generateAuraReply(input()));

  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.payload.model, "gpt-5.6-luna");
  assert.equal(captured.payload.input[0].role, "user");
  assert.equal(captured.payload.input[0].content[0].type, "input_text");
  assert.equal(typeof captured.payload.instructions, "string");
  assert.equal(captured.payload.tools[0].name, "get_sales_summary");
  assert.equal(Object.prototype.hasOwnProperty.call(captured.payload.tools[0], "function"), false);
  assert.equal(captured.payload.tool_choice, "auto");
  assert.equal(captured.payload.max_output_tokens, 900);
  assert.deepEqual(captured.payload.reasoning, { effort: "low" });
  assert.equal(Object.prototype.hasOwnProperty.call(captured.payload, "messages"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.payload, "max_tokens"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.payload, "response_format"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.payload, "temperature"), false);
  assert.match(captured.config.headers.Authorization, /^Bearer /);
  assert.equal(result.reply, "OK");
});

test("OpenAI 400 diagnostics preserve the exact sanitized schema error only", async () => {
  const providerMessage = "Invalid schema for function 'get_sales_summary': In context=(), 'required' is required to be supplied and to be an array including every key in properties. Missing 'dateFrom'.";
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (line) => logs.push(String(line));

  try {
    await assert.rejects(
      () => withAxiosPost(
        async () => {
          throw openAIError(400, {
            type: "invalid_request_error",
            code: "invalid_function_parameters",
            param: "tools[0].parameters",
            message: providerMessage,
          });
        },
        () => auraOpenAI.generateAuraReply(input())
      ),
      (err) => {
        assert.equal(err.code, "AURA_OPENAI_ERROR");
        assert.equal(err.auditCode, "AURA_OPENAI_BAD_REQUEST");
        assert.equal(err.providerStatus, 400);
        assert.equal(err.message, providerMessage);
        return true;
      }
    );
  } finally {
    console.error = originalConsoleError;
  }

  const serialized = logs.find((line) => line.includes("aura_openai_request_failed"));
  const event = JSON.parse(serialized);
  assert.equal(event.status, 400);
  assert.deepEqual(event.error, {
    type: "invalid_request_error",
    code: "invalid_function_parameters",
    param: "tools[0].parameters",
    message: providerMessage,
  });
  assert.equal(event.model, "gpt-5.6-luna");
  assert.equal(event.requestId, requestId);
  assert.equal(event.toolCount, 1);
  assert.ok(event.inputBytes > 0);
  assert.ok(event.error.message.length <= 300);
  assert.equal(serialized.includes(process.env.OPENAI_API_KEY), false);
  assert.equal(serialized.includes(tenantMarker), false);
  assert.equal(serialized.includes("Contexto anterior privado"), false);
});

test("OpenAI authentication, model, rate limit and provider errors remain distinct internally", async () => {
  const cases = [
    {
      status: 401,
      providerCode: "invalid_api_key",
      message: `Incorrect API key provided: ${process.env.OPENAI_API_KEY}`,
      publicCode: "AURA_OPENAI_ERROR",
      auditCode: "AURA_OPENAI_AUTHENTICATION_ERROR",
    },
    {
      status: 403,
      providerCode: "project_permission_denied",
      message: "Project does not have permission to use this resource.",
      publicCode: "AURA_OPENAI_ERROR",
      auditCode: "AURA_OPENAI_PERMISSION_ERROR",
    },
    {
      status: 404,
      providerCode: "model_not_found",
      message: "The requested model does not exist or is not accessible.",
      publicCode: "AURA_OPENAI_ERROR",
      auditCode: "AURA_OPENAI_MODEL_NOT_FOUND",
    },
    {
      status: 429,
      providerCode: "rate_limit_exceeded",
      message: "Rate limit reached.",
      publicCode: "AURA_OPENAI_RATE_LIMIT",
      auditCode: "AURA_OPENAI_RATE_LIMIT",
    },
    {
      status: 503,
      providerCode: "server_error",
      message: "The provider is temporarily unavailable.",
      publicCode: "AURA_OPENAI_ERROR",
      auditCode: "AURA_OPENAI_UNAVAILABLE",
    },
  ];

  const logs = [];
  const originalConsoleError = console.error;
  console.error = (line) => logs.push(String(line));
  try {
    for (const item of cases) {
      await assert.rejects(
        () => withAxiosPost(
          async () => {
            throw openAIError(item.status, {
              type: "invalid_request_error",
              code: item.providerCode,
              param: item.status === 404 ? "model" : null,
              message: item.message,
            });
          },
          () => auraOpenAI.generateAuraReply(input())
        ),
        (err) => {
          assert.equal(err.code, item.publicCode);
          assert.equal(err.auditCode, item.auditCode);
          assert.equal(err.providerStatus, item.status);
          return true;
        }
      );
    }
  } finally {
    console.error = originalConsoleError;
  }

  const serializedLogs = logs.join("\n");
  assert.equal(serializedLogs.includes(process.env.OPENAI_API_KEY), false);
  assert.match(serializedLogs, /\[redacted-secret\]/);
});

test("OpenAI timeout is cancelled and classified without provider payload leakage", async () => {
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (line) => logs.push(String(line));
  try {
    await assert.rejects(
      () => withAxiosPost(
        async () => {
          const err = new Error("timeout of 18000ms exceeded");
          err.code = "ECONNABORTED";
          throw err;
        },
        () => auraOpenAI.generateAuraReply(input())
      ),
      (err) => {
        assert.equal(err.code, "AURA_OPENAI_TIMEOUT");
        assert.equal(err.auditCode, "AURA_OPENAI_TIMEOUT");
        assert.equal(err.providerStatus, null);
        return true;
      }
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(logs.join("\n").includes(tenantMarker), false);
});
