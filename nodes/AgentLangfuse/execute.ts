import { RunnableSequence } from '@langchain/core/runnables';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { HumanMessage } from '@langchain/core/messages';
import { createToolCallingAgent, AgentExecutor, Toolkit } from 'langchain/agents';
import { DynamicStructuredTool } from 'langchain/tools';
import { ChatOpenAI } from '@langchain/openai';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const omit = require('lodash/omit') as <T extends object>(obj: T, ...keys: string[]) => Partial<T>;
import { NodeOperationError, jsonParse, sleep } from 'n8n-workflow';
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { z } from 'zod';

import {
  compilePromptMessages,
  createLangfuseHandler,
  fetchProjectName,
  fetchPrompt,
  flushHandler,
} from './langfuse';
import type { LangfuseCredentials, LangfuseMetadata } from './types';

const SYSTEM_MESSAGE = 'You are a helpful assistant';

// ---------------------------------------------------------------------------
// Helpers inlined from the V2 reference implementation
// ---------------------------------------------------------------------------

function isChatInstance(model: unknown): boolean {
  const namespace = (model as { lc_namespace?: string[] })?.lc_namespace ?? [];
  return namespace.includes('chat_models');
}

async function getChatModel(ctx: IExecuteFunctions, index = 0): Promise<unknown> {
  const connectedModels = await ctx.getInputConnectionData('ai_languageModel', 0);
  let model: unknown;

  if (Array.isArray(connectedModels) && index !== undefined) {
    if (connectedModels.length <= index) {
      return undefined;
    }
    const reversedModels = [...connectedModels].reverse();
    model = reversedModels[index];
  } else {
    model = connectedModels;
  }

  if (!isChatInstance(model) || !(model as { bindTools?: unknown }).bindTools) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Tools Agent requires Chat Model which supports Tools calling',
    );
  }

  return model;
}

async function getOptionalMemory(ctx: IExecuteFunctions): Promise<unknown> {
  return (await ctx.getInputConnectionData('ai_memory', 0)) as unknown;
}

async function getOptionalOutputParser(
  ctx: IExecuteFunctions,
  index = 0,
): Promise<unknown | undefined> {
  if (ctx.getNodeParameter('hasOutputParser', 0, true) === true) {
    return (await ctx.getInputConnectionData('ai_outputParser', index)) as unknown;
  }
  return undefined;
}

function getOutputParserSchema(outputParser: { getSchema?: () => unknown }): unknown {
  return outputParser.getSchema?.() ?? z.object({ text: z.string() });
}

async function getTools(ctx: IExecuteFunctions, outputParser: unknown): Promise<unknown[]> {
  const connectedTools =
    ((await ctx.getInputConnectionData('ai_tool', 0)) as unknown[] | null) ?? [];

  const flatTools = connectedTools.flatMap((toolOrToolkit: unknown) => {
    if (toolOrToolkit instanceof Toolkit) {
      return toolOrToolkit.getTools();
    }
    return toolOrToolkit;
  });

  // Enforce unique names
  const seenNames = new Set<string>();
  const finalTools: unknown[] = [];

  for (const tool of flatTools) {
    const name = (tool as { name: string }).name;
    if (seenNames.has(name)) {
      throw new NodeOperationError(
        ctx.getNode(),
        `You have multiple tools with the same name: '${name}', please rename them to avoid conflicts`,
      );
    }
    seenNames.add(name);
    finalTools.push(tool);
  }

  if (outputParser) {
    const schema = getOutputParserSchema(outputParser as { getSchema?: () => unknown });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const structuredOutputParserTool = new DynamicStructuredTool({
      schema: schema as any,
      name: 'format_final_json_response',
      description:
        'Use this tool to format your final response to the user in a structured JSON format. This tool validates your output against a schema to ensure it meets the required format. ONLY use this tool when you have completed all necessary reasoning and are ready to provide your final answer. Do not use this tool for intermediate steps or for asking questions. The output from this tool will be directly returned to the user.',
      func: async () => '',
    });
    finalTools.push(structuredOutputParserTool);
  }

  return finalTools;
}

