# README screenshots

What each image in the README must show. Four of the five were captured on 2026-04-20 and no longer
match the node, so they carry a "pending update" note in the README until they are retaken.

| File | Status | Must show |
|---|---|---|
| `node-canvas.png` | Current | The node on the canvas with its Chat Model, Memory and Tool inputs |
| `credential-setup.png` | Outdated | The credential editor titled **Agent Langfuse API**, with the fields **Base URL**, **Public Key**, **Secret Key**, and a successful connection test |
| `node-configuration.png` | Outdated | The node parameters panel: Credential, Prompt Source, prompt selector, Model Source, Prompt Type, and a Custom Metadata example that uses **only non-reserved keys** (for example `env` and `tenant`) |
| `prompt-dropdown.png` | Outdated | The prompt selector open, listing the production `chat` prompts of the project. The Custom Metadata panel behind it must not show reserved keys either |
| `langfuse-trace.png` | Outdated | A Langfuse trace named `<workflow name> - <node name>`, whose Metadata panel contains `execution_id`, the `workflow` object (`id`, `name`, `active`), `node`, `project` and `prompt` (`name`, `version`) |

## Why the four are outdated

- `credential-setup.png` predates 0.3.0, which renamed the credential type from `langfuseApi` to
  `agentLangfuseApi`. The screenshot still says "Langfuse API" and labels the first field
  "Langfuse Host URL" instead of "Base URL".
- `node-configuration.png`, `prompt-dropdown.png` and `langfuse-trace.png` predate the automatic
  workflow context added in `14ac629` (2026-06-04). Their Custom Metadata example sets `workflow` and
  reads `{{ $execution.id }}` by hand. Both values are now populated automatically, and `workflow` is a
  reserved key: if custom metadata contains it, the key is dropped and a warning is logged. The trace
  screenshot shows the resulting old metadata, and a trace named after the node alone.

## Capturing

Keep the existing crops and widths so the README layout does not shift. Never capture real keys: the
credential fields mask them, but the Base URL and the project name are visible, so use a placeholder
host. The reserved keys are listed under "Automatic Metadata" in the README.
