# Changelog

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
