export interface LangfuseCredentials {
  url?: string;
  baseUrl?: string;
  publicKey: string;
  secretKey: string;
  [key: string]: unknown;
}

export interface LangfusePromptResult {
  systemMessage: string;
  modelName?: string;
  temperature?: number;
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
  type: string;
  prompt: Array<{ role: string; content: string }>;
  config: {
    model?: string;
    temperature?: number;
    [key: string]: unknown;
  };
}
