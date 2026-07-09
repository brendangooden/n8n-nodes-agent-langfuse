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

type ZodToJsonSchema = (schema: unknown, options?: unknown) => Record<string, unknown>;

let cachedConverter: ZodToJsonSchema | null | undefined;

/**
 * Resolve `zod-to-json-schema` lazily, on first use.
 *
 * It is only needed to convert Zod tool schemas, and only for Google models.
 * Requiring it at module load would make a broken or partially extracted copy
 * of that package (a recurring failure mode in `~/.n8n/nodes`, see issue #6)
 * take the whole node down at load time. Resolving it here means the worst case
 * is that Zod-schema tools are advertised unsanitized, instead of the node
 * failing to load at all.
 */
function getConverter(): ZodToJsonSchema | null {
  if (cachedConverter === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cachedConverter = (require('zod-to-json-schema') as { zodToJsonSchema: ZodToJsonSchema })
        .zodToJsonSchema;
    } catch {
      cachedConverter = null;
    }
  }
  return cachedConverter;
}

/** True when the connected chat model routes to Google Gemini / Vertex. */
export function isGeminiModel(model: unknown): boolean {
  const ns = ((model as { lc_namespace?: string[] })?.lc_namespace ?? [])
    .join('.')
    .toLowerCase();
  if (ns.includes('google') || ns.includes('vertex') || ns.includes('genai')) return true;
  const ctor = (model as { constructor?: { name?: string } })?.constructor?.name ?? '';
  return /google|vertex|gemini/i.test(ctor);
}

const MAX_REF_DEPTH = 8;

/** Resolve a local JSON Pointer such as "#/$defs/Addr" against the root document. */
function lookupPointer(root: Record<string, unknown>, pointer: string): unknown {
  if (!pointer.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const raw of pointer.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Inline local `$ref` pointers before the unsupported keywords are stripped.
 *
 * Gemini rejects `$ref` and `$defs`, so dropping them without resolving turns
 * every referenced property into an empty schema while it stays in `required`:
 * the model loses the argument's shape. Recursive or unresolvable references
 * degrade to `{}` rather than looping.
 */
function inlineLocalRefs(root: unknown): unknown {
  if (!root || typeof root !== 'object') return root;
  const doc = root as Record<string, unknown>;

  const walk = (node: unknown, depth: number, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, depth, seen));
    if (!node || typeof node !== 'object') return node;

    const src = node as Record<string, unknown>;
    const ref = src.$ref;

    if (typeof ref === 'string') {
      if (depth >= MAX_REF_DEPTH || seen.has(ref)) return {};
      const target = lookupPointer(doc, ref);
      if (!target || typeof target !== 'object') return {};
      const nextSeen = new Set(seen).add(ref);
      const inlined = walk(target, depth + 1, nextSeen) as Record<string, unknown>;
      // Sibling keys next to a $ref win over the referenced schema.
      const siblings: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) {
        if (k !== '$ref') siblings[k] = walk(v, depth, seen);
      }
      return { ...inlined, ...siblings };
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) out[k] = walk(v, depth, seen);
    return out;
  };

  return walk(doc, 0, new Set<string>());
}

/** Merge an object subschema into the accumulator: union of properties and of required. */
function mergeSubschema(out: Record<string, unknown>, sub: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(sub)) {
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = { ...((out.properties as Record<string, unknown>) ?? {}), ...(v as object) };
    } else if (k === 'required' && Array.isArray(v)) {
      out.required = [...new Set([...((out.required as string[]) ?? []), ...(v as string[])])];
    } else {
      out[k] = v;
    }
  }
}

/** Recursively strip keywords / constructs Gemini can't parse. */
function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (!node || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Gemini has no unions. `allOf` means "satisfy all", so every object subschema
  // is merged; dropping all but the first would lose the other branches'
  // properties. `anyOf` and `oneOf` are alternatives, so the first branch stays.
  if (Array.isArray(src.allOf)) {
    for (const sub of src.allOf as unknown[]) {
      if (sub && typeof sub === 'object') {
        mergeSubschema(out, stripUnsupported(sub) as Record<string, unknown>);
      }
    }
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(src[key])) continue;
    const first = (src[key] as unknown[]).find((s) => s && typeof s === 'object');
    if (first) mergeSubschema(out, stripUnsupported(first) as Record<string, unknown>);
  }

  for (const [key, value] of Object.entries(src)) {
    if (GEMINI_UNSUPPORTED_KEYS.includes(key)) continue;
    if (['anyOf', 'oneOf', 'allOf'].includes(key)) continue; // handled above
    if (key === 'type' && Array.isArray(value)) {
      // Gemini's Schema.type is a single enum value, so draft-07 unions such as
      // ["string","null"] are rejected with 400 INVALID_ARGUMENT. Collapse to the
      // first non-null type and express nullability with the `nullable` flag,
      // which Gemini does understand.
      const types = (value as unknown[]).filter((t) => t !== 'null');
      if ((value as unknown[]).includes('null')) out.nullable = true;
      if (types.length) out.type = types[0];
      continue;
    }
    if (
      key === 'format' &&
      typeof value === 'string' &&
      !GEMINI_ALLOWED_STRING_FORMATS.has(value)
    ) {
      continue; // drop unsupported string formats
    }
    // `properties` and `required` accumulate: a merged subschema may already
    // have contributed entries that this node's own keys must not overwrite.
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = { ...((out.properties as Record<string, unknown>) ?? {}) };
      for (const [p, pSchema] of Object.entries(value as Record<string, unknown>)) {
        props[p] = stripUnsupported(pSchema);
      }
      out.properties = props;
    } else if (key === 'required' && Array.isArray(value)) {
      out.required = [...new Set([...((out.required as string[]) ?? []), ...(value as string[])])];
    } else {
      out[key] = stripUnsupported(value);
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

/** Resolve local references, then strip everything Gemini can't parse. */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  return stripUnsupported(inlineLocalRefs(schema));
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
  const convert = getConverter();
  if (!convert) return undefined;
  try {
    // `openApi3` keeps nullability as `nullable: true` rather than a
    // ["string","null"] type union, which Gemini rejects.
    return convert(schema, { target: 'openApi3' });
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
