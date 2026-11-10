#!/bin/sh
# Downloads public OpenAPI documents at pinned commits into .real-specs/.
set -eu

dir=".real-specs/specs"
mkdir -p "$dir"

# fetch <file> <url>: <file> is the name in $dir, with its extension (.json or .yaml).
fetch() {
  file=$1
  url=$2
  if [ ! -s "$dir/$file" ]; then
    echo "fetch $file"
    curl -fsSL -o "$dir/$file" "$url"
  fi
}

oai=82b82f372aa185a07ea11bc158619895ab21f741
github=2f8f80e47ea4d3292cf4e37ba9d9b25475e06140
stripe=6360907ca278d6aecff118df90167e94aaba1437

oas="https://raw.githubusercontent.com/OAI/learn.openapis.org/$oai/examples/v3.0"
gh="https://raw.githubusercontent.com/github/rest-api-description/$github/descriptions/api.github.com"
st="https://raw.githubusercontent.com/stripe/openapi/$stripe/openapi"

# Each document in both of the forms its publisher provides.
for ext in json yaml; do
  fetch "petstore.$ext" "$oas/petstore.$ext"
  fetch "petstore-expanded.$ext" "$oas/petstore-expanded.$ext"
  fetch "github.$ext" "$gh/api.github.com.$ext"
  fetch "github-2026-03-10.$ext" "$gh/api.github.com.2026-03-10.$ext"
  fetch "stripe.$ext" "$st/spec3.$ext"
done
