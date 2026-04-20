import { CallbackHandler } from 'langfuse-langchain';
import { NodeOperationError } from 'n8n-workflow';
import type { INode } from 'n8n-workflow';
import type {
  LangfuseCredentials,
  LangfuseMetadata,
  LangfusePromptListItem,
  LangfusePromptResponse,
  LangfusePromptResult,
} from './types';

async function langfuseApiRequest(
  credentials: LangfuseCredentials,
  path: string,
): Promise<unknown> {
  const baseUrl = credentials.url || credentials.baseUrl || 'https://cloud.langfuse.com';
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const auth = Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64');

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
    const baseUrl = credentials.url || credentials.baseUrl || 'https://cloud.langfuse.com';
    throw new NodeOperationError(
      node,
      `Cannot connect to Langfuse at ${baseUrl}: ${(error as Error).message}`,
    );
  }
}

export async function fetchPrompt(
  credentials: LangfuseCredentials,
  promptName: string,
  node: INode,
): Promise<LangfusePromptResult> {
  try {
    const data = (await langfuseApiRequest(
      credentials,
      `/api/public/v2/prompts/${encodeURIComponent(promptName)}`,
    )) as LangfusePromptResponse;

    if (!data.prompt || data.prompt.length === 0) {
      throw new Error(`Prompt '${promptName}' has no content`);
    }

    const systemPrompt = data.prompt.find((p) => p.role === 'system');
    if (!systemPrompt) {
      throw new Error(`Prompt '${promptName}' has no system message`);
    }

    return {
      systemMessage: systemPrompt.content,
      modelName: data.config?.model,
      temperature: data.config?.temperature,
    };
  } catch (error) {
    if ((error as Error).message.includes('404') || (error as Error).message.includes('Not Found')) {
      throw new NodeOperationError(node, `Prompt '${promptName}' not found in Langfuse`);
    }
    throw new NodeOperationError(node, (error as Error).message);
  }
}

export function createLangfuseHandler(
  credentials: LangfuseCredentials,
  metadata: LangfuseMetadata,
): CallbackHandler {
  const baseUrl = credentials.url || credentials.baseUrl || 'https://cloud.langfuse.com';
  return new CallbackHandler({
    publicKey: credentials.publicKey,
    secretKey: credentials.secretKey,
    baseUrl,
    sessionId: metadata.sessionId,
    userId: metadata.userId,
    metadata: metadata.customMetadata,
  });
}

export async function flushHandler(handler: CallbackHandler): Promise<void> {
  await handler.flushAsync();
}