function getPromptInputByType(options: {
  ctx: IExecuteFunctions;
  i: number;
  inputKey: string;
  promptTypeKey: string;
}): string | undefined {
  const { ctx, i, promptTypeKey, inputKey } = options;
  const promptType = ctx.getNodeParameter(promptTypeKey, i, 'define') as string;

  let input: string | undefined;
  if (promptType === 'auto') {
    input = ctx.evaluateExpression('{{ $json["chatInput"] }}', i) as string;
  } else {
    input = ctx.getNodeParameter(inputKey, i) as string;
  }

  if (input === undefined) {
    throw new NodeOperationError(ctx.getNode(), 'No prompt specified', {
      description:
        "Expected to find the prompt in an input field called 'chatInput' (this is what the chat trigger node outputs). To use something else, change the 'Prompt' parameter",
    });
  }

  return input;
}

async function extractBinaryMessages(
  ctx: IExecuteFunctions,
  itemIndex: number,
): Promise<HumanMessage> {
  const binaryData = ctx.getInputData()?.[itemIndex]?.binary ?? {};

  const binaryMessages = await Promise.all(
    Object.values(binaryData)
      .filter((data) => data.mimeType.startsWith('image/'))
      .map(async (data) => {
        let binaryUrlString: string;

        if (data.id) {
          const binaryBuffer = await ctx.helpers.binaryToBuffer(
            await ctx.helpers.getBinaryStream(data.id),
          );
          binaryUrlString = `data:${data.mimeType};base64,${Buffer.from(binaryBuffer).toString('base64')}`;
        } else {
          binaryUrlString = data.data.includes('base64')
            ? data.data
            : `data:${data.mimeType};base64,${data.data}`;
        }

        return {
          type: 'image_url' as const,
          image_url: { url: binaryUrlString },
        };
      }),
  );

  return new HumanMessage({
    content: [...binaryMessages],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fixEmptyContentMessage(steps: any): any {
  if (!Array.isArray(steps)) return steps;

  steps.forEach((step: Record<string, unknown>) => {
    if ('messageLog' in step && step.messageLog !== undefined) {
      if (Array.isArray(step.messageLog)) {
        (step.messageLog as Array<Record<string, unknown>>).forEach((message) => {
          if ('content' in message && Array.isArray(message.content)) {
            (message.content as Array<Record<string, unknown>>).forEach((content) => {
              if (content.input === '') {
                content.input = {};
              }
            });
          }
        });
      }
    }
  });

  return steps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleAgentFinishOutput(steps: any): any {
  const agentFinishSteps = steps;
  if (agentFinishSteps.returnValues) {
    const isMultiOutput = Array.isArray(agentFinishSteps.returnValues?.output);
    if (isMultiOutput) {
      const multiOutputSteps = agentFinishSteps.returnValues.output as Array<{
        text?: string;
      }>;
      const isTextOnly = multiOutputSteps.every(
        (output: { text?: string }) => 'text' in output,
      );
      if (isTextOnly) {
        agentFinishSteps.returnValues.output = multiOutputSteps
          .map((output: { text?: string }) => output.text)
          .join('\n')
          .trim();
      }
      return agentFinishSteps;
    }
  }
  return agentFinishSteps;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleParsedStepOutput(output: any, memory: unknown): any {
  return {
    returnValues: memory ? { output: JSON.stringify(output) } : output,
    log: 'Final response formatted',
  };
}

function getAgentStepsParser(
  outputParser: unknown,
  memory: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (steps: any) => Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (steps: any) => {
    if (Array.isArray(steps)) {
      const responseParserTool = steps.find(
        (step: { tool?: string }) => step.tool === 'format_final_json_response',
      );
      if (responseParserTool && outputParser) {
        const toolInput = responseParserTool.toolInput;
        const parserInput =
          toolInput instanceof Object ? JSON.stringify(toolInput) : toolInput;
        const returnValues = await (outputParser as { parse: (s: string) => Promise<unknown> }).parse(
          parserInput,
        );
        return handleParsedStepOutput(returnValues, memory);
      }
    }

    if (outputParser && typeof steps === 'object' && steps.returnValues) {
      const finalResponse = steps.returnValues;
      let parserInput: string;

      if (finalResponse instanceof Object) {
        if ('output' in finalResponse) {
          try {
            parserInput = JSON.stringify({ output: jsonParse(finalResponse.output as string) });
          } catch {
            parserInput = finalResponse.output as string;
          }
        } else {
          parserInput = JSON.stringify(finalResponse);
        }
      } else {
        parserInput = finalResponse as string;
      }

      const returnValues = await (outputParser as { parse: (s: string) => Promise<unknown> }).parse(
        parserInput,
      );
      return handleParsedStepOutput(returnValues, memory);
    }

    return handleAgentFinishOutput(steps);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessageTuple = [string, string] | HumanMessage;

async function prepareMessages(
  ctx: IExecuteFunctions,
  itemIndex: number,
  options: {
    systemMessage?: string;
    passthroughBinaryImages?: boolean;
    outputParser?: unknown;
  },
): Promise<MessageTuple[]> {
  const useSystemMessage = options.systemMessage ?? false;
  const messages: MessageTuple[] = [];

  if (useSystemMessage) {
    messages.push([
      'system',
      `{system_message}${options.outputParser ? '\n\n{formatting_instructions}' : ''}`,
    ]);
  } else if (options.outputParser) {
    messages.push(['system', '{formatting_instructions}']);
  }

  messages.push(['placeholder', '{chat_history}'], ['human', '{input}']);

  const hasBinaryData = ctx.getInputData()?.[itemIndex]?.binary !== undefined;
  if (hasBinaryData && options.passthroughBinaryImages) {
    const binaryMessage = await extractBinaryMessages(ctx, itemIndex);
    if ((binaryMessage.content as unknown[]).length !== 0) {
      messages.push(binaryMessage);
    }
  }

  messages.push(['placeholder', '{agent_scratchpad}']);
  return messages;
}

function preparePrompt(messages: MessageTuple[]): ChatPromptTemplate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ChatPromptTemplate.fromMessages(messages as any);
}

// ---------------------------------------------------------------------------
// Agent executor creation
// ---------------------------------------------------------------------------

function createAgentExecutor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[],
  prompt: ChatPromptTemplate,
  options: Record<string, unknown>,
  outputParser: unknown,
  memory: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fallbackModel: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  langfuseHandler?: any,
): AgentExecutor {
  const callbacks = langfuseHandler ? [langfuseHandler] : [];

  const agent = createToolCallingAgent({
    llm: model,
    tools,
    prompt,
    streamRunnable: false,
  });

  let fallbackAgent;
  if (fallbackModel) {
    fallbackAgent = createToolCallingAgent({
      llm: fallbackModel,
      tools,
      prompt,
      streamRunnable: false,
    });
  }

  const runnableAgent = RunnableSequence.from([
    fallbackAgent ? agent.withFallbacks([fallbackAgent]) : agent,
    getAgentStepsParser(outputParser, memory),
    fixEmptyContentMessage,
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runnableAgent as any).singleAction = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runnableAgent as any).streamRunnable = false;

  return AgentExecutor.fromAgentAndTools({
    agent: runnableAgent,
    memory: memory as AgentExecutor['memory'],
    tools,
    returnIntermediateSteps: options.returnIntermediateSteps === true,
    maxIterations: (options.maxIterations as number) ?? 10,
    callbacks,
  });
}

// ---------------------------------------------------------------------------
// Streaming event processing
// ---------------------------------------------------------------------------

interface AgentStreamResult {
  output: string;
  intermediateSteps?: Array<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    action: any;
    observation?: string;
  }>;
}

async function processEventStream(
  ctx: IExecuteFunctions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventStream: AsyncIterable<any>,
  itemIndex: number,
  returnIntermediateSteps = false,
): Promise<AgentStreamResult> {
  const agentResult: AgentStreamResult = {
    output: '',
  };

  if (returnIntermediateSteps) {
    agentResult.intermediateSteps = [];
  }

  ctx.sendChunk('begin', itemIndex);

  for await (const event of eventStream) {
    switch (event.event) {
      case 'on_chat_model_stream': {
        const chunk = event.data?.chunk;
        if (chunk?.content) {
          const chunkContent = chunk.content;
          let chunkText = '';

          if (Array.isArray(chunkContent)) {
            for (const message of chunkContent) {
              if (message?.type === 'text') {
                chunkText += message?.text;
              }
            }
          } else if (typeof chunkContent === 'string') {
            chunkText = chunkContent;
          }

          ctx.sendChunk('item', itemIndex, chunkText);
          agentResult.output += chunkText;
        }
        break;
      }

      case 'on_chat_model_end': {
        if (returnIntermediateSteps && event.data) {
          const output = event.data.output;
          if (output?.tool_calls && output.tool_calls.length > 0) {
            for (const toolCall of output.tool_calls) {
              agentResult.intermediateSteps!.push({
                action: {
                  tool: toolCall.name,
                  toolInput: toolCall.args,
                  log:
                    output.content ||
                    `Calling ${toolCall.name} with input: ${JSON.stringify(toolCall.args)}`,
                  messageLog: [output],
                  toolCallId: toolCall.id,
                  type: toolCall.type,
                },
              });
            }
          }
        }
        break;
      }

      case 'on_tool_end': {
        if (
          returnIntermediateSteps &&
          event.data &&
          agentResult.intermediateSteps!.length > 0
        ) {
          const matchingStep = agentResult.intermediateSteps!.find(
            (step) => !step.observation && step.action.tool === event.name,
          );
          if (matchingStep) {
            matchingStep.observation = event.data.output;
          }
        }
        break;
      }

      default:
        break;
    }
  }

  ctx.sendChunk('end', itemIndex);
  return agentResult;
}

// ---------------------------------------------------------------------------
// Responses API check (not supported)
// ---------------------------------------------------------------------------

function checkIsResponsesApi(model: unknown): boolean {
  try {
    return (
      !!model &&
      model instanceof ChatOpenAI &&
      'useResponsesApi' in model &&
      !!(model as unknown as { useResponsesApi: boolean }).useResponsesApi
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function toolsAgentExecute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
  this.logger.debug('Executing Agent Langfuse');
  const returnData: INodeExecutionData[] = [];
  const items = this.getInputData();

  const batchSize = this.getNodeParameter('options.batchSize', 0, 1) as number;
  const delayBetweenBatches = this.getNodeParameter(
    'options.delayBetweenBatches',
    0,
    0,
  ) as number;
  const needsFallback = this.getNodeParameter('needsFallback', 0, false) as boolean;

  // Get shared resources (model, memory) once
  const memory = await getOptionalMemory(this);
  let model = await getChatModel(this, 0);

  if (!model) {
    throw new NodeOperationError(
      this.getNode(),
      'Please connect a model to the Chat Model input',
    );
  }

  const fallbackModel = needsFallback ? await getChatModel(this, 1) : null;

  if (checkIsResponsesApi(model)) {
    throw new NodeOperationError(
      this.getNode(),
      'This model uses the Responses API which is not supported. Please use the Chat Completions API.',
    );
  }

  if (checkIsResponsesApi(fallbackModel)) {
    throw new NodeOperationError(
      this.getNode(),
      'The fallback model uses the Responses API which is not supported. Please use the Chat Completions API.',
    );
  }

  if (needsFallback && !fallbackModel) {
    throw new NodeOperationError(
      this.getNode(),
      'Please connect a model to the Fallback Model input or disable the fallback option',
    );
  }

  const enableStreaming = this.getNodeParameter('options.enableStreaming', 0, true) as boolean;

  // -----------------------------------------------------------------------
  // Langfuse prompt source — fetch once (shared across items)
  // -----------------------------------------------------------------------
  const promptSource = this.getNodeParameter('promptSource', 0, 'manual') as string;
  let langfusePromptResult: Awaited<ReturnType<typeof fetchPrompt>> | undefined;
  let langfuseProjectName: string | undefined;

  if (promptSource === 'langfuse') {
    const langfuseCreds = (await this.getCredentials('langfuseApi')) as unknown as LangfuseCredentials;
    const promptName = this.getNodeParameter('langfusePrompt', 0) as string;

    // Fetch prompt and project name in parallel
    const [promptResult, projectName] = await Promise.all([
      fetchPrompt(langfuseCreds, promptName, this.getNode()),
      fetchProjectName(langfuseCreds),
    ]);
    langfusePromptResult = promptResult;
    langfuseProjectName = projectName;

    // Optionally override model name and temperature from Langfuse config
    const modelSource = this.getNodeParameter('modelSource', 0, 'manual') as string;
    if (modelSource === 'langfuse') {
      if (!langfusePromptResult.modelName) {
        throw new NodeOperationError(
          this.getNode(),
          `Langfuse prompt '${promptName}' does not have a model configured. Set a model in the Langfuse prompt config or switch Model Source to 'manual'.`,
        );
      }

      // Create a new model instance with the Langfuse model name
      // Mutating the existing model doesn't work reliably because n8n's task runner
      // may serialize/deserialize the model object, losing mutations
      const sourceModel = model as Record<string, unknown>;
      const targetModel = langfusePromptResult.modelName!;
      const targetTemp = langfusePromptResult.temperature ?? sourceModel.temperature;

      // Copy constructor params from the source model and override model + temperature
      const sourceKwargs = (sourceModel.lc_kwargs as Record<string, unknown>) ?? {};
      const newModelParams = {
        ...sourceKwargs,
        model: targetModel,
        modelName: targetModel,
        temperature: targetTemp,
      };

      // Re-create the model with the new params using the same class
      const ModelClass = sourceModel.constructor as new (params: Record<string, unknown>) => unknown;
      model = new ModelClass(newModelParams);
    }
  }

  // -----------------------------------------------------------------------
  // Batch processing
  // -----------------------------------------------------------------------
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    const batchPromises = batch.map(async (_item, batchItemIndex) => {
      const itemIndex = i + batchItemIndex;

      // ---------------------------------------------------------------
      // Compile Langfuse prompt with variables (per-item: expressions in
      // variable values resolve against the current item).
      // ---------------------------------------------------------------
      let compiledSystemMessage: string | undefined;
      let compiledUserMessage: string | undefined;

      if (langfusePromptResult) {
        const mapper = this.getNodeParameter(
          'promptVariablesUi',
          itemIndex,
          {},
        ) as { value?: Record<string, unknown> | null };

        const variables: Record<string, string> = {};
        for (const [key, value] of Object.entries(mapper?.value ?? {})) {
          variables[key] = value == null ? '' : String(value);
        }

        const compiled = compilePromptMessages(
          langfusePromptResult,
          variables,
          this.getNode(),
        );
        compiledSystemMessage = compiled.systemMessage;
        compiledUserMessage = compiled.userMessage;
      }

      // Get user input. When the Langfuse prompt defines a user-role
      // message, that compiled content replaces the Text/chatInput field
      // — Langfuse-defined prompts own the human turn.
      let input: string | undefined;
      if (compiledUserMessage !== undefined) {
        input = compiledUserMessage;
      } else {
        input = getPromptInputByType({
          ctx: this,
          i: itemIndex,
          inputKey: 'text',
          promptTypeKey: 'promptType',
        });

        if (input === undefined) {
          throw new NodeOperationError(this.getNode(), 'The "text" parameter is empty.');
        }
      }

      // Get output parser and tools
      const outputParser = await getOptionalOutputParser(this, itemIndex);
      const tools = await getTools(this, outputParser);
      const options = this.getNodeParameter('options', itemIndex, {}) as Record<string, unknown>;

      // Unwrap nested toolkits
      const wrappedTools: unknown[] = [];
      for (const t of tools) {
        if ('tools' in (t as Record<string, unknown>) && Array.isArray((t as Record<string, unknown>).tools)) {
          wrappedTools.push(...((t as Record<string, unknown>).tools as unknown[]));
          continue;
        }
        wrappedTools.push(t);
      }

      // -------------------------------------------------------------------
      // Langfuse handler (per item — different sessionId/userId possible)
      // -------------------------------------------------------------------
      const langfuseCreds = (await this.getCredentials('langfuseApi')) as unknown as LangfuseCredentials;

      const rawMetadata = this.getNodeParameter(
        'langfuseMetadata',
        itemIndex,
        {},
      ) as Record<string, unknown>;

      const workflow = this.getWorkflow();
      const traceName =
        (rawMetadata.traceName as string) ||
        `${workflow.name} - ${this.getNode().name}`;

      let parsedCustomMetadata: Record<string, unknown> | undefined;
      if (typeof rawMetadata.customMetadata === 'string') {
        try {
          parsedCustomMetadata = JSON.parse(rawMetadata.customMetadata);
        } catch {
          this.logger.warn('Invalid JSON in Langfuse metadata, ignoring customMetadata.');
        }
      } else {
        parsedCustomMetadata = rawMetadata.customMetadata as
          | Record<string, unknown>
          | undefined;
      }

      // Build metadata: auto-populated fields + user's custom metadata
      const autoMetadata: Record<string, unknown> = {
        execution_id: this.getExecutionId(),
        workflow: {
          id: workflow.id,
          name: workflow.name,
          active: workflow.active,
        },
        node: this.getNode().name,
      };
      if (langfuseProjectName) {
        autoMetadata.project = langfuseProjectName;
      }
      if (langfusePromptResult) {
        autoMetadata.prompt = {
          name: langfusePromptResult.promptName,
          version: langfusePromptResult.promptVersion,
        };
      }

      // Auto fields are factual (execution id, workflow, node, project,
      // prompt version) — they always win over user-supplied custom metadata.
      const collidingKeys = Object.keys(parsedCustomMetadata ?? {}).filter(
        (key) => key in autoMetadata,
      );
      if (collidingKeys.length > 0) {
        this.logger.warn(
          `Langfuse custom metadata keys ignored (reserved for auto-populated values): ${collidingKeys.join(', ')}`,
        );
      }

      const mergedMetadata = {
        ...(parsedCustomMetadata ?? {}),
        ...autoMetadata,
      };

      const langfuseMetadata: LangfuseMetadata = {
        customMetadata: mergedMetadata,
        sessionId: rawMetadata.sessionId as string | undefined,
        userId: rawMetadata.userId as string | undefined,
        traceName,
      };

      const langfuseHandler = createLangfuseHandler(langfuseCreds, langfuseMetadata);

      // -------------------------------------------------------------------
      // Build system message (from Langfuse or from options)
      // -------------------------------------------------------------------
      let systemMessage = options.systemMessage as string | undefined;
      if (compiledSystemMessage !== undefined) {
        // Langfuse prompt (with vars substituted) overrides the system message
        systemMessage = compiledSystemMessage;
      } else if (langfusePromptResult) {
        // Fallback safety net — shouldn't hit when promptSource=langfuse
        systemMessage = langfusePromptResult.systemMessage;
      }

      // -------------------------------------------------------------------
      // Prepare prompt messages
      // -------------------------------------------------------------------
      const messages = await prepareMessages(this, itemIndex, {
        systemMessage,
        passthroughBinaryImages: (options.passthroughBinaryImages as boolean) ?? true,
        outputParser,
      });

      const prompt = preparePrompt(messages);

      // -------------------------------------------------------------------
      // Create agent executor
      // -------------------------------------------------------------------
      const executor = createAgentExecutor(
        model,
        wrappedTools,
        prompt,
        options,
        outputParser,
        memory,
        fallbackModel,
      );

      // -------------------------------------------------------------------
      // Invoke params
      // -------------------------------------------------------------------
      const invokeParams: Record<string, unknown> = {
        input,
        system_message: systemMessage ?? SYSTEM_MESSAGE,
      };

      if (outputParser) {
        invokeParams.formatting_instructions =
          'IMPORTANT: For your response to user, you MUST use the `format_final_json_response` tool with your complete answer formatted according to the required schema. Do not attempt to format the JSON manually - always use this tool. Your response will be rejected if it is not properly formatted through this tool. Only use this tool once you are ready to provide your final answer.';
      }

      const executeOptions = {
        signal: this.getExecutionCancelSignal(),
        callbacks: [langfuseHandler],
        runName: traceName,
        metadata: {
          sessionId: langfuseMetadata.sessionId,
          userId: langfuseMetadata.userId,
          ...langfuseMetadata.customMetadata,
          // Link the LLM generation(s) to the Langfuse prompt version so they
          // appear under the prompt's "Generations" tab and feed its metrics.
          // The langfuse-langchain CallbackHandler reads this special
          // `langfusePrompt` metadata key, maps it by parentRunId to link the
          // child generation, and strips the key from stored metadata.
          ...(langfusePromptResult
            ? { langfusePrompt: langfusePromptResult.promptClient }
            : {}),
        },
      };

      // -------------------------------------------------------------------
      // Execute: streaming or invoke
      // -------------------------------------------------------------------
      const isStreamingAvailable =
        'isStreaming' in this ? (this as IExecuteFunctions).isStreaming() : undefined;

      if ('isStreaming' in this && enableStreaming && isStreamingAvailable) {
        let chatHistory: unknown;
        if (memory) {
          const memoryVariables = await (
            memory as { loadMemoryVariables: (input: object) => Promise<Record<string, unknown>> }
          ).loadMemoryVariables({});
          chatHistory = memoryVariables['chat_history'];
        }

        const eventStream = executor.streamEvents(
          {
            ...invokeParams,
            chat_history: chatHistory ?? undefined,
          },
          {
            version: 'v2',
            ...executeOptions,
          },
        );

        const result = await processEventStream(
          this,
          eventStream,
          itemIndex,
          options.returnIntermediateSteps as boolean,
        );

        // Flush Langfuse handler after streaming completes
        await flushHandler(langfuseHandler);

        return result;
      } else {
        const result = await executor.invoke(invokeParams, executeOptions);

        // Flush Langfuse handler after invoke completes
        await flushHandler(langfuseHandler);

        return result;
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);

    const outputParser = await getOptionalOutputParser(this, 0);

    batchResults.forEach((result, index) => {
      const itemIndex = i + index;

      if (result.status === 'rejected') {
        const error = result.reason as Error;
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: error.message },
            pairedItem: { item: itemIndex },
          });
          return;
        } else {
          throw new NodeOperationError(this.getNode(), error);
        }
      }

      const response = result.value as Record<string, unknown>;

      if (memory && outputParser) {
        const parsedOutput = jsonParse(response.output as string);
        response.output =
          (parsedOutput as Record<string, unknown>)?.output ?? parsedOutput;
      }

      const itemResult: INodeExecutionData = {
        json: omit(
          response,
          'system_message',
          'formatting_instructions',
          'input',
          'chat_history',
          'agent_scratchpad',
        ) as INodeExecutionData['json'],
        pairedItem: { item: itemIndex },
      };

      returnData.push(itemResult);
    });

    if (i + batchSize < items.length && delayBetweenBatches > 0) {
      await sleep(delayBetweenBatches);
    }
  }

  return [returnData];
}
