# Changelog

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
