/*
 * Derived from ToolsAgent/common.ts in @n8n/n8n-nodes-langchain, (c) n8n GmbH,
 * Sustainable Use License. See NOTICE.
 */
import { HumanMessage } from '@langchain/core/messages';
import { BINARY_ENCODING, NodeOperationError } from 'n8n-workflow';
import type { IBinaryData, IExecuteFunctions } from 'n8n-workflow';

/**
 * n8n reads this from its `AiConfig` container, which a community node cannot
 * reach. The value is n8n's own default.
 */
const DEFAULT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES = 50 * 1024 * 1024;

export interface PassthroughOptions {
  passthroughBinaryImages?: boolean;
  passthroughBinaryPdfs?: boolean;
}

export function isTextFile(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/csv' ||
    mimeType === 'application/x-yaml' ||
    mimeType === 'application/yaml'
  );
}

export function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export function isPdfFile(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

/** Text files ride along whenever any passthrough is on. That is n8n's rule. */
export function shouldPassthroughBinary(
  data: IBinaryData,
  options: PassthroughOptions,
): boolean {
  if (isImageFile(data.mimeType)) return options.passthroughBinaryImages === true;
  if (isPdfFile(data.mimeType)) return options.passthroughBinaryPdfs === true;
  if (isTextFile(data.mimeType)) return true;
  return false;
}

async function readBinary(ctx: IExecuteFunctions, data: IBinaryData): Promise<Buffer> {
  const stream = await ctx.helpers.getBinaryStream(data.id as string);
  return await ctx.helpers.binaryToBuffer(stream);
}

/** Strips the `data:<mime>;base64,` prefix n8n sometimes keeps on the payload. */
function toBase64(data: IBinaryData): string {
  return data.data.includes('base64,') ? data.data.split('base64,')[1] : data.data;
}

type BinaryContentBlock =
  | { type: 'image_url'; image_url: { url: string } }
  | {
      type: 'file';
      source_type: 'base64';
      mime_type: string;
      data: string;
      metadata: { filename: string };
    };

/**
 * Turns one binary attachment into a content block the model accepts.
 *
 * n8n picks between this shape and OpenAI's `input_file` shape depending on
 * whether the model speaks the Responses API. This node rejects those models up
 * front, in `checkIsResponsesApi`, so only the standard shape can occur here.
 */
export async function processBinaryForAgentPassthrough(
  ctx: IExecuteFunctions,
  data: IBinaryData,
  type: 'image_url' | 'file',
): Promise<BinaryContentBlock> {
  const base64Data = data.id
    ? Buffer.from(await readBinary(ctx, data)).toString(BINARY_ENCODING)
    : toBase64(data);

  const sizeInBytes = Buffer.byteLength(base64Data, 'base64');
  if (sizeInBytes > DEFAULT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES) {
    const fileName = data.fileName ?? 'binary file';
    const sizeInMb = (sizeInBytes / (1024 * 1024)).toFixed(1);
    const limitInMb = (DEFAULT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES / (1024 * 1024)).toFixed(1);
    throw new NodeOperationError(
      ctx.getNode(),
      `The file "${fileName}" is ${sizeInMb} MB, which exceeds the ${limitInMb} MB limit for passing binary data to the model`,
      {
        description:
          'Reduce the file size, or disable the binary passthrough option for this input.',
      },
    );
  }

  if (type === 'file') {
    return {
      type: 'file',
      source_type: 'base64',
      mime_type: data.mimeType,
      data: base64Data,
      metadata: { filename: data.fileName ?? 'attachment.pdf' },
    };
  }

  return {
    type: 'image_url',
    image_url: { url: `data:${data.mimeType};base64,${base64Data}` },
  };
}

async function readAsText(ctx: IExecuteFunctions, data: IBinaryData): Promise<string> {
  if (data.id) return (await readBinary(ctx, data)).toString('utf-8');
  return Buffer.from(toBase64(data), 'base64').toString('utf-8');
}

/** Collects every attachment the options allow into a single human message. */
export async function extractBinaryMessages(
  ctx: IExecuteFunctions,
  itemIndex: number,
  options: PassthroughOptions,
): Promise<HumanMessage> {
  const binaryData = ctx.getInputData()?.[itemIndex]?.binary ?? {};

  const binaryMessages = await Promise.all(
    Object.values(binaryData)
      .filter((data) => shouldPassthroughBinary(data, options))
      .map(async (data) => {
        if (isImageFile(data.mimeType)) {
          return await processBinaryForAgentPassthrough(ctx, data, 'image_url');
        }
        if (isPdfFile(data.mimeType)) {
          return await processBinaryForAgentPassthrough(ctx, data, 'file');
        }
        const textContent = await readAsText(ctx, data);
        return {
          type: 'text' as const,
          text: `File: ${data.fileName ?? 'attachment'}\nContent:\n${textContent}`,
        };
      }),
  );

  return new HumanMessage({ content: [...binaryMessages] });
}
