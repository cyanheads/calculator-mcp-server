# Changelog

## 0.1.10 — 2026-04-20

Framework bump to `@cyanheads/mcp-ts-core` 0.5.3, `parseEnvConfig` adoption, and skill sync.

### Added

- Adopted `parseEnvConfig` in `src/config/server-config.ts` — validation errors now name the actual env var (`CALC_MAX_EXPRESSION_LENGTH`) instead of the internal Zod path

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.3.5` to `^0.5.3` (spans 9 tags — new `parseEnvConfig` helper, format-parity linter rule with sentinel injection, devcheck CLAUDE.md/AGENTS.md sync check, Vitest 4 projects pattern, and multiple fixes)
- Upgraded `typescript` from `^6.0.2` to `^6.0.3`
- Synced seven external skills from the package (`add-tool`, `api-config`, `design-mcp-server`, `field-test`, `maintenance`, `polish-docs-meta`, `setup`) and mirrored all skills into `.claude/skills/`
- Regenerated `bun.lock` from a clean state
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.10`

### Fixed

- Cleared the transitive hono moderate-severity advisory (GHSA-458j-xx4x-4375) via fresh lockfile resolution

## 0.1.9 — 2026-04-14

Dependency refresh, form-client input normalization, and metadata updates.

### Added

- `AGENTS.md` to the published package file list
- `skills/add-app-tool/` from the latest `@cyanheads/mcp-ts-core` skill sync

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.10` to `^0.3.5`
- Upgraded `mathjs` from `^15.1.1` to `^15.2.0`
- Upgraded `@biomejs/biome` from `^2.4.10` to `^2.4.12`, `@types/node` from `^25.5.0` to `^25.6.0`, and `vitest` from `^4.1.2` to `^4.1.4`
- Synced project skills with the newer framework skill set
- Normalized blank optional `variable` and `precision` inputs from form-based MCP clients so they are treated as omitted
- Removed the `calculator://help` reference from the `calculate` tool description and rewrote schema descriptions as single strings without `+` concatenation
- Regenerated `bun.lock` and `docs/tree.md`
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.9`

### Fixed

- Cleared `bun audit` warnings by regenerating the lockfile against the updated dependency graph

## 0.1.8 — 2026-03-30

Package metadata and dev dependency updates.

### Added

- Funding metadata — GitHub Sponsors and Buy Me a Coffee links in `package.json`

### Changed

- Expanded `author` field with email and homepage URL
- Bumped `@biomejs/biome` from `^2.4.9` to `^2.4.10`

## 0.1.7 — 2026-03-30

Public hosted instance and distribution metadata.

### Added

- Public hosted server section in README with streamable-http config example (`https://calculator.caseyjhand.com/mcp`)
- npm and Docker badges in README header
- `remotes` array in `server.json` with public streamable-http endpoint

### Changed

- Reorganized Getting Started section — "Public Hosted Instance" before "Self-Hosted / Local"

## 0.1.6 — 2026-03-30

Security hardening: scope sanitization, result type/size validation, newline separator blocking, and prototype pollution prevention.

### Added

- `CALC_MAX_RESULT_LENGTH` env var — configurable maximum result string length (default 100,000 characters)
- Blocked result types (`function`, `Function`, `ResultSet`, `Parser`) — prevents leaking internal source code or multi-expression bypass
- Blocked scope keys — rejects prototype-polluting keys (`__proto__`, `constructor`, `prototype`, etc.) in variable scope
- Result size validation on all output paths (evaluate, simplify, derivative)
- Redacted `version` constant in expression scope — prevents math.js version fingerprinting
- `parser` added to disabled functions list

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.9` to `^0.2.10`
- Renamed `hasTopLevelSemicolon` → `hasExpressionSeparator` — now also blocks newline (`\n`, `\r`) expression separators
- Added `.max(50)` and alphanumeric regex validation to `variable` input parameter
- Added `.int()`, `.min()`, `.max()` constraints to `maxExpressionLength` and `evaluationTimeoutMs` config fields
- Updated error message for multi-expression rejection to cover newlines

## 0.1.5 — 2026-03-30

Trigonometric simplification rules and stricter non-finite result handling.

### Added

- Trigonometric simplification rules — Pythagorean identities, double-angle identities, and tan/sec/csc/cot relationships applied during `simplify` operations
- Tests for trig simplification (Pythagorean, double-angle, `1 - sin^2`, `tan^2 + 1`)

### Changed

- Updated `simplify` operation description to mention algebraic and trigonometric identity support
- Non-finite results (Infinity, NaN) from division (e.g., `1/0`, `0/0`) now throw instead of returning silently — tests updated to expect throws

## 0.1.4 — 2026-03-30

Dependency update, input validation tightening, and error message improvements.

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.2.8` to `^0.2.9`
- Reduced max `precision` parameter from 64 to 16 significant digits
- Updated `resultType` output description to use `DenseMatrix` (matching math.js actual type name)
- Added guard for non-finite evaluation results (Infinity, NaN) — now throws `InvalidParams` with an actionable message
- Improved error messages for expression evaluation failures with `Invalid expression:` prefix
- Removed explicit `list` callback from `calculator://help` resource (framework handles resource listing)
- Aligned `server.json` description with README tagline
- Removed "STDIO & Streamable HTTP" from README tagline

