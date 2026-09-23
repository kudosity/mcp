#!/usr/bin/env bash
# Build the Claude Desktop extension: dist-mcpb/kudosity-mcp-<version>.mcpb
# Stages a clean copy (compiled server + production node_modules + manifest),
# validates the manifest, packs it, and prints the bundle summary.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
STAGE=build/mcpb
OUT=dist-mcpb/kudosity-mcp-$VERSION.mcpb

npm run build
# Keep manifest.json's version in lock-step with package.json.
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
if (m.version !== process.argv[1]) { m.version = process.argv[1]; fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n"); }
' "$VERSION"

rm -rf "$STAGE" && mkdir -p "$STAGE" dist-mcpb
cp -R dist manifest.json package.json package-lock.json icon.png LICENSE README.md "$STAGE"/
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

npx mcpb validate "$STAGE/manifest.json"
rm -f "$OUT"
npx mcpb pack "$STAGE" "$OUT"
npx mcpb info "$OUT"
echo "Built $OUT"
