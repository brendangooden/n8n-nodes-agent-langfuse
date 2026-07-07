// Runs against the compiled output: `npm run build` first (npm test does both).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveBaseUrl } = require('../dist/nodes/AgentLangfuse/langfuse');

const CLOUD = 'https://cloud.langfuse.com';
const SELF_HOSTED = 'https://langfuse.example.com';

test('uses url when it is the only field set', () => {
  assert.equal(resolveBaseUrl({ url: SELF_HOSTED }), SELF_HOSTED);
});

test('url wins over a host injected by a colliding credential schema (cloud default)', () => {
  // The observed prod failure: official @langfuse/n8n-nodes-langfuse schema
  // wins load order and n8n injects its `host` default into stored {url} data.
  assert.equal(resolveBaseUrl({ url: SELF_HOSTED, host: CLOUD }), SELF_HOSTED);
});

test('url wins over host even when host is a custom value', () => {
  assert.equal(
    resolveBaseUrl({ url: SELF_HOSTED, host: 'https://other.example.com' }),
    SELF_HOSTED,
  );
});

test('falls back to host when url is absent', () => {
  // Back-compat: credential data written against the official schema, or the
  // interim mitigation of injecting `host` directly into stored data.
  assert.equal(resolveBaseUrl({ host: SELF_HOSTED }), SELF_HOSTED);
});

test('falls back to host when url is an empty string', () => {
  assert.equal(resolveBaseUrl({ url: '', host: SELF_HOSTED }), SELF_HOSTED);
});

test('falls back to baseUrl when url and host are absent', () => {
  assert.equal(resolveBaseUrl({ baseUrl: SELF_HOSTED }), SELF_HOSTED);
});

test('defaults to Langfuse Cloud when nothing is set', () => {
  assert.equal(resolveBaseUrl({}), CLOUD);
});
