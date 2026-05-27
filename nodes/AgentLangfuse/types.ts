import type { ChatPromptClient } from 'langfuse';

export interface LangfuseCredentials {
  host?: string;
  url?: string;
  baseUrl?: string;
  publicKey: string;
  secretKey: string;
  [key: string]: unknown;
}

export interface LangfusePromptResult {
  systemMessage: string;
  userMessage?: string;
  requiredVariables: string[];
  modelName?: string;
  temperature?: number;
  promptName: string;
  promptVersion: number;
  promptClient: ChatPromptClient;
}

export interface LangfuseMetadata {
  sessionId?: string;
  userId?: string;
  traceName?: string;
  customMetadata?: Record<string, unknown>;
}

export interface LangfusePromptListItem {
  name: string;
  type: string;
  versions: number[];
}

export interface LangfusePromptResponse {
  name: string;
  version: number;
  type: string;
  prompt: Array<{ role: string; content: string }>;
  config: {
    model?: string;
    temperature?: number;
    [key: string]: unknown;
  };
}
