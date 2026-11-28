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
openai=4f17927eb7dc9208b17cfeacf0a125a649850ebc
discord=654230017d4f5ee3e6a59a769ffc40cf61001e3f

oas="https://raw.githubusercontent.com/OAI/learn.openapis.org/$oai/examples/v3.0"
gh="https://raw.githubusercontent.com/github/rest-api-description/$github/descriptions/api.github.com"
# OpenAPI 3.1, with webhooks (some with form-encoded requests).
ghnext="https://raw.githubusercontent.com/github/rest-api-description/$github/descriptions-next/api.github.com"
st="https://raw.githubusercontent.com/stripe/openapi/$stripe/openapi"
# OpenAPI 3.1, with propertyNames, not, if and many const.
oa="https://raw.githubusercontent.com/openai/openai-openapi/$openai"
# OpenAPI 3.1, with many uniqueItems and const.
dc="https://raw.githubusercontent.com/discord/discord-api-spec/$discord/specs"

# Each document in both of the forms its publisher provides.
for ext in json yaml; do
  fetch "petstore.$ext" "$oas/petstore.$ext"
  fetch "petstore-expanded.$ext" "$oas/petstore-expanded.$ext"
  fetch "github.$ext" "$gh/api.github.com.$ext"
  fetch "github-2026-03-10.$ext" "$gh/api.github.com.2026-03-10.$ext"
  fetch "github-next.$ext" "$ghnext/api.github.com.$ext"
  fetch "stripe.$ext" "$st/spec3.$ext"
  fetch "openai.$ext" "$oa/openapi.$ext"
done
# Discord publishes JSON only.
fetch "discord.json" "$dc/openapi.json"
