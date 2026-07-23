// Runs against the compiled output: `npm run build` first (npm test does both).
//
// These two functions are derived from n8n's ToolsAgent/common.ts. The tests
// below pin them to what n8n's agent does today, so a user who swaps the native
// agent for this node sees the same final answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  handleAgentFinishOutput,
  getAgentStepsParser,
} = require('../dist/nodes/AgentLangfuse/execute');

// --------------------------------------------------------------------------
// handleAgentFinishOutput: a final answer arrives as an array of content blocks
// --------------------------------------------------------------------------

const finish = (output) => handleAgentFinishOutput({ returnValues: { output } });

test('joins the text blocks of a multi block answer', () => {
  const steps = finish([
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ]);
  assert.equal(steps.returnValues.output, 'first\nsecond');
});

test('drops thinking blocks when the answer also has text', () => {
  // An extended reasoning model (Claude) emits its scratchpad as a `thinking`
  // block alongside the answer. Returning it would leak the reasoning to the
  // user and, with an output parser downstream, corrupt the parse.
  const steps = finish([
    { type: 'thinking', thinking: 'the user asked for X, so...' },
    { type: 'text', text: 'the answer' },
  ]);
  assert.equal(steps.returnValues.output, 'the answer');
});

test('falls back to the thinking blocks when there is no text at all', () => {
  const steps = finish([
    { type: 'thinking', thinking: 'step one' },
    { type: 'thinking', thinking: 'step two' },
  ]);
  assert.equal(steps.returnValues.output, 'step one\nstep two');
});

test('yields an empty string when no block carries text or thinking', () => {
  const steps = finish([{ type: 'image', source: {} }]);
  assert.equal(steps.returnValues.output, '');
});

test('treats a text block with an empty string as absent', () => {
  const steps = finish([{ type: 'text', text: '' }, { type: 'thinking', thinking: 'T' }]);
  assert.equal(steps.returnValues.output, 'T');
});

test('leaves a plain string answer untouched', () => {
  const steps = finish('already a string');
  assert.equal(steps.returnValues.output, 'already a string');
});

test('leaves steps without returnValues untouched', () => {
  const steps = { log: 'no return values here' };
  assert.deepEqual(handleAgentFinishOutput(steps), { log: 'no return values here' });
});

// --------------------------------------------------------------------------
// getAgentStepsParser: what reaches the output parser
// --------------------------------------------------------------------------

/** Captures the string the parser is handed, which is what we are asserting on. */
function spyParser() {
  const seen = [];
  return {
    seen,
    parse: async (input) => {
      seen.push(input);
      return { parsed: true };
    },
  };
}

const parseFinal = async (parser, output) =>
  await getAgentStepsParser(parser, undefined)({ returnValues: { output } });

test('does not wrap an output that is already shaped {output: ...}', async () => {
  // The model, asked to answer through the parser tool, already produced the
  // wrapper. Wrapping it again gives the parser {"output":{"output":"hi"}} and
  // the schema rejects it.
  const parser = spyParser();
  await parseFinal(parser, '{"output":"hi"}');
  assert.deepEqual(parser.seen, ['{"output":"hi"}']);
});

test('wraps an object answer that carries more than the output key', async () => {
  const parser = spyParser();
  await parseFinal(parser, '{"output":"hi","confidence":0.9}');
  assert.deepEqual(parser.seen, ['{"output":{"output":"hi","confidence":0.9}}']);
});

test('wraps a scalar answer', async () => {
  const parser = spyParser();
  await parseFinal(parser, '42');
  assert.deepEqual(parser.seen, ['{"output":42}']);
});

test('wraps an array answer', async () => {
  const parser = spyParser();
  await parseFinal(parser, '["a","b"]');
  assert.deepEqual(parser.seen, ['{"output":["a","b"]}']);
});

test('passes a non JSON answer straight through', async () => {
  const parser = spyParser();
  await parseFinal(parser, 'just prose');
  assert.deepEqual(parser.seen, ['just prose']);
});

test('wraps a null answer rather than mistaking it for a wrapper', async () => {
  const parser = spyParser();
  await parseFinal(parser, 'null');
  assert.deepEqual(parser.seen, ['{"output":null}']);
});
