# AGENTS.md

How to change kanagata without breaking README.md, which is the user-facing contract.

## Scope

kanagata makes two things from an OpenAPI 3.0 / 3.1 document, and only these:

- `kanagata generate`: one `.d.ts` of TypeScript types.
- `kanagata/client` (`src/client.ts`): one function over `fetch`, typed by those types; `kanagata init` copies it into a project.

Do not add what README lists under "Not supported"; point to it when asked.
The only runtime dependency is `yaml`, used only by the CLI. `src/client.ts` imports nothing, so an app bundles only the client (`tests/package.test.ts`).
The exports of `src/index.ts` and `src/client.ts` are public API under semver.

## Layout

- `src/` is the whole library, compiled one to one into `dist/` by `tsconfig.build.json`; every `bin` and `exports` entry is a file there. The package ships `dist/` and `src/client.ts` (for `init`).
- `tests/` and `scripts/` are never published.
- `dist/` and `.real-specs/` are generated and ignored by git.

| Config                             | Checks                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `tsconfig.json`                    | `src/` and tests as Node runs them; needs no build, so `pnpm test` works on a clean clone |
| `tsconfig.build.json`              | compiles `src/` into `dist/`                                                              |
| `tests/ts/tsconfig.json`           | the client and expected declarations, as a strict browser project                         |
| `scripts/real-specs.tsconfig.json` | the `test:real` output, and a call through the built `kanagata/client`                    |

## Commands

```sh
pnpm install    # Node from .node-version (26); pnpm from packageManager
pnpm test       # typecheck, Biome, tests at 100% coverage, client type tests
pnpm format     # Biome format and safe fixes
pnpm test:real  # GitHub, Stripe, Petstore at pinned commits: generate (JSON = YAML), tsc, built client
pnpm build      # dist/
```

`pnpm test` must pass before a change is done. When the generator changes, also run `pnpm test:real` and `diff -r` `.real-specs/out` against a copy from before: GitHub and Stripe output stays byte-identical unless the change means to alter it.

## Map

| Path                                         | Role                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                               | `generate`: parse, convert both views, cut cycles TypeScript rejects, name, render                      |
| `src/json.ts`                                | JSON parser keeping key order and number notation, rejecting repeated keys; JSON Pointer helpers        |
| `src/yaml.ts`                                | YAML 1.2 → the same values (via `yaml`)                                                                 |
| `src/pointer.ts`                             | `Ctx`: `$ref` resolution, base URI, read/write view, hoisting, component aliasing, warnings             |
| `src/schema.ts`                              | JSON Schema → `Ty`                                                                                      |
| `src/operation.ts`                           | paths, webhooks and operations → `Ty`                                                                   |
| `src/ty.ts`                                  | the type IR and its algebra (`union`, `inter`, `narrow`)                                                |
| `src/emit.ts`, `src/ident.ts`                | printing TypeScript; names and quoting                                                                  |
| `src/cli.ts`, `src/node-io.ts`, `src/bin.ts` | CLI over an injected `Io`; the real `Io`; exit codes                                                    |
| `src/client.ts`                              | the runtime client; the generator imports its media type rules and `METHODS` so types and runtime agree |
| `tests/spec/<name>/`                         | the specification: hand-written `input.json` / `input.yaml` → `expected.d.ts`, `expected.warn`          |
| `tests/errors/<name>/`                       | inputs the CLI rejects: `expected.err`, `expected.code`                                                 |
| `tests/unit/`                                | what spec cases cannot show: `generate`, `ty`, JSON syntax errors                                       |
| `tests/ts/`                                  | client: `runtime.test.ts`, `types.test.ts` (checked by `tsc -p tests/ts`)                               |
| `tests/package.test.ts`                      | what is published: build mapping, entry points, files, the client's imports                             |
| `scripts/`                                   | real-spec checks                                                                                        |

## Rules

1. **Test first.** Reproduce with a failing spec case, error case or unit test before touching `src/`.
2. **Expectations are written by hand.** Check every line of `expected.d.ts` against JSON Schema semantics; when output and expectation differ, either may be wrong.
3. **Types follow what the schema accepts**, as closely as TypeScript allows, never what another generator prints.
4. **100% coverage with behaviour tests.** Remove a branch no input reaches instead of testing it artificially. `test:unit` runs in one process because merged coverage can hide unreached branches.
5. **Real documents only.** Write code for documents as APIs publish them, not for pathological inputs. Show a pattern in a real document before calling it a defect. Unsupported or malformed input that real documents have is a located error (exit code 2) or a warning.
6. **README is the contract.** A user-observable change (output, warnings, CLI, client) updates README in the same change.
7. **Biome** formats and lints (`pnpm format`); a `biome-ignore` needs a reason that holds.
8. **Plain, not clever.** No guessing, no rescuing malformed schemas, no warnings for authors' mistakes. Where documents broadly mean something the specification's letter does not (`nullable` in 3.0), README states the convention.

## Commits

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description`, imperative, lower case, no period. Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`; scopes: `client`, `cli`, `yaml`, `ref`. A behaviour change goes in one commit with its tests and README; a breaking change uses `!` and a `BREAKING CHANGE:` footer.
