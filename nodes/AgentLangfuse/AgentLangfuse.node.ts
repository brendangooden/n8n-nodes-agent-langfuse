import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeType,
  INodeTypeDescription,
  INodePropertyOptions,
  ResourceMapperFields,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { toolsAgentExecute } from './execute';
import { fetchPrompt, fetchPromptNames } from './langfuse';
import type { LangfuseCredentials } from './types';

export class AgentLangfuse implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'AI Agent + Langfuse',
    name: 'agentLangfuse',
    icon: {
      light: 'file:icons/langfuse-light.icon.svg',
      dark: 'file:icons/langfuse-dark.icon.svg',
    },
    group: ['transform'],
    version: 1,
    description: 'AI Agent with native Langfuse tracing and prompt management',
    defaults: {
      name: 'AI Agent + Langfuse',
    },
    codex: {
      categories: ['AI'],
      subcategories: {
        AI: ['Agents', 'Root Nodes'],
      },
    },
    // Dynamic inputs based on parameters — evaluated at runtime by n8n expression engine
    inputs: `={{
      ((hasOutputParser, needsFallback) => {
        const inputs = [
          { type: 'main' },
          { type: 'ai_languageModel', displayName: 'Chat Model', maxConnections: 1, required: true },
        ];
        if (needsFallback) {
          inputs.push({ type: 'ai_languageModel', displayName: 'Fallback Model', maxConnections: 1 });
        }
        inputs.push({ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 });
        inputs.push({ type: 'ai_tool', displayName: 'Tool' });
        if (hasOutputParser) {
          inputs.push({ type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 });
        }
        return inputs;
      })(
        !!$parameter.hasOutputParser,
        !!$parameter.needsFallback
      )
    }}`,
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'langfuseApi', required: true }],
    properties: [
      // Prompt Source
      {
        displayName: 'Prompt Source',
        name: 'promptSource',
        type: 'options',
        options: [
          { name: 'Langfuse Prompt', value: 'langfuse' },
          { name: 'Manual', value: 'manual' },
        ],
        default: 'langfuse',
        description: 'Where to get the system prompt from',
      },
      // Langfuse Prompt selector
      {
        displayName: 'Langfuse Prompt',
        name: 'langfusePrompt',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getPrompts',
        },
        default: '',
        required: true,
        description: 'Select a production prompt from Langfuse',
        displayOptions: {
          show: {
            promptSource: ['langfuse'],
          },
        },
      },
      // Model Source
      {
        displayName: 'Model Source',
        name: 'modelSource',
        type: 'options',
        options: [
          { name: 'From Langfuse', value: 'langfuse' },
          { name: 'Manual Override', value: 'manual' },
        ],
        default: 'langfuse',
        description:
          'Use the model defined in Langfuse prompt config, or override with the connected Chat Model',
        displayOptions: {
          show: {
            promptSource: ['langfuse'],
          },
        },
      },
      // Prompt Variables (auto-loaded from the selected Langfuse prompt's {{placeholders}})
      {
        displayName: 'Prompt Variables',
        name: 'promptVariablesUi',
        type: 'resourceMapper',
        default: { mappingMode: 'defineBelow', value: null },
        noDataExpression: true,
        description:
          'Values substituted into {{placeholders}} in the Langfuse prompt. Fields auto-load from the selected prompt; values support n8n expressions. If the prompt defines a user message, it replaces the Text/chatInput below.',
        displayOptions: {
          show: {
            promptSource: ['langfuse'],
          },
        },
        typeOptions: {
          loadOptionsDependsOn: ['langfusePrompt'],
          resourceMapper: {
            resourceMapperMethod: 'getPromptVariables',
            mode: 'add',
            fieldWords: { singular: 'variable', plural: 'variables' },
            addAllFields: true,
            multiKeyMatch: false,
            supportAutoMap: false,
          },
        },
      },
      // Prompt Type (user input)
      {
        displayName: 'Prompt Type',
        name: 'promptType',
        type: 'options',
        options: [
          { name: 'Auto (From Previous Node)', value: 'auto' },
          { name: 'Define Below', value: 'define' },
        ],
        default: 'auto',
        description:
          'Ignored when the selected Langfuse prompt defines a user message — that user message becomes the human turn.',
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '',
        typeOptions: { rows: 4 },
        displayOptions: {
          show: {
            promptType: ['define'],
          },
        },
      },
      // Output Parser toggle
      {
        displayName: 'Require Specific Output Format',
        name: 'hasOutputParser',
        type: 'boolean',
        default: false,
        noDataExpression: true,
      },
      {
        displayName:
          'Connect an output parser on the canvas to specify the output format',
        name: 'outputParserNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { hasOutputParser: [true] } },
      },
      // Fallback Model toggle
      {
        displayName: 'Enable Fallback Model',
        name: 'needsFallback',
        type: 'boolean',
        default: false,
        noDataExpression: true,
      },
      {
        displayName:
          'Connect an additional language model on the canvas to use as fallback',
        name: 'fallbackNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { needsFallback: [true] } },
      },
      // Langfuse Metadata
      {
        displayName: 'Langfuse Metadata',
        name: 'langfuseMetadata',
        type: 'collection',
        default: {},
        options: [
          {
            displayName: 'Session ID',
            name: 'sessionId',
            type: 'string',
            default: '',
            description: 'Groups related traces in Langfuse',
          },
          {
            displayName: 'User ID',
            name: 'userId',
            type: 'string',
            default: '',
            description: 'For trace attribution in Langfuse',
          },
          {
            displayName: 'Trace Name',
            name: 'traceName',
            type: 'string',
            default: '',
            description:
              'Override the default trace name. If empty, uses "<workflow name> - <node name>".',
          },
          {
            displayName: 'Custom Metadata (JSON)',
            name: 'customMetadata',
            type: 'json',
            default: '{}',
            description: 'Extra metadata attached to Langfuse traces',
          },
        ],
      },
      // Options
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          {
            displayName: 'System Message',
            name: 'systemMessage',
            type: 'string',
            default: 'You are a helpful assistant',
            typeOptions: { rows: 4 },
            description:
              'System message for the agent (only used when Prompt Source = Manual)',
          },
          {
            displayName: 'Max Iterations',
            name: 'maxIterations',
            type: 'number',
            default: 10,
            description: 'Maximum number of agent iterations',
          },
          {
            displayName: 'Return Intermediate Steps',
            name: 'returnIntermediateSteps',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'Enable Streaming',
            name: 'enableStreaming',
            type: 'boolean',
            default: true,
          },
          {
            displayName: 'Automatically Passthrough Binary Images',
            name: 'passthroughBinaryImages',
            type: 'boolean',
            default: true,
          },
          {
            displayName: 'Batch Size',
            name: 'batchSize',
            type: 'number',
            default: 1,
            description: 'Number of items to process in parallel',
          },
          {
            displayName: 'Delay Between Batches (ms)',
            name: 'delayBetweenBatches',
            type: 'number',
            default: 0,
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getPrompts(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const credentials = (await this.getCredentials(
          'langfuseApi',
        )) as unknown as LangfuseCredentials;
        return fetchPromptNames(credentials, this.getNode());
      },
    },
    resourceMapping: {
      async getPromptVariables(
        this: ILoadOptionsFunctions,
      ): Promise<ResourceMapperFields> {
        const promptName = this.getNodeParameter(
          'langfusePrompt',
          undefined,
        ) as string;
        if (!promptName) {
          return { fields: [] };
        }
        const credentials = (await this.getCredentials(
          'langfuseApi',
        )) as unknown as LangfuseCredentials;
        const result = await fetchPrompt(credentials, promptName, this.getNode());
        return {
          fields: result.requiredVariables.map((name) => ({
            id: name,
            displayName: name,
            required: true,
            display: true,
            defaultMatch: false,
            type: 'string',
          })),
          emptyFieldsNotice: 'This Langfuse prompt has no {{variables}}.',
        };
      },
    },
  };

  async execute(this: IExecuteFunctions) {
    return toolsAgentExecute.call(this);
  }
}
