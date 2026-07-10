// Runs against the compiled output: `npm run build` first (npm test does both).
//
// Guards issue #7. n8n instantiates the chat model from its own LangChain copy.
// If this package ever resolves a @langchain/core whose messages are not branded
// with Symbol.for("langchain.message"), @langchain/openai silently drops
// tool_call_id from tool results and every provider answers 400.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { ToolMessage } = require('@langchain/core/messages');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
// DynamicStructuredTool lives in core in both majors, so this file survives the
// move from `langchain/tools` to `@langchain/classic/tools`.
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { ChatOpenAI } = require('@langchain/openai');
const { z } = require('zod');

const { createAgentExecutor } = require('../dist/nodes/AgentLangfuse/execute');

const TOOL_CALL_ID = 'call_toolcallid_probe';
const MESSAGE_BRAND = Symbol.for('langchain.message');

test('messages built by this package carry the brand core 1.x checks for', () => {
  // The root cause of #7 in two assertions. `ToolMessage.isInstance` exists in
  // both majors and returns true for its own messages, so it discriminates
  // nothing. What core 1.x actually checks is this brand plus a `type`
  // property, and a core 0.3 message has neither.
  const message = new ToolMessage({ content: 'ok', tool_call_id: TOOL_CALL_ID });
  assert.ok(MESSAGE_BRAND in message, 'message is not branded');
  assert.equal(message.type, 'tool');
});

// Minimal OpenAI Chat Completions mock. First turn asks for a tool call,
// second turn answers. Records every request body it receives.
function startMockProvider(bodies) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const isFirstTurn = bodies.length === 1;
      const message = isFirstTurn
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: TOOL_CALL_ID,
                type: 'function',
                function: { name: 'get_answer', arguments: '{"question":"life"}' },
              },
            ],
          }
        : { role: 'assistant', content: '42' };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-probe',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o-mini',
          choices: [
            {
              index: 0,
              message,
              finish_reason: isFirstTurn ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test('a tool result reaches the provider carrying its tool_call_id', async () => {
  const bodies = [];
  const { server, baseURL } = await startMockProvider(bodies);

  try {
    const model = new ChatOpenAI({
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      temperature: 0,
      maxRetries: 0,
      configuration: { baseURL },
    });

    const tool = new DynamicStructuredTool({
      name: 'get_answer',
      description: 'Returns the answer.',
      schema: z.object({ question: z.string() }),
      func: async () => '42',
    });

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', '{system_message}'],
      ['placeholder', '{chat_history}'],
      ['human', '{input}'],
      ['placeholder', '{agent_scratchpad}'],
    ]);

    const executor = createAgentExecutor(
      model,
      [tool],
      prompt,
      { maxIterations: 3 },
      undefined,
      undefined,
      null,
      false,
    );

    const result = await executor.invoke({
      input: 'What is the answer?',
      system_message: 'You are a helpful assistant',
    });

    assert.equal(result.output, '42');
    assert.equal(bodies.length, 2, 'the agent should call the provider twice');

    const toolMessages = bodies[1].messages.filter((m) => m.role === 'tool');
    assert.equal(toolMessages.length, 1, 'the second request must carry the tool result');
    assert.equal(toolMessages[0].tool_call_id, TOOL_CALL_ID);
  } finally {
    server.close();
  }
});
