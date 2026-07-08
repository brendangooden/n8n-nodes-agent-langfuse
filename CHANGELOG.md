# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-08

### Added

- **Google Gemini / Vertex AI tool support.** With a Gemini or Vertex chat model, attaching any tool made every run fail with `400 INVALID_ARGUMENT`: Gemini validates `functionDeclarations` far more strictly than OpenAI/Anthropic and rejects JSON-schema keywords those providers silently ignore (`additionalProperties`, `$schema`, string `format`s such as `uri`/`uuid`, and `anyOf`/`oneOf`/`allOf` unions), all of which MCP-generated tool schemas routinely contain. A new `geminiSchema` module rewrites each tool's advertised schema into a Gemini-safe JSON Schema, applied only when the connected model routes to Google (a strict no-op for OpenAI/Anthropic). The tool still executes normally; only the schema sent to the model changes. Verified against the live Gemini API (`gemini-2.5-flash`): a raw MCP-style schema is rejected with `400 INVALID_ARGUMENT` (`Unknown name "additionalProperties"`), and the same schema after sanitization returns `200` with a valid tool call. `isGeminiModel` was confirmed to fire on the real `@langchain/google-genai` and `@langchain/google-vertexai` chat model classes and to stay off for OpenAI/OpenRouter. Note that current `@langchain/google-genai` also sanitizes tool schemas in its own bind path, so the raw 400 is most visible on the Vertex client path this PR originally targeted; the sanitizer is a correct, idempotent safeguard on both. ([#5](https://github.com/Diward/n8n-nodes-agent-langfuse/pull/5), thanks [@harmoney-stella](https://github.com/harmoney-stella))

### Changed

- **BREAKING — credential type renamed `langfuseApi` → `agentLangfuseApi`** (display name "Agent Langfuse API"). The old name collided with other installed Langfuse community packages that register a credential under the same global `langfuseApi` key with a different schema; n8n indexes credential types by name, so whichever definition won the load order could overwrite this node's stored `url` with its own `host` default (`https://cloud.langfuse.com`), silently redirecting prompt fetches and traces to Langfuse Cloud (401 for self-hosted keys). A unique name removes the collision at the source. 0.2.2's `resolveBaseUrl` read-precedence fix (`url > host`) remains as defense in depth.

  **Migration:** after updating, create a new credential of type **"Agent Langfuse API"** with your Base URL, Public Key and Secret Key, then re-select it on each AI Agent + Langfuse node. n8n community nodes have no automatic credential migration, so the old credential will not carry over.

## [0.2.2] - 2026-07-08

### Fixed

- **Streaming now emits token deltas.** With a Webhook node in `responseMode: streaming` (or a streaming Chat Trigger) and the node's **Enable Streaming** option on, the reply arrived in a single lump at the end instead of streaming token-by-token. `streamRunnable` was hardcoded `false`, so LangChain never emitted the `on_chat_model_stream` events the `streamEvents` path keys on to send per-token chunks. It is now gated on the actual streaming decision (`isStreaming()` + Enable Streaming), matching n8n's built-in AI Agent; the non-streaming `invoke()` path is unchanged. ([#2](https://github.com/Diward/n8n-nodes-agent-langfuse/pull/2), thanks [@brendangooden](https://github.com/brendangooden))
- `resolveBaseUrl` now prefers the credential's own `url` field over `host`. The official `@langfuse/n8n-nodes-langfuse` package registers a credential type with the same name (`langfuseApi`) but a different schema (`host` instead of `url`, defaulting to `https://cloud.langfuse.com`). With both packages installed, the winning schema is load-order dependent per n8n process; when the official schema wins, n8n injects its `host` default into data stored by this node, and `host` previously beat the user's configured `url` — silently sending every prompt fetch and trace to Langfuse Cloud, which 401s for self-hosted keys. Precedence is now `url > host > baseUrl`, covered by unit tests (`npm test`). See the README troubleshooting entry for the 401 fingerprint. ([#4](https://github.com/Diward/n8n-nodes-agent-langfuse/pull/4), thanks [@brendangooden](https://github.com/brendangooden))

## [0.2.1] - 2026-06-05

### Changed

- Docs only. Refreshed the Features list in the README to reflect 0.2.0 capabilities: added bullets for Prompt Variable Substitution and Prompt-Linked Generations, updated the Automatic Tracing default to `<workflow name> - <node name>`, and expanded Auto Metadata to mention `execution_id`, `workflow`, and `node` with a link to the reserved-keys section.

## [0.2.0] - 2026-06-05

### Added

- Langfuse chat-prompt `{{variable}}` substitution. Selecting a prompt auto-loads one editable field per `{{var}}` detected in its `system` and `user` messages via n8n's `resourceMapper`. Values accept full n8n expression syntax.
- Support for user-role messages in Langfuse prompts. When the selected prompt defines a `user` message, the compiled content replaces the Text / chatInput field as the human turn.
- Generations now link to the Langfuse prompt version. They appear under the prompt's *Generations* tab and feed its metrics (cost, latency by version). Implemented by passing the fetched `ChatPromptClient` under the special `langfusePrompt` metadata key recognised by the `langfuse-langchain` `CallbackHandler`.
- Workflow context auto-populated in trace metadata: `execution_id`, `workflow.{id, name, active}`, `node`.
- Pre-LLM validation: missing or empty required variables throw `NodeOperationError` listing the offending names before any LLM call.

### Changed

- **Breaking (filters/dashboards):** default `traceName` is now `"<workflow name> - <node name>"` (previously `<node name>`). Set an explicit Trace Name on the node to keep the old value if you have Langfuse filters keyed on traceName.
- **Breaking (custom metadata):** auto-metadata keys `execution_id`, `workflow`, `node`, `project`, `prompt` are reserved. Collisions with user-supplied Custom Metadata are dropped with a `logger.warn` listing the ignored keys (previously the user's value would silently overwrite the auto field).
- `fetchPrompt` now uses the `langfuse` SDK (`ChatPromptClient`) instead of a raw HTTP fetch, enabling the SDK's prompt cache.

### Credits

- Implemented by [@brendangooden](https://github.com/brendangooden) in [#1](https://github.com/Diward/n8n-nodes-agent-langfuse/pull/1).

## [0.1.0] - 2026-04-20

### Added

- Initial release of `n8n-nodes-agent-langfuse`: n8n AI Agent V3 with native Langfuse integration in a single node.
- Prompt selector dropdown loading production chat-type prompts from Langfuse.
- Optional model and temperature override from the Langfuse prompt config.
- Automatic tracing via `langfuse-langchain` `CallbackHandler`, including `project`, `prompt.name`, `prompt.version` metadata.
- Configurable session ID, user ID, custom metadata, and trace name.
- Streaming, fallback model, batching, output parser, and memory support.

[0.2.2]: https://github.com/Diward/n8n-nodes-agent-langfuse/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Diward/n8n-nodes-agent-langfuse/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Diward/n8n-nodes-agent-langfuse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Diward/n8n-nodes-agent-langfuse/releases/tag/v0.1.0
