// Runs against the compiled output: `npm run build` first (npm test does both).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isGeminiModel,
  sanitizeGeminiSchema,
  sanitizeToolsForGemini,
} = require('../dist/nodes/AgentLangfuse/geminiSchema');

// ---------------------------------------------------------------------------
// isGeminiModel
// ---------------------------------------------------------------------------

test('isGeminiModel detects a model by lc_namespace', () => {
  // These are the REAL lc_namespace values of the current LangChain classes,
  // verified by constructing @langchain/google-genai ChatGoogleGenerativeAI
  // and @langchain/google-vertexai ChatVertexAI (see dev worklog).
  assert.equal(isGeminiModel({ lc_namespace: ['langchain', 'chat_models', 'google_genai'] }), true);
  assert.equal(isGeminiModel({ lc_namespace: ['langchain', 'chat_models', 'vertexai'] }), true);
});

test('isGeminiModel detects a model by constructor name', () => {
  // Real constructor names of the current LangChain Google chat models.
  class ChatGoogleGenerativeAI {}
  class ChatVertexAI {}
  assert.equal(isGeminiModel(new ChatGoogleGenerativeAI()), true);
  assert.equal(isGeminiModel(new ChatVertexAI()), true);
});

test('isGeminiModel is false for OpenAI/Anthropic and junk', () => {
  class ChatOpenAI {}
  class ChatAnthropic {}
  assert.equal(isGeminiModel(new ChatOpenAI()), false);
  assert.equal(isGeminiModel(new ChatAnthropic()), false);
  assert.equal(isGeminiModel({ lc_namespace: ['langchain', 'chat_models', 'openai'] }), false);
  assert.equal(isGeminiModel(null), false);
  assert.equal(isGeminiModel(undefined), false);
});

// ---------------------------------------------------------------------------
// sanitizeGeminiSchema
// ---------------------------------------------------------------------------

test('strips unsupported JSON-schema keywords', () => {
  const out = sanitizeGeminiSchema({
    type: 'object',
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 10, pattern: '^x' },
      count: { type: 'number', exclusiveMinimum: 0, multipleOf: 2 },
    },
  });
  assert.equal('additionalProperties' in out, false);
  assert.equal('$schema' in out, false);
  assert.equal('minLength' in out.properties.name, false);
  assert.equal('maxLength' in out.properties.name, false);
  assert.equal('pattern' in out.properties.name, false);
  assert.equal('exclusiveMinimum' in out.properties.count, false);
  assert.equal('multipleOf' in out.properties.count, false);
  // supported keywords survive
  assert.equal(out.type, 'object');
  assert.equal(out.properties.name.type, 'string');
});

test('drops unsupported string formats but keeps date-time/enum', () => {
  const out = sanitizeGeminiSchema({
    type: 'object',
    properties: {
      website: { type: 'string', format: 'uri' },
      id: { type: 'string', format: 'uuid' },
      when: { type: 'string', format: 'date-time' },
    },
  });
  assert.equal('format' in out.properties.website, false);
  assert.equal('format' in out.properties.id, false);
  assert.equal(out.properties.when.format, 'date-time');
});

test('flattens anyOf to the first object subschema', () => {
  const out = sanitizeGeminiSchema({
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'null' },
    ],
  });
  assert.equal('anyOf' in out, false);
  assert.equal(out.type, 'object');
  assert.deepEqual(Object.keys(out.properties), ['a']);
});

test('object schema without properties gets an empty properties map', () => {
  const out = sanitizeGeminiSchema({ type: 'object' });
  assert.deepEqual(out.properties, {});
});

test('prunes required entries that no longer have a matching property', () => {
  const out = sanitizeGeminiSchema({
    type: 'object',
    required: ['keep', 'gone'],
    properties: { keep: { type: 'string' } },
  });
  assert.deepEqual(out.required, ['keep']);
});

test('drops required entirely when nothing survives', () => {
  const out = sanitizeGeminiSchema({
    type: 'object',
    required: ['gone'],
    properties: {},
  });
  assert.equal('required' in out, false);
});

test('recurses into nested objects and arrays', () => {
  const out = sanitizeGeminiSchema({
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', additionalProperties: true, properties: { x: { type: 'string', format: 'email' } } },
      },
    },
  });
  assert.equal('additionalProperties' in out.properties.items.items, false);
  assert.equal('format' in out.properties.items.items.properties.x, false);
});

// ---------------------------------------------------------------------------
// sanitizeToolsForGemini
// ---------------------------------------------------------------------------

test('sanitizeToolsForGemini rewrites a plain JSON-schema tool in place', () => {
  const tool = {
    name: 'lookup',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { q: { type: 'string', format: 'uri' } },
    },
  };
  sanitizeToolsForGemini([tool]);
  assert.equal('additionalProperties' in tool.schema, false);
  assert.equal('format' in tool.schema.properties.q, false);
});

test('sanitizeToolsForGemini leaves tools without a convertible schema untouched', () => {
  const tool = { name: 'noschema', schema: 42 };
  sanitizeToolsForGemini([tool]);
  assert.equal(tool.schema, 42);
});

// End-to-end structural guarantee: a realistic MCP-style tool schema (which
// carries every keyword Gemini rejects) must come out the other side with
// ZERO forbidden keywords, no unsupported string formats, and every object
// declaring `properties` — i.e. a shape Vertex accepts. This is the offline
// stand-in for a real Vertex call (no Google credentials in the test env).
test('sanitizeToolsForGemini produces a Gemini-safe schema for a realistic MCP tool', () => {
  const FORBIDDEN = [
    '$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties',
    'patternProperties', 'propertyNames', 'default', 'const', 'examples',
    'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
    'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
    'not', 'if', 'then', 'else', 'anyOf', 'oneOf', 'allOf',
  ];
  const ALLOWED_FMT = new Set(['enum', 'date-time']);

  const tool = {
    name: 'mcp_tool',
    schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', format: 'uri' },
        email: { type: 'string', format: 'email', minLength: 3, maxLength: 80, pattern: '@' },
        when: { type: 'string', format: 'date-time' },
        count: { type: 'integer', exclusiveMinimum: 0, multipleOf: 2 },
        mode: { anyOf: [{ type: 'object', properties: { fast: { type: 'boolean' } } }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string', format: 'hostname' }, uniqueItems: true, maxItems: 10 },
        meta: { type: 'object' },
      },
      required: ['url', 'ghost'],
    },
  };

  sanitizeToolsForGemini([tool]);

  const bad = [];
  (function scan(node, path) {
    if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN.includes(k)) bad.push(`${path}.${k}`);
      if (k === 'format' && typeof v === 'string' && !ALLOWED_FMT.has(v)) bad.push(`${path}.format=${v}`);
      if (k === 'type' && v === 'object' && (!node.properties || typeof node.properties !== 'object')) {
        bad.push(`${path} object-without-properties`);
      }
      scan(v, `${path}.${k}`);
    }
  })(tool.schema, 'root');

  assert.deepEqual(bad, [], `forbidden constructs survived: ${bad.join(', ')}`);
  assert.deepEqual(tool.schema.required, ['url']); // dangling 'ghost' pruned
  assert.deepEqual(tool.schema.properties.mode, { type: 'object', properties: { fast: { type: 'boolean' } } });
  assert.deepEqual(tool.schema.properties.meta, { type: 'object', properties: {} });
});
