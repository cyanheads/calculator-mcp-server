# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.25](changelog/0.1.x/0.1.25.md) — 2026-05-28

@cyanheads/mcp-ts-core ^0.9.6 → ^0.9.13: HTTP 413 body cap, session-init gate, quieter 401/403/400/404 logs, GET /mcp keywords; MCPB placeholder stripping in server config

## [0.1.24](changelog/0.1.x/0.1.24.md) — 2026-05-23

Framework `@cyanheads/mcp-ts-core` `^0.9.4 → ^0.9.6`. Skills synced: maintenance (2.3 → 2.4), polish-docs-meta (2.0 → 2.2), release-and-publish (2.4 → 2.5). lint:packaging updated.

## [0.1.23](changelog/0.1.x/0.1.23.md) — 2026-05-22

Framework `@cyanheads/mcp-ts-core` `^0.9.1 → ^0.9.4`. Explicit `zod` dep (peerDep change in 0.9.2). New scripts: `audit:refresh`, `list-skills`, `lint:packaging`, `bundle`, `changelog:build`, `changelog:check`. TypeScript exhaustiveness fix in `calculate.tool.ts`.

## [0.1.22](changelog/0.1.x/0.1.22.md) — 2026-05-16

Framework bump `@cyanheads/mcp-ts-core` 0.8.15 → 0.9.1. Adopt the new `instructions` field on `createApp()` — server-level orientation now flows to every `initialize` response. Engines: Node ≥24.0.0, Bun ≥1.3.0. CHANGELOG.md migrated to per-version files under `changelog/0.1.x/`.

## [0.1.21](changelog/0.1.x/0.1.21.md) — 2026-05-05

Framework bump `@cyanheads/mcp-ts-core` 0.8.5 → 0.8.15. Reclassify `evaluation_timeout` from `ServiceUnavailable` (-32000) to `Timeout` (-32004) — vm sandbox abort is a timeout primitive, not an upstream availability problem. `retryable: false` unchanged.

## [0.1.20](changelog/0.1.x/0.1.20.md) — 2026-04-29

Framework bump `@cyanheads/mcp-ts-core` 0.8.3 → 0.8.5. Adopt the new typed `recovery` field on all 10 `calculate` error contract entries — actionable hints now flow to `structuredContent.error.data.recovery.hint` and mirror into `content[0].text`.

## [0.1.19](changelog/0.1.x/0.1.19.md) — 2026-04-29

Fix the `view source ↗` link for `calculator://help` on the HTTP landing page — set `sourceUrl` explicitly on the resource definition (URI-shaped names break the framework's auto-derivation).

## [0.1.18](changelog/0.1.x/0.1.18.md) — 2026-04-29

Framework bump `@cyanheads/mcp-ts-core` 0.8.0 → 0.8.3. Opt-in to landing-page `repoRoot` config (status-strip GitHub link, auto-derived per-tool `sourceUrl`, tagline). No runtime API changes for `calculate` callers.

## [0.1.17](changelog/0.1.x/0.1.17.md) — 2026-04-28

Natural-language ergonomics: `calculate` now accepts `average`/`avg` aliases for `mean`, and `mph`, `knot`, `lightyear` units (with plurals and standard abbreviations). Closes #5, #6.

## [0.1.16](changelog/0.1.x/0.1.16.md) — 2026-04-28

Adopt framework 0.8.0 typed error contract on `calculate`. Reclassify input-validation failures from `InvalidParams` (-32602) to `ValidationError` (-32007). 10 contract reasons declared. Wire-shape conformance test suite. Closes #3, #4.

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-04-28

Patch release: framework `0.7.6 → 0.8.0` bump, agent protocol Errors section rewritten to lead with the new typed error contract pattern, and three external skills resynced from the framework.

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-04-27

Patch release surfacing two field-test findings in the `calculate` tool: numeric results no longer flip into scientific notation at math.js's default `exp ≥ 5` threshold, and the schema descriptions stop naming a specific consumer.

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-04-27

Patch release: framework `0.7.5 → 0.7.6` bump, [#2](https://github.com/cyanheads/calculator-mcp-server/issues/2) fix lifting the single-expression contract into the `calculate` tool's published JSON Schema, and adoption of the framework template's new `start` script.

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-04-27

Framework patch-series bump and a small `MathService` cleanup.

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-04-24

Framework bump to `@cyanheads/mcp-ts-core` 0.7.0, handler simplification, and skill sync.

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-04-20

Framework bump to `@cyanheads/mcp-ts-core` 0.5.3, `parseEnvConfig` adoption, and skill sync.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-04-14

Dependency refresh, form-client input normalization, and metadata updates.

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-03-30

Package metadata and dev dependency updates.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-03-30

Public hosted instance and distribution metadata.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-03-30

Security hardening: scope sanitization, result type/size validation, newline separator blocking, and prototype pollution prevention.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-03-30

Trigonometric simplification rules and stricter non-finite result handling.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-03-30

Dependency update, input validation tightening, and error message improvements.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-03-29

Input validation hardening, resource listing support, and documentation updates.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-03-28

Core calculator implementation — replaces scaffold echo tool with full math evaluation surface.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-03-28

Package metadata, documentation, and agent protocol polish.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-03-28

Initial project scaffold and design.
