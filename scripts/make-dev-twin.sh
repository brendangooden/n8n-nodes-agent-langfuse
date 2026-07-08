#!/usr/bin/env bash
#
# make-dev-twin.sh — genera el "gemelo dev" del nodo a partir del codigo real.
#
# El gemelo es un paquete npm separado (n8n-nodes-agent-langfuse-dev) que puede
# convivir con el nodo de produccion en la MISMA instancia de n8n. Para ello
# reescribe 3 identificadores sobre una copia del codigo (sin duplicar fuente):
#   - nombre del paquete:   n8n-nodes-agent-langfuse -> n8n-nodes-agent-langfuse-dev
#   - nombre de credencial: langfuseApi              -> agentLangfuseApiDev
#   - nombre del nodo:       agentLangfuse            -> agentLangfuseDev
# (la credencial DEBE renombrarse: n8n indexa credenciales por 'name' sin
#  namespace de paquete, asi que compartir 'langfuseApi' colisiona con prod).
#
# Uso:   scripts/make-dev-twin.sh [version]
#   version por defecto: 0.3.0-dev.0
#
# Produce .dev-twin/n8n-nodes-agent-langfuse-dev-<version>.tgz (gitignored).
# NO publica: la publicacion es un paso manual y deliberado.
set -euo pipefail

VER="${1:-0.3.0-dev.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.dev-twin"

echo ">> generando gemelo dev  version=$VER"
rm -rf "$OUT"
mkdir -p "$OUT"

# 1) copiar fuente (sin node_modules/dist/.git); reutilizar deps por symlink
cp -a "$ROOT/nodes" "$ROOT/credentials" "$ROOT/test" \
      "$ROOT/tsconfig.json" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/LICENSE" \
      "$OUT/"
ln -s "$ROOT/node_modules" "$OUT/node_modules"

cd "$OUT"

# 2) reescribir identificadores en el codigo
#    - credencial: todas las apariciones del literal 'agentLangfuseApi' (con comillas)
#      cubren el name del credential type, el array credentials del nodo y los
#      getCredentials(). NO toca langfuseApiRequest (sin comillas) ni comentarios.
grep -rl "'agentLangfuseApi'" nodes credentials | xargs sed -i "s/'agentLangfuseApi'/'agentLangfuseApiDev'/g"
#    - credencial: displayName
sed -i "s/displayName = 'Agent Langfuse API'/displayName = 'Agent Langfuse API (dev)'/" \
  credentials/AgentLangfuseApi.credentials.ts
#    - nodo: name + displayName + defaults.name
sed -i "s/name: 'agentLangfuse'/name: 'agentLangfuseDev'/" \
  nodes/AgentLangfuse/AgentLangfuse.node.ts
sed -i "s/displayName: 'AI Agent + Langfuse'/displayName: 'AI Agent + Langfuse (dev)'/" \
  nodes/AgentLangfuse/AgentLangfuse.node.ts
sed -i "s/name: 'AI Agent + Langfuse'/name: 'AI Agent + Langfuse (dev)'/" \
  nodes/AgentLangfuse/AgentLangfuse.node.ts

# 3) reescribir package.json (name, version, description)
VER="$VER" node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("./package.json", "utf8"));
  p.name = "n8n-nodes-agent-langfuse-dev";
  p.version = process.env.VER;
  p.description = "[DEV TWIN] " + p.description;
  fs.writeFileSync("./package.json", JSON.stringify(p, null, 2) + "\n");
'

# 4) build + pack
npm run build >/dev/null
npm pack

echo ">> hecho:"
ls -1 "$OUT"/*.tgz
