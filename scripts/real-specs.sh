#!/bin/sh
# Generates declarations for public OpenAPI documents (JSON and YAML forms must agree)
# and type-checks them with tsc.
set -eu

sh scripts/fetch-real-specs.sh
pnpm build

bin="node dist/bin.js"
out=".real-specs/out"
mkdir -p "$out"

for spec in .real-specs/specs/*.json; do
  name=$(basename "$spec" .json)
  $bin generate "$spec" -o "$out/$name.d.ts"
  echo "generated $out/$name.d.ts"
done

# The YAML form of each document must give the same declarations as the JSON form.
for spec in .real-specs/specs/*.yaml; do
  name=$(basename "$spec" .yaml)
  $bin generate "$spec" -o "$out/$name.yaml.d.ts"
  cmp "$out/$name.d.ts" "$out/$name.yaml.d.ts"
  echo "yaml: $name matches json"
done

# As a strict user project would compile them (tsc --init options of TypeScript 7.0),
# without skipLibCheck: checking the generated .d.ts files is the point. real-specs-usage.ts
# calls the published client (kanagata/client) with them.
tsc -p scripts/real-specs.tsconfig.json
echo "tsc: ok"

# The built client loads as kanagata/client.
node --input-type=module -e 'const { createClient } = await import("kanagata/client"); if (typeof createClient !== "function") process.exit(1);'
echo "kanagata/client: ok"
