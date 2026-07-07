# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-08

### Changed

- **Breaking: credential type renamed `langfuseApi` → `agentLangfuseApi`** (displayed as "Agent Langfuse API"). n8n credential type names are a global namespace across community packages, and the official `@langfuse/n8n-nodes-langfuse` package also registers `langfuseApi` with a different schema (`host` instead of `url`). With both installed, the winning schema is load-order dependent per process — the credential test could pass on the main instance while every execution on a queue-mode worker silently sent requests to `https://cloud.langfuse.com` and failed with 401. The namespaced type eliminates the collision.
  **Migration:** after upgrading, create a new "Agent Langfuse API" credential with the same Base URL and keys, and select it in each AI Agent + Langfuse node (the old `langfuseApi` credential no longer matches this node's credential type).

### Fixed

- `resolveBaseUrl` now prefers the credential's own `url` field over `host`. Previously `host` won, so a `host` default injected by the colliding official schema silently overrode the user's configured self-hosted URL (see the README troubleshooting entry for the 401 "Invalid credentials. Confirm that you've configured the correct host." fingerprint). Covered by unit tests (`npm test`).

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

[0.4.0]: https://github.com/brendangooden/n8n-nodes-agent-langfuse/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/brendangooden/n8n-nodes-agent-langfuse/compare/v0.2.1...v0.3.1
[0.2.1]: https://github.com/Diward/n8n-nodes-agent-langfuse/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Diward/n8n-nodes-agent-langfuse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Diward/n8n-nodes-agent-langfuse/releases/tag/v0.1.0
