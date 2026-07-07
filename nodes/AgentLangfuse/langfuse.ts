import { Langfuse, type ChatPromptClient } from 'langfuse';
import { CallbackHandler } from 'langfuse-langchain';
import { NodeOperationError } from 'n8n-workflow';
import type { INode } from 'n8n-workflow';
import type {
  LangfuseCredentials,
  LangfuseMetadata,
  LangfusePromptListItem,
  LangfusePromptResult,
} from './types';

export function resolveBaseUrl(credentials: LangfuseCredentials): string {
  // `url` (this credential's own field) must win over `host`. When another
  // installed package also registers a credential type named `langfuseApi`
  // (e.g. @langfuse/n8n-nodes-langfuse, whose `host` field defaults to
  // https://cloud.langfuse.com), n8n may apply THAT schema's defaults to data
  // stored by this one, injecting a `host` the user never entered. Trusting
  // `host` first then silently redirects all requests away from the user's
  // configured instance.
  return (
    credentials.url ||
    credentials.host ||
    credentials.baseUrl ||
    'https://cloud.langfuse.com'
  );
}

function createLangfuseClient(credentials: LangfuseCredentials): Langfuse {
  return new Langfuse({
    publicKey: credentials.publicKey,
    secretKey: credentials.secretKey,
    baseUrl: resolveBaseUrl(credentials),
  });
}

// Raw fetch used only for endpoints not exposed on the typed SDK surface
// (prompt list + project name).
async function langfuseApiRequest(
  credentials: LangfuseCredentials,
  path: string,
): Promise<unknown> {
  const url = `${resolveBaseUrl(credentials).replace(/\/$/, '')}${path}`;
  const auth = Buffer.from(
    `${credentials.publicKey}:${credentials.secretKey}`,
  ).toString('base64');

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401) {
    throw new Error('Invalid Langfuse credentials');
  }

  if (!response.ok) {
    throw new Error(`Langfuse API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function fetchPromptNames(
  credentials: LangfuseCredentials,
  node: INode,
): Promise<Array<{ name: string; value: string }>> {
  try {
    const data = (await langfuseApiRequest(credentials, '/api/public/v2/prompts')) as {
      data: LangfusePromptListItem[];
    };

    return data.data
      .filter((p) => p.type === 'chat')
      .map((p) => ({ name: p.name, value: p.name }));
  } catch (error) {
    throw new NodeOperationError(
      node,
      `Cannot connect to Langfuse at ${resolveBaseUrl(credentials)}: ${(error as Error).message}`,
    );
  }
}

const MUSTACHE_VAR = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g;

export function extractVariableNames(content: string): string[] {
  if (!content) return [];
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  // Reset regex state for safety
  MUSTACHE_VAR.lastIndex = 0;
  while ((match = MUSTACHE_VAR.exec(content)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

function findMessageContent(
  messages: Array<{ role?: string; content?: string; type?: string }>,
  role: string,
): string | undefined {
  const msg = messages.find((m) => m.role === role && typeof m.content === 'string');
  return msg?.content;
}

export async function fetchPrompt(
  credentials: LangfuseCredentials,
  promptName: string,
  node: INode,
): Promise<LangfusePromptResult> {
  let promptClient: ChatPromptClient;
  try {
    const client = createLangfuseClient(credentials);
    promptClient = await client.getPrompt(promptName, undefined, { type: 'chat' });
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (message.includes('404') || message.includes('Not Found')) {
      throw new NodeOperationError(node, `Prompt '${promptName}' not found in Langfuse`);
    }
    throw new NodeOperationError(node, message);
  }

  const promptMessages = promptClient.prompt as Array<{
    role?: string;
    content?: string;
    type?: string;
  }>;

  if (!promptMessages || promptMessages.length === 0) {
    throw new NodeOperationError(node, `Prompt '${promptName}' has no content`);
  }

  const systemMessage = findMessageContent(promptMessages, 'system');
  if (!systemMessage) {
    throw new NodeOperationError(node, `Prompt '${promptName}' has no system message`);
  }

  const userMessage = findMessageContent(promptMessages, 'user');

  // Union of {{vars}} referenced across system + user content.
  const required = new Set<string>();
  for (const v of extractVariableNames(systemMessage)) required.add(v);
  if (userMessage) {
    for (const v of extractVariableNames(userMessage)) required.add(v);
  }

  const config = (promptClient.config ?? {}) as {
    model?: string;
    temperature?: number;
  };

  return {
    systemMessage,
    userMessage,
    requiredVariables: [...required],
    modelName: config.model,
    temperature: config.temperature,
    promptName: promptClient.name,
    promptVersion: promptClient.version,
    promptClient,
  };
}

export function compilePromptMessages(
  prompt: LangfusePromptResult,
  variables: Record<string, string>,
  node: INode,
): { systemMessage: string; userMessage?: string } {
  const missing = prompt.requiredVariables.filter(
    (name) => variables[name] === undefined || variables[name] === '',
  );

  if (missing.length > 0) {
    throw new NodeOperationError(
      node,
      `Missing prompt variables: ${missing.join(', ')}`,
      {
        description:
          'The selected Langfuse prompt references {{placeholder}} variables that have no value supplied. Add a row under "Prompt Variables" for each missing variable.',
      },
    );
  }

  const compiled = prompt.promptClient.compile(variables) as Array<{
    role?: string;
    content?: string;
  }>;

  const compiledSystem = findMessageContent(compiled, 'system') ?? prompt.systemMessage;
  const compiledUser = findMessageContent(compiled, 'user');

  return {
    systemMessage: compiledSystem,
    userMessage: compiledUser,
  };
}

export async function fetchProjectName(
  credentials: LangfuseCredentials,
): Promise<string | undefined> {
  try {
    const data = (await langfuseApiRequest(credentials, '/api/public/projects')) as {
      data: Array<{ name: string }>;
    };
    return data.data?.[0]?.name;
  } catch {
    return undefined;
  }
}

export function createLangfuseHandler(
  credentials: LangfuseCredentials,
  metadata: LangfuseMetadata,
): CallbackHandler {
  return new CallbackHandler({
    publicKey: credentials.publicKey,
    secretKey: credentials.secretKey,
    baseUrl: resolveBaseUrl(credentials),
    sessionId: metadata.sessionId,
    userId: metadata.userId,
    metadata: metadata.customMetadata,
  });
}

export async function flushHandler(handler: CallbackHandler): Promise<void> {
  await handler.flushAsync();
}