## 0.1.3 — 2026-03-29

Input validation hardening, resource listing support, and documentation updates.

### Changed

- Added `.min(1)` validation to `expression` input — empty strings now rejected at schema level
- Changed `precision` minimum from 0 to 1 (significant digits must be at least 1)
- Added empty-expression guard in `MathService.validateInput()`
- Added `list` callback to `calculator://help` resource for resource listing support
- Updated `server.json` description wording
- Added floating-point rounding note to help content for unit conversions
- Added `migrate-mcp-ts-template` skill and `bun run lint:mcp` command to agent protocol

## 0.1.2 — 2026-03-28

Core calculator implementation — replaces scaffold echo tool with full math evaluation surface.

### Added

- `calculate` tool — evaluate, simplify, or differentiate math expressions via a single tool with `operation` parameter (defaults to `evaluate`)
- `calculator://help` resource — static reference of available functions, operators, constants, and syntax
- `MathService` with hardened math.js v15 instance — dangerous functions disabled in expression scope, evaluation sandboxed via `vm.runInNewContext()` with configurable timeout
- Server config module (`src/config/server-config.ts`) — lazy-parsed Zod schema for `CALC_MAX_EXPRESSION_LENGTH` and `CALC_EVALUATION_TIMEOUT_MS`
- `mathjs` v15 dependency
- Test suite for calculate tool covering evaluate, simplify, derivative, error handling, and format output

### Removed

- Scaffold `echo` tool (`template_echo_message`)

## 0.1.1 — 2026-03-28

Package metadata, documentation, and agent protocol polish.

### Added

- README.md with tool/resource reference, configuration, getting started, and project structure
- LICENSE (Apache 2.0)
- `bunfig.toml` for Bun runtime configuration
- Server-specific env vars (`CALC_MAX_EXPRESSION_LENGTH`, `CALC_EVALUATION_TIMEOUT_MS`) in `server.json` package definitions
- `depcheck` devDependency

### Changed

- Scoped package name to `@cyanheads/calculator-mcp-server`
- Updated `server.json` name to `io.github.cyanheads/calculator-mcp-server` with `bun` runtime hint
- Updated agent protocol (CLAUDE.md) with actual calculator tool/resource patterns; trimmed unused context properties
- Expanded package.json with keywords, homepage, bugs, author, and bun engine metadata
- Updated Dockerfile labels with description and source URL
- Updated `.env.example` with calculator-specific env vars
- Updated `devcheck.config.json` to ignore `depcheck` and `tsx` deps
- Regenerated `docs/tree.md`

## 0.1.0 — 2026-03-28

Initial project scaffold and design.

### Added

- Project scaffold from `@cyanheads/mcp-ts-core` framework
- Design document (`docs/design.md`) covering tool surface, resource design, security model, service architecture, and implementation plan
- Agent protocol (`CLAUDE.md`) with server-specific conventions, MCP surface reference, security model, and configuration
- Server metadata (`server.json`) with stdio and streamable-http transport configurations
- Directory structure documentation (`docs/tree.md`)
- Server configuration schema with `CALC_MAX_EXPRESSION_LENGTH` and `CALC_EVALUATION_TIMEOUT_MS` env vars
- CI scaffolding: Dockerfile, `.env.example`, Biome config, Vitest config, devcheck config
- GitHub issue templates (bug report, feature request)
