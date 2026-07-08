import { zodToJsonSchema } from 'zod-to-json-schema';

// JSON-Schema keywords Google Gemini / Vertex AI reject in
// functionDeclaration parameter schemas. OpenAI/Anthropic tolerate them,
// which is why tool-calling only fails on Google models.
const GEMINI_UNSUPPORTED_KEYS = [
  '$schema', '$id', '$ref', '$defs', 'definitions',
  'additionalProperties', 'patternProperties', 'propertyNames',
  'default', 'const', 'examples',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties',
  'not', 'if', 'then', 'else',
];

// `format` values Gemini accepts on strings; anything else (uri, uuid,
// email, date, ...) must be dropped or Vertex returns 400 INVALID_ARGUMENT.
const GEMINI_ALLOWED_STRING_FORMATS = new Set(['enum', 'date-time']);

/** True when the connected chat model routes to Google Gemini / Vertex. */
export function isGeminiModel(model: unknown): boolean {
  const ns = ((model as { lc_namespace?: string[] })?.lc_namespace ?? [])
    .join('.')
    .toLowerCase();
  if (ns.includes('google') || ns.includes('vertex') || ns.includes('genai')) return true;
  const ctor = (model as { constructor?: { name?: string } })?.constructor?.name ?? '';
  return /google|vertex|gemini/i.test(ctor);
}

/** Recursively strip keywords / constructs Gemini can't parse. */
export function sanitizeGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeGeminiSchema);
  if (!node || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Gemini doesn't support anyOf/oneOf/allOf — flatten to the first
  // object-typed subschema so the parameter shape survives.
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(src[key])) {
      const first = (src[key] as unknown[]).find((s) => s && typeof s === 'object');
      if (first) Object.assign(out, sanitizeGeminiSchema(first) as object);
    }
  }

  for (const [key, value] of Object.entries(src)) {
    if (GEMINI_UNSUPPORTED_KEYS.includes(key)) continue;
    if (['anyOf', 'oneOf', 'allOf'].includes(key)) continue; // handled above
    if (
      key === 'format' &&
      typeof value === 'string' &&
      !GEMINI_ALLOWED_STRING_FORMATS.has(value)
    ) {
      continue; // drop unsupported string formats
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [p, pSchema] of Object.entries(value as Record<string, unknown>)) {
        props[p] = sanitizeGeminiSchema(pSchema);
      }
      out[key] = props;
    } else {
      out[key] = sanitizeGeminiSchema(value);
    }
  }

  // Gemini requires object schemas to declare a properties map.
  if (out.type === 'object' && (!out.properties || typeof out.properties !== 'object')) {
    out.properties = {};
  }
  // Drop required entries that no longer have a matching property.
  if (Array.isArray(out.required) && out.properties) {
    const propKeys = Object.keys(out.properties as Record<string, unknown>);
    out.required = (out.required as string[]).filter((r) => propKeys.includes(r));
    if ((out.required as string[]).length === 0) delete out.required;
  }
  return out;
}

function toJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  // Already a plain JSON schema (no Zod internals)?
  if (
    !('_def' in (schema as object)) &&
    ('type' in (schema as object) || 'properties' in (schema as object))
  ) {
    return schema as Record<string, unknown>;
  }
  try {
    return zodToJsonSchema(schema as never, { target: 'openApi3' }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Replace each tool's advertised schema with a Gemini-safe JSON Schema.
 * The tool still executes normally — only the schema sent to the model
 * changes. No-op for tools whose schema can't be converted.
 */
export function sanitizeToolsForGemini(tools: unknown[]): unknown[] {
  for (const tool of tools) {
    const t = tool as { schema?: unknown };
    const json = toJsonSchema(t.schema);
    if (!json) continue;
    try {
      t.schema = sanitizeGeminiSchema(json);
    } catch {
      /* leave the original schema untouched on any failure */
    }
  }
  return tools;
}
