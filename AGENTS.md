# AGENTS.md

How to work on kanagata. README.md is the user-facing contract (what the tool does); this file is how to change it without breaking that contract.

## Scope

kanagata makes two things from an OpenAPI 3.0 / 3.1 document (JSON or YAML, possibly split into files), and only these:

- `kanagata generate`: one `.d.ts` of TypeScript types.
- `kanagata/client`: `src/client.ts`, one thin function over `fetch`, typed by those types; published built from the package, and copied into a project by `kanagata init` for users who want to edit it.

Deliberately out of scope; do not add them, and point to README when asked: runtime validation (the client's `onData` is the hook for it), middleware or request/response hooks (users wrap `config.fetch`), per-operation functions, per-parameter `style` / `explode` / `encoding`, fetching `$ref`s over the network, Swagger 2.0, framework bindings (React Query, zod schemas, mocks).

The only runtime dependency is `yaml`, and only the CLI uses it; `src/client.ts` imports nothing, so an app bundles only the client (`tests/package.test.ts`). Keep it that way. The exports of `src/client.ts` are public API under semver, like `generate`.

## Layout

- `src/` is the library, and all of it: `tsconfig.build.json` compiles it one to one into `dist/` (`src/client.ts` → `dist/client.js`), and every `bin` and `exports` entry is a file there. The package ships `dist/` and `src/client.ts`, which `init` copies.
- `tests/` and `scripts/` are never published or compiled into `dist/`.
- Generated and downloaded files are ignored by git and never checked in: `dist/` (`pnpm build`, which empties it first) and `.real-specs/` (`pnpm test:real`).
- TypeScript configs, one per way the code is used:

  | Config                             | Checks                                                                                                                                         |
  | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
  | `tsconfig.json`                    | `src/` and the tests, as Node runs them directly. Nothing in it may need a build or generated files, so `pnpm test` works on a clean checkout. |
  | `tsconfig.build.json`              | compiles `src/` into `dist/`                                                                                                                   |
  | `tests/ts/tsconfig.json`           | the client and the expected declarations, as a strict browser project would                                                                    |
  | `scripts/real-specs.tsconfig.json` | what `test:real` builds and generates, and a call through the built `kanagata/client`                                                          |

## Commands

```sh
pnpm install    # Node from .node-version (26); pnpm from packageManager
pnpm test       # typecheck, Biome lint + format check, unit/spec/CLI/runtime tests at 100% coverage, client type tests
pnpm format     # Biome: format and apply safe fixes
pnpm test:real  # GitHub, Stripe, Petstore at pinned commits: generate (JSON and YAML must agree), tsc, and the built kanagata/client
pnpm build      # dist/
```

`pnpm test` must pass before any change is called done. Run `pnpm test:real` too when the generator changes; GitHub and Stripe output should stay byte-identical unless the change is meant to alter it (keep a copy of `.real-specs/out` from before and `diff -r` it).

## Map

| Path                                         | Role                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                               | `generate(src, source?)`: parse, convert components and schemas hoisted from other files in both views, cut cycles TypeScript rejects, name, render       |
| `src/json.ts`                                | JSON parser that keeps key order and number notation, rejects repeated keys; JSON Pointer helpers                                                         |
| `src/yaml.ts`                                | YAML 1.2 → the same values (via `yaml`): number notation, aliases, merge-key warning                                                                      |
| `src/pointer.ts`                             | `Ctx`: `$ref` resolution by URI (document, `$id`, `$anchor`, other files loaded once), base URI, read/write view, hoisting, component aliasing, warnings  |
| `src/schema.ts`                              | JSON Schema → `Ty`: keywords are a conjunction; readOnly / writeOnly views; `$ref` (named, hoisted or expanded inline)                                    |
| `src/operation.ts`                           | paths, webhooks and operations → `Ty`                                                                                                                     |
| `src/ty.ts`                                  | the type IR and its algebra: `union` / `inter` normalization, one rule for intersecting kinds and values (`narrow`)                                       |
| `src/emit.ts`, `src/ident.ts`                | printing TypeScript; type names and quoting                                                                                                               |
| `src/cli.ts`, `src/node-io.ts`, `src/bin.ts` | CLI over an injected `Io`; the real `Io`; exit codes 0/1/2/3                                                                                              |
| `src/client.ts`                              | the runtime client (`kanagata/client`); the generator imports its media type rules (`isBinaryMedia`, `isTextMedia`, `METHODS`) so types and runtime agree |
| `tests/spec/<name>/`                         | the specification: hand-written `input.json` or `input.yaml` (plus any files it `$ref`s) → `expected.d.ts` and `expected.warn`                            |
| `tests/errors/<name>/`                       | inputs the CLI must reject: `expected.err`, `expected.code`                                                                                               |
| `tests/unit/`                                | what spec cases cannot show: the library API (`generate`), the type algebra (`ty`), JSON syntax errors (`json`)                                           |
| `tests/ts/`                                  | client: `runtime.test.ts` (requests and responses), `types.test.ts` (checked by `tsc -p tests/ts`)                                                        |
| `tests/package.test.ts`                      | what is published: the build maps `src/` to `dist/`, entry points, shipped files, the client's imports                                                    |
| `scripts/`                                   | real-spec checks, including a call through the built `kanagata/client`                                                                                    |

## How to change it

1. **Test first.** Reproduce the behaviour with a failing spec case, error case or unit test, and see it fail, before touching `src/`.
2. **Expectations are written by hand.** Never copy generator output into `expected.d.ts` without checking every line against JSON Schema semantics. When output and expectation differ, decide which one is wrong; it is not always the code.
3. **Types follow what the schema accepts.** Judge output by JSON Schema meaning (a value is valid for the type iff it is valid for the schema, as closely as TypeScript allows), never by what openapi-typescript or another generator prints.
4. **Coverage stays at 100% with behaviour tests.** A branch no input reaches is removed, not tested artificially. `test:unit` runs in one process (`--test-isolation=none`) because merging coverage from several processes can report unreached branches as covered.
5. **Real documents, not constructed ones.** Write code for documents as APIs publish them (the real specs in `test:real`, and patterns they use). Do not add code for inputs built to be pathological (deep nesting, looping `$ref`s or aliases, exponential expansion, huge counts, scripts no one writes names in): it only adds code and bugs. Before treating a finding as a defect, show the pattern in a real document. An unsupported or malformed input that real documents have is a located error (exit code 2) or a warning.
6. **README is the contract.** Any change a user can observe (output, warnings, CLI, client behaviour) updates README in the same change.
7. **Format and lint with Biome** (`pnpm format`); a `biome-ignore` needs a reason that holds.
8. **Plain, not clever.** Types say what the schema says; the client does what fetch does with what the call states. No guessing, no rescuing a malformed schema, no warnings for an author's mistake. Where documents broadly mean something the letter of the specification does not say (`nullable` in 3.0), README states the convention followed.

## Commits

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description` in the imperative, lower case, no period. Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`; scopes when they help: `client`, `cli`, `yaml`, `ref`. A behaviour change and its tests and README update go in one commit; a breaking change says so with `!` and a `BREAKING CHANGE:` footer.
