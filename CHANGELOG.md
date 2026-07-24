# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-07-23

### Changed

- **Synced with upstream `n8n-nodes-agent-langfuse` v0.5.0.** Migrated to LangChain v1 (agents/tools now from `@langchain/classic`) and the Langfuse v5 SDK (`@langfuse/client` / `@langfuse/langchain`). This fixes the `400 Missing parameter 'tool_call_id'` failure that occurred when n8n (>= 2.20, on LangChain v1) injected a v1 chat model into this node while it still bundled LangChain v0.x: the v0.x `AgentExecutor` could not read the v1 model's tool-call output, so the tool messages replayed on the second turn lost their `tool_call_id`. Aligning the bundled LangChain major with n8n's is the fix.
- **Fork-specific:** kept the `langfuseApi` credential name (did **not** adopt upstream's `agentLangfuseApi` rename), so existing credentials keep working; the `resolveBaseUrl` collision fix (`url` beats an injected `host`) is retained. See the 401 troubleshooting entry in the README.

The entries below from upstream v0.5.0 / v0.4.1 are included by this sync:

## [0.5.0] - 2026-07-10

### Added

- **The Langfuse trace is now on the node output.** Every output item carries `langfuseTraceId` and, when the project id can be read, a clickable `langfuseTraceUrl`, so a downstream node can link to the trace, attach a score to it, or gate on it without leaving the workflow. The id is captured from the routing span processor, which already sees every span's trace, so it needs nothing from the Langfuse internals and survives a failing flush.
- **An `Environment` field** on the Langfuse Metadata collection. It writes `langfuse.environment` on the trace's root span, the same way Session ID and User ID are written, so production, staging and test traces separate cleanly in Langfuse. Left empty, Langfuse applies its own default.

## [0.4.1] - 2026-07-10

### Added

- **PDF and text attachments reach the model.** The node forwarded binary images and silently dropped everything else, so a workflow that attached a paper or a CSV to the prompt sent the model nothing at all. PDFs now ride on a new **Automatically Passthrough Binary PDFs** option, off by default and useful for models that read PDFs natively such as Gemini. Text files, JSON, XML, CSV and YAML are forwarded whenever either passthrough option is on, which is the rule n8n's own agent applies. Attachments over 50 MB are refused with a clear message rather than sent.

### Fixed

- **A reasoning model's answer came back as a raw array.** An extended reasoning model, Claude for instance, replies with an array of content blocks. The node joined them only when every block carried `text`, so a single `thinking` block made it return the array itself, and an answer made only of `thinking` returned the array too. The text blocks now win, the thinking blocks are the fallback when there is no text at all, and the scratchpad never joins the answer. A block must declare `type: "text"` to count as text, which is what n8n checks.
- **An output parser rejected an answer the model had already wrapped.** When the model produced `{"output": "hi"}` on its own, the node wrapped it again and handed the parser `{"output":{"output":"hi"}}`, which no schema accepts. A single key `output` wrapper is now passed through untouched.
- **`RoutingSpanProcessor.shutdown()` left the router usable.** It forwarded to its processors but kept them in the map, so a span raised by an execution still in flight reached an exporter that was closing, and `ensure()` would build a fresh processor nothing would ever shut down. A second, concurrent shutdown returned while the first was still draining. The node never calls this itself, since n8n gives a community node no shutdown hook, but the contract belongs to OpenTelemetry and a provider is free to invoke it.
- **The node icon's head and shoulders did not meet.** The shoulder line sat half a unit above the head's baseline, leaving a visible ledge where the two strokes crossed, and the open ends of the antenna and the shoulders were rounded. They are square now, and the strokes are collinear.

## [0.4.0] - 2026-07-10

### Changed

- **This release requires n8n 2.0.0 or later, and a Langfuse server on 3.0 or later.** It builds its messages with `@langchain/core` 1.x, the major n8n ships from 2.0, and it sends traces through Langfuse's OpenTelemetry endpoint, which earlier servers do not expose. On n8n 1.x, stay on 0.3.3. The floor is declared rather than enforced at load time: nothing refuses to start, but nothing about that combination is tested either.
- **Tracing moved to the Langfuse v5 SDK**, which is built on OpenTelemetry. `langfuse-langchain@3` peer-depends on `langchain <0.4`, the dependency this release leaves behind, so staying on it was not an option. Credentials now live on a span processor rather than on the callback handler, prompts are fetched through `@langfuse/client`, and flushing goes through the tracer provider. Traces keep their name, their shape and their metadata.
- **The node icon is a robot bust**, matching the icon n8n now uses for its agent. It is drawn for this package rather than copied: n8n's packages are under the Sustainable Use License and this one is MIT. The Langfuse badge stays, so the node remains distinguishable from the native agent.

### Fixed

- **Tools work, by construction rather than by patch.** 0.3.3 branded `BaseMessage.prototype` so that n8n's `@langchain/core` 1.x would recognise the messages this package built with core 0.3, which is what kept `tool_call_id` on tool results. This release shares the major instead: `@langchain/core` 1.x, `@langchain/openai` 1.x and `@langchain/classic` 1.x, exactly what n8n 2.x resolves. `createToolCallingAgent` and `AgentExecutor` moved to `@langchain/classic`; they were never removed. The shim is gone. ([#7](https://github.com/Diward/n8n-nodes-agent-langfuse/issues/7))
- **A second Langfuse credential no longer leaks traces into the wrong project.** OpenTelemetry hands every span to every registered span processor, and Langfuse's default filter accepts any Langfuse span regardless of project, so two credentials would have exported each trace to both. Spans are now routed to the processor of the credential that raised them, keyed by trace id and carried in an `AsyncLocalStorage`.
- **Every execution produced two broken traces, neither of them named.** `@langfuse/langchain` 5.9.1 registers the agent action span under the chain's own run id, overwriting the chain span in its internal run map, and parents it at the root because `AgentExecutor` hands `handleAgentAction` the chain's parent run id. The chain span was never ended. Tool calls are already reported through `handleToolStart`, so the two agent callbacks are dropped and the trace is a single, correctly nested tree again.
- **`sessionId` and `userId` arrived empty.** Langfuse reads them from the root span of a trace, and its own `propagateAttributes` writes them to the active OpenTelemetry span, which does not exist unless a global context manager is registered. n8n registers one only while its `otel` module is enabled. This package will not install process wide OpenTelemetry globals to work around that, so it writes the two attributes itself.

### Added

- `test/toolCallId.test.js`, which drives the agent against a local mock provider and asserts the tool result reaches it carrying its `tool_call_id`. Issue #7 survived three releases because nothing asserted the payload actually sent.
- `test/tracing.test.js`, which asserts that a span raised under one credential never reaches another credential's processor.
- `NOTICE`, attributing the six agent helpers derived from `@n8n/n8n-nodes-langchain`. Three of them have drifted from upstream: this node does not pass PDF or text attachments to the model, does not filter thinking content blocks out of a final answer, and re-wraps an output parser result already shaped as `{output: ...}`. Closing that gap is tracked separately.

## [0.3.3] - 2026-07-09

### Fixed

- **Tools always failed on recent n8n.** Attaching any tool made every run end with `Bad request - please check your parameters` / `Provider returned error`, with or without streaming. The node dropped `tool_call_id` from the tool result, and every OpenAI compatible provider rejects a `role: "tool"` message without it. n8n instantiates the chat model from its own LangChain copy, currently `@langchain/core` 1.x, while this package builds the conversation with core 0.3. Core 1.x guards message handling with a brand check (`Symbol.for("langchain.message")` plus a `type` property) that a core 0.3 message cannot pass, so `@langchain/openai` skipped the branch that copies `tool_call_id`. The messages this package builds are now branded so core 1.x recognises them. Both descriptors are non enumerable, so message serialisation is unchanged. This is a stopgap: sharing a LangChain major with n8n is the real fix and will land in 0.4.0. ([#7](https://github.com/Diward/n8n-nodes-agent-langfuse/issues/7))

## [0.3.2] - 2026-07-09

### Fixed

- **Gemini tool schemas lost every `$ref`.** `$ref` and `$defs` were stripped without being resolved, so a referenced property was advertised to the model as an empty schema while it stayed in `required`: the model no longer knew the argument's shape yet was still obliged to fill it. Converters factor out reused types as a `$ref`, so this affected ordinary tools, not just exotic ones. Local pointers are now inlined before the unsupported keywords are removed, sibling keywords next to a `$ref` win over the referenced schema, and recursive or unresolvable references degrade to `{}` instead of looping.
- **`allOf` was flattened to its first object subschema**, silently dropping the properties and required entries of the other branches. `allOf` means "satisfy all", so it is now merged. `anyOf` and `oneOf` are genuine alternatives, so they still collapse to the first branch.
- **`npm test` did not run on Node 20**, the floor this package declares in `engines`. The script passed a `**` glob to `node --test`, which only expands it from Node 22 on; on Node 20 the runner reported `Could not find` and executed nothing. It now passes `test/*.test.js`, which both versions accept.

### Added

- Continuous integration on pull requests and pushes to `main`: build, unit tests and `npm pack --dry-run` on Node 20 and 22. Releases are published to npm from a `v*` tag using npm trusted publishing (OIDC), so no long lived npm token is stored anywhere. Both workflows are adapted from [@brendangooden](https://github.com/brendangooden)'s fork.
- `zod` is now an explicit devDependency. The Gemini tests import it and were relying on it being hoisted from a transitive install.

### Changed

- Documentation. The README still called the credential "Langfuse API" and told self-hosted users to uninstall one of two colliding packages. Since 0.3.0 the credential type is `agentLangfuseApi`, which no other package registers, so that collision no longer applies. Adds an Upgrading section for users coming from 0.2.x, since the rename is breaking and n8n community nodes have no automatic credential migration.

## [0.3.1] - 2026-07-09

### Fixed

- **Gemini rejected JSON-Schema type unions.** A tool schema carrying a draft-07 union such as `{"type": ["string", "null"]}`, which is what most converters emit for a nullable or optional field, was passed through untouched and Vertex answered `400 INVALID_ARGUMENT` (`Unknown name "type"`). Gemini's `Schema.type` is a single enum value and nullability is expressed with a separate `nullable` flag. The sanitizer now collapses the union to its first non-null type and sets `nullable: true` when `null` was one of the members. Verified against the live Gemini API.

### Changed

- `zod-to-json-schema` is now resolved lazily, on first conversion of a Zod tool schema, instead of at module load. A broken or partially extracted copy of that package under `~/.n8n/nodes` no longer makes this module unloadable. Note that `@langchain/core` still requires the package eagerly, so this alone does not rescue a corrupt install (see [#6](https://github.com/Diward/n8n-nodes-agent-langfuse/issues/6)); it only removes this node's own contribution to that failure mode.
- The `zod-to-json-schema` range was widened from `^3.25.2` to `^3.22.3` to match the range `@langchain/core` declares. When a compatible copy is already hoisted, npm now dedupes to a single shared copy instead of nesting a second one under this package.

## [0.3.0] - 2026-07-08

### Added

- **Google Gemini / Vertex AI tool support.** With a Gemini or Vertex chat model, attaching any tool made every run fail with `400 INVALID_ARGUMENT`: Gemini validates `functionDeclarations` far more strictly than OpenAI/Anthropic and rejects JSON-schema keywords those providers silently ignore (`additionalProperties`, `$schema`, string `format`s such as `uri`/`uuid`, and `anyOf`/`oneOf`/`allOf` unions), all of which MCP-generated tool schemas routinely contain. A new `geminiSchema` module rewrites each tool's advertised schema into a Gemini-safe JSON Schema, applied only when the connected model routes to Google (a strict no-op for OpenAI/Anthropic). The tool still executes normally; only the schema sent to the model changes. Verified against the live Gemini API (`gemini-2.5-flash`): a raw MCP-style schema is rejected with `400 INVALID_ARGUMENT` (`Unknown name "additionalProperties"`), and the same schema after sanitization returns `200` with a valid tool call. `isGeminiModel` was confirmed to fire on the real `@langchain/google-genai` and `@langchain/google-vertexai` chat model classes and to stay off for OpenAI/OpenRouter. Note that current `@langchain/google-genai` also sanitizes tool schemas in its own bind path, so the raw 400 is most visible on the Vertex client path this PR originally targeted; the sanitizer is a correct, idempotent safeguard on both. ([#5](https://github.com/Diward/n8n-nodes-agent-langfuse/pull/5), thanks [@harmoney-stella](https://github.com/harmoney-stella))

### Changed

- **BREAKING: credential type renamed `langfuseApi` → `agentLangfuseApi`** (display name "Agent Langfuse API"). The old name collided with other installed Langfuse community packages that register a credential under the same global `langfuseApi` key with a different schema; n8n indexes credential types by name, so whichever definition won the load order could overwrite this node's stored `url` with its own `host` default (`https://cloud.langfuse.com`), silently redirecting prompt fetches and traces to Langfuse Cloud (401 for self-hosted keys). A unique name removes the collision at the source. 0.2.2's `resolveBaseUrl` read-precedence fix (`url > host`) remains as defense in depth.

  **Migration:** after updating, create a new credential of type **"Agent Langfuse API"** with your Base URL, Public Key and Secret Key, then re-select it on each AI Agent + Langfuse node. n8n community nodes have no automatic credential migration, so the old credential will not carry over.

## [0.2.2] - 2026-07-08

### Fixed

- **Streaming now emits token deltas.** With a Webhook node in `responseMode: streaming` (or a streaming Chat Trigger) and the node's **Enable Streaming** option on, the reply arrived in a single lump at the end instead of streaming token-by-token. `streamRunnable` was hardcoded `false`, so LangChain never emitted the `on_chat_model_stream` events the `streamEvents` path keys on to send per-token chunks. It is now gated on the actual streaming decision (`isStreaming()` + Enable Streaming), matching n8n's built-in AI Agent; the non-streaming `invoke()` path is unchanged. ([#2](https://github.com/Diward/n8n-nodes-agent-langfuse/pull/2), thanks [@brendangooden](https://github.com/brendangooden))
- `resolveBaseUrl` now prefers the credential's own `url` field over `host`. The official `@langfuse/n8n-nodes-langfuse` package registers a credential type with the same name (`langfuseApi`) but a different schema (`host` instead of `url`, defaulting to `https://cloud.langfuse.com`). With both packages installed, the winning schema is load-order dependent per n8n process; when the official schema wins, n8n injects its `host` default into data stored by this node, and `host` previously beat the user's configured `url`, silently sending every prompt fetch and trace to Langfuse Cloud, which 401s for self-hosted keys. Precedence is now `url > host > baseUrl`, covered by unit tests (`npm test`). See the README troubleshooting entry for the 401 fingerprint. ([#4](https://github.com/Diward/n8n-nodes-agent-langfuse/pull/4), thanks [@brendangooden](https://github.com/brendangooden))
## [0.4.0] - 2026-07-08

### Fixed

- `resolveBaseUrl` now prefers the credential's own `url` field over `host`. The official `@langfuse/n8n-nodes-langfuse` package registers a credential type with the same name (`langfuseApi`) but a different schema (`host` instead of `url`, defaulting to `https://cloud.langfuse.com`). With both packages installed, the winning schema is load-order dependent per n8n process; when the official schema wins, n8n injects its `host` default into data stored by this node, and `host` previously beat the user's configured `url` — silently sending every prompt fetch and trace to Langfuse Cloud, which 401s for self-hosted keys. The credential test could pass on the main instance while every execution on a queue-mode worker failed. Precedence is now `url > host > baseUrl` and is covered by unit tests (`npm test`). See the README troubleshooting entry for the 401 "Invalid credentials. Confirm that you've configured the correct host." fingerprint; avoid installing both packages on one instance if you can.

## [0.3.1] - 2026-07-01

### Fixed

- Streaming: token deltas are emitted again by gating `streamRunnable` on the stream decision (previously intermediate chunks were not streamed to the chat UI).

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

[0.5.0]: https://github.com/brendangooden/n8n-nodes-agent-langfuse/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/brendangooden/n8n-nodes-agent-langfuse/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/brendangooden/n8n-nodes-agent-langfuse/compare/v0.2.1...v0.3.1
[0.2.1]: https://github.com/Diward/n8n-nodes-agent-langfuse/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Diward/n8n-nodes-agent-langfuse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Diward/n8n-nodes-agent-langfuse/releases/tag/v0.1.0
