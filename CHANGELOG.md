# Changelog

## 0.1.20 — 2026-04-29

Patch release: framework bump `@cyanheads/mcp-ts-core` `0.8.3 → 0.8.5` and adopt the new typed `recovery` field on every entry of the `calculate` error contract. Each declared failure mode now carries an actionable hint that flows to the wire on `result.structuredContent.error.data.recovery.hint` and is mirrored into `result.content[0].text` as `Recovery: <hint>` — agents recovering from a `validationError` no longer have to infer the next move from the message alone.

### Changed

- **`calculate` typed error contract** (`src/mcp-server/tools/definitions/calculate.tool.ts`) — added the required `recovery` field to all 10 entries (`empty_expression`, `expression_too_long`, `multiple_expressions`, `reserved_scope_key`, `disallowed_result_type`, `result_too_large`, `undefined_result`, `parse_failed`, `derivative_missing_variable`, `evaluation_timeout`). The 0.8.5 framework lints `recovery` for length and presence on every contract entry.
- **`MathService` recovery plumbing** (`src/services/math/math-service.ts`) — `evaluateExpression`, `simplifyExpression`, `differentiateExpression`, `validateInput`, `validateScope`, `validateResultType`, `validateResultSize`, and `runWithTimeout` now accept the request `Context` and spread `ctx.recoveryFor('reason')` into the `data` object on every service-thrown `validationError` / `serviceUnavailable`. The `derivative_missing_variable` `ctx.fail` site in the tool handler does the same. Test helpers updated to pass `mockCtx()` to the two direct service-layer calls in the wire-shape suite.

### Meta

- Bumped `@cyanheads/mcp-ts-core` to `0.8.5`.
- Synced project skills from the package: `add-service` (1.4 → 1.5), `add-tool` (2.0 → 2.4), `api-context` (1.1 → 1.2), `api-errors` (1.1 → 1.4), `design-mcp-server` (2.7 → 2.8). Refreshed `.claude/skills/` and `.agents/skills/` from `skills/`.
- Field-tested the live HTTP transport: happy paths (`evaluate`, `simplify`, `derivative`, `60 mph to m/s`, `average([...])`), `calculator://help` resource read, missing-required-arg Zod reject, and 5 contract-error reasons (`undefined_result`, `derivative_missing_variable`, `multiple_expressions`, `parse_failed`, `reserved_scope_key`). Verified `data.recovery.hint` populated on every error and mirrored into `content[0].text`. All 42 unit tests pass; devcheck clean.
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.20`.

## 0.1.19 — 2026-04-29

Patch release: fix the `view source ↗` link for the `calculator://help` resource on the HTTP landing page. The framework's auto-derivation builds the path from the definition name via `kebab-mirror`, which doesn't match URI-shaped resource names like `calculator://help` — the established override path is `sourceUrl` on the definition itself ([cyanheads/mcp-ts-core#42](https://github.com/cyanheads/mcp-ts-core/issues/42)), already adopted in `pubmed-mcp-server` on every tool. Calculator now does the same on the help resource.

### Fixed

- **`helpResource.sourceUrl`** (`src/mcp-server/resources/definitions/help.resource.ts`) — set explicitly to `https://github.com/cyanheads/calculator-mcp-server/blob/main/src/mcp-server/resources/definitions/help.resource.ts`. Replaces the framework auto-derived `.../calculator help.resource.ts` (URI host + path joined with a space) that 404'd on GitHub.

### Meta

- Closed [cyanheads/mcp-ts-core#86](https://github.com/cyanheads/mcp-ts-core/issues/86) as duplicate of [#42](https://github.com/cyanheads/mcp-ts-core/issues/42) — the override is the intended pattern, not a framework bug. The 0.1.18 CHANGELOG note mentioning #86 as a framework bug is superseded; treat that line as historical context rather than a current-state reference.
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.19`.

## 0.1.18 — 2026-04-29

Patch release: framework bump `@cyanheads/mcp-ts-core` `0.8.0 → 0.8.3` plus opt-in to the new HTTP landing-page `repoRoot` config. No runtime API changes for callers of the `calculate` tool — its typed `errors[]` contract continues to surface via `result.structuredContent.error.{code, message, data.reason}` (now the canonical wire location after the framework's 0.8.3 error-shape cleanup).

### Changed

- **`createApp()` landing config** (`src/index.ts`) — declares `landing.repoRoot` (`https://github.com/cyanheads/calculator-mcp-server`) and a `tagline`. Activates the 0.8.2 status-strip GitHub link, auto-derives per-tool `sourceUrl` and the default `changelogUrl`, and sets the public-facing tagline on the HTTP landing page at [calculator.caseyjhand.com](https://calculator.caseyjhand.com/).
- **Agent protocol files** (`CLAUDE.md`, `AGENTS.md`) — Errors section: removed the stale "advertise the failure surface in `tools/list` (under `_meta['mcp-ts-core/errors']`)" claim. The 0.8.3 release dropped that wire publication; contract-based ergonomics (typed `ctx.fail`, conformance lint) are unaffected. Added the error-path parity paragraph (`content[]` ↔ `structuredContent.error`). Refreshed the `format()` checklist line to match the structuredContent/content[] dual-surface invariant.

### Meta

- Bumped `@cyanheads/mcp-ts-core` to `0.8.3`. Field-tested the `calculate` tool against the live HTTP transport: happy path (evaluate, simplify, derivative), structured/text parity, and two contract reasons (`derivative_missing_variable` via `ctx.fail`, `undefined_result` via service-thrown `validationError`). All 42 unit tests pass.
- Synced project skills from the package: `add-service` (1.3 → 1.4), `add-tool` (1.8 → 2.0), `api-errors` (1.0 → 1.1), `field-test` (2.0 → 2.2), `maintenance` (1.8 → 2.0). Refreshed `.claude/skills/` and `.agents/skills/` from `skills/`.
- Filed [cyanheads/mcp-ts-core#86](https://github.com/cyanheads/mcp-ts-core/issues/86) — landing-page resource `sourceUrl` derivation embeds the URI host into the filename (e.g. `calculator help.resource.ts`), producing a 404 link. Tool source URLs are unaffected.
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.18`.

## 0.1.17 — 2026-04-28

Patch release: natural-language ergonomics — the `calculate` tool now accepts `average`/`avg` as aliases for `mean`, and the `mph`, `knot`, and `lightyear` units (with their plurals and standard abbreviations). Closes [#5](https://github.com/cyanheads/calculator-mcp-server/issues/5) and [#6](https://github.com/cyanheads/calculator-mcp-server/issues/6).

### Added

- **Function aliases** — `average` and `avg` registered as aliases for `mean` via `math.import()` in `MathService` constructor (`src/services/math/math-service.ts`). Both resolve to the same typed function as `mean`. Closes [#5](https://github.com/cyanheads/calculator-mcp-server/issues/5).
- **Custom units** — `mph` (= `1 mile/hour`), `knot` (= `1852 m/hour`, with aliases `knots`, `kt`, `kts`), and `lightyear` (= `9460730472580800 m`, with aliases `lightyears`, `ly`) registered via `math.createUnit()` in the constructor before the disabling step clobbers `createUnit` in the expression scope. Definitions use exact SI-derived values. Closes [#6](https://github.com/cyanheads/calculator-mcp-server/issues/6).
- **5 wire-shape tests** for the new aliases and units in `tests/mcp-server/tools/definitions/calculate.tool.test.ts` covering `average`/`avg` evaluation and `60 mph → m/s`, `1 lightyear → km`, `10 knots → m/s` conversions.

### Changed

- **Help resource** (`calculator://help`) — Statistics line now reads `mean (aliases: average, avg)`; Common units line now includes `lightyear (ly)`, `mph`, `knot (kt)`. Discovery surface stays in sync with the registered surface.

### Meta

- Bumped package, server metadata, README badge, and agent protocol files to `0.1.17`.
- [#7](https://github.com/cyanheads/calculator-mcp-server/issues/7) (intermediate overflow on factorial ratios) — left open with a [rejection comment](https://github.com/cyanheads/calculator-mcp-server/issues/7#issuecomment-4339684505) on the proposed BigNumber-as-default fix and a counter-proposal for an opt-in `numericType` tool parameter.

## 0.1.16 — 2026-04-28

Patch release: adopt the framework `0.8.0` typed error contract on the `calculate` tool and reclassify input-validation failures from JSON-RPC `InvalidParams` (`-32602`) to the framework's purpose-built `ValidationError` (`-32007`). Closes [#3](https://github.com/cyanheads/calculator-mcp-server/issues/3) and [#4](https://github.com/cyanheads/calculator-mcp-server/issues/4).

### Changed

- **`calculate` error codes** — swapped 8 `invalidParams` (`-32602`) throws to `validationError` (`-32007`) across `src/services/math/math-service.ts` (7 sites) and `src/mcp-server/tools/definitions/calculate.tool.ts` (1 site). `serviceUnavailable` on evaluation timeout retained. Observability dashboards keyed on `mcp_error_classified_code` will now group these under `Client: Validation` instead of the unmapped JSON-RPC bucket. Closes [#3](https://github.com/cyanheads/calculator-mcp-server/issues/3).
- **`calculate` typed error contract** — declared all 10 failure modes as `errors: [{ reason, code, when, retryable? }]` on the tool definition; published in `tools/list` under `_meta['mcp-ts-core/errors']`. Reasons: `empty_expression`, `expression_too_long`, `multiple_expressions`, `reserved_scope_key`, `disallowed_result_type`, `result_too_large`, `undefined_result`, `parse_failed`, `derivative_missing_variable`, `evaluation_timeout` (`ServiceUnavailable`, `retryable: false`). The handler-side cross-field check now routes through `ctx.fail('derivative_missing_variable', …)`; service throws carry `data: { reason }` so the framework's auto-classifier preserves a stable identifier on the wire. Closes [#4](https://github.com/cyanheads/calculator-mcp-server/issues/4).

### Added

- **Wire-shape conformance test suite** (`tests/mcp-server/tools/definitions/calculate.tool.test.ts`) — one test per contract reason (10 total) asserting the thrown `McpError`'s `code` and `data.reason` match the contract entry. Compensates for the framework lint's blind spot on service-thrown reasons. `result_too_large` and `evaluation_timeout` use a directly-constructed `MathService` with shrunken config (5-char limit / 1ms timeout) since the singleton's defaults can't trigger them.

### Fixed

- **Test helper now wires `ctx.fail`** — existing `derivative` failure tests had been passing accidentally: `createMockContext()` doesn't attach `ctx.fail`, the resulting `TypeError` happened to serialize a substring `vitest.toThrow()` matched. New `mockCtx()` helper passes `errors: calculateTool.errors` so `ctx.fail` is properly available in tests.

### Meta

- Bumped package, server metadata, README badge, and agent protocol files to `0.1.16`.

## 0.1.15 — 2026-04-28

Patch release: framework `0.7.6 → 0.8.0` bump, agent protocol Errors section rewritten to lead with the new typed error contract pattern, and three external skills resynced from the framework.

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.7.6` to `^0.8.0` (minor — adds typed error contracts via `errors: [{ reason, code, when, retryable? }]` on `tool()` / `resource()` with typed `ctx.fail(reason, …)`, advertises the failure surface in `tools/list` under `_meta['mcp-ts-core/errors']`; ships `httpErrorFromResponse` and `partialResult` utilities, three new error factories (`internalError`, `serializationError`, `databaseError`), and handler-body + error-contract conformance lint rules. Fully backwards compatible).
- Agent protocol files (`CLAUDE.md` / `AGENTS.md`) — Errors section rewritten to lead with the typed error contract as the recommended path, demote factories + auto-classification to the fallback. Added `add-app-tool` to the skills table. Added a form-client safety bullet to the checklist.
- Resynced 3 external skills from the framework (`maintenance` 1.7→1.8, `report-issue-framework` 1.3→1.4, `security-pass` 1.1→1.2 — `security-pass` Axis 7 leakage check now greps `ctx.fail(` and `httpErrorFromResponse(` alongside `new McpError`).
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.15`.

### Added

- `scripts/split-changelog.ts` adopted from the framework template — supports the directory-based changelog convention used upstream. The calculator continues to use a flat `CHANGELOG.md`; the script is in place for a future migration.

## 0.1.14 — 2026-04-27

Patch release surfacing two field-test findings in the `calculate` tool: numeric results no longer flip into scientific notation at math.js's default `exp ≥ 5` threshold, and the schema descriptions stop naming a specific consumer.

### Fixed

- **`calculate` numeric formatting** — widen `math.format()` thresholds to `lowerExp: -6, upperExp: 21` (matching JS `Number.toString`) so normal-magnitude integers render as plain digits. `12345 * 6789` now returns `"83810205"` instead of `"8.3810205e+7"`; `factorial(10)` returns `"3628800"` instead of `"3.6288e+6"`. BigNumbers and very-tiny / very-large doubles still use exponential notation, and the `precision` parameter is unaffected. Implementation: `src/services/math/math-service.ts`.

### Changed

- **`calculate` schema descriptions** — drop "for form-based clients" / "Blank values from form-based clients" phrasings from `variable.anyOf[0]`, `variable`, `precision.anyOf[0]`, and `precision` `.describe()` strings. The schema no longer references a specific consumer; the empty-string compat behavior is preserved. Implementation: `src/mcp-server/tools/definitions/calculate.tool.ts`.
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.14`.

## 0.1.13 — 2026-04-27

Patch release: framework `0.7.5 → 0.7.6` bump, [#2](https://github.com/cyanheads/calculator-mcp-server/issues/2) fix lifting the single-expression contract into the `calculate` tool's published JSON Schema, and adoption of the framework template's new `start` script.

### Changed

- Tightened the `calculate` tool descriptions so the single-expression contract is visible at tool-discovery time, preempting LLM callers that batch with `;` or newlines (closes [#2](https://github.com/cyanheads/calculator-mcp-server/issues/2)). Tool-level description gains `One expression per call.`; the `expression` field describe leads with the constraint and disambiguates `;` semantics — `One mathematical expression per call — neither \`;\` nor newlines separate statements. Inside matrices, \`;\` separates rows (e.g. \`[1, 2; 3, 4]\`).` Existing runtime guard (`hasExpressionSeparator` in `math-service.ts`) unchanged — purely a discoverability improvement.
- Upgraded `@cyanheads/mcp-ts-core` from `^0.7.5` to `^0.7.6` (patch — `maintenance` skill Phase C now enumerates the installed `scripts/*.ts` directly instead of a hardcoded list, and `release-and-publish` / `setup` / `maintenance` skill prose was reworded so agents pick whichever git tooling is available rather than literal `git <cmd>` invocations)
- Resynced 3 external skills from the framework (`maintenance` 1.6→1.7, `release-and-publish` 2.1→2.2, `setup` 1.5→1.6)
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.13`

### Added

- `start` script in `package.json` (`"start": "node dist/index.js"`) — adopted from the framework template's 0.7.6 update so external MCP runners that assume the npm-canonical `start` script work out of the box. The new script defers to `.env` for transport selection (no inline `MCP_TRANSPORT_TYPE` override); existing `start:stdio` / `start:http` variants unchanged.

## 0.1.12 — 2026-04-27

Framework patch-series bump and a small `MathService` cleanup.

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.7.0` to `^0.7.5` (spans five patch releases — HTTP Origin guard now fails closed for remote browser origins (loopback-only when `MCP_ALLOWED_ORIGINS` is unset), landing-page `requireAuth` validates bearer tokens, raw caller payloads removed from default logs, opt-in `LOG_LLM_INTERACTIONS`, `vitest.config` shipped as `.mjs` to avoid Node 22.7+ type-strip failure, new `Framework Antipatterns` devcheck step, `format-parity` numeric normalization tightened to reject lossy decimal-shift transforms, `describe-on-fields` linter exempts `z.literal` union variants, `landing.connectSnippets` operator override, and Cloudflare email-rewrite defense in connect snippets)
- Renamed `MathService.sanitizeScope` to `validateScope` — function only validated and threw, never sanitized; new name and `void` return reflect actual behavior
- Resynced 5 external skills from the framework (`maintenance` 1.5→1.6, `api-linter` 1.1→1.2, plus content-only updates to `api-utils`, `design-mcp-server`, `field-test`)
- Resynced `scripts/devcheck.ts` from the framework (adds the new `Framework Antipatterns` check step)
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.12`

### Added

- `scripts/check-framework-antipatterns.ts` — pulled in alongside the updated `devcheck.ts` so the new check has a script to invoke. (Required because the `maintenance` skill's Phase C currently uses a hardcoded script list — see [cyanheads/mcp-ts-core#69](https://github.com/cyanheads/mcp-ts-core/issues/69).)

## 0.1.11 — 2026-04-24

Framework bump to `@cyanheads/mcp-ts-core` 0.7.0, handler simplification, and skill sync.

### Added

- Three new external skills from the framework: `api-linter` (rule reference), `release-and-publish` (post-wrapup publish workflow), and `security-pass` (8-axis MCP-specific audit)
- Three framework scripts newly synced into `scripts/`: `build-changelog.ts`, `check-docs-sync.ts`, `check-skills-sync.ts` (per the `maintenance` skill's new Phase C)

### Changed

- Upgraded `@cyanheads/mcp-ts-core` from `^0.5.3` to `^0.7.0` (spans 18 tags — landing page at `/`, SEP-1649 Server Card, directory-based changelog system, recursive `describe-on-fields` linter, flattened ZodError messages with structured `data.issues`, `MCP_PUBLIC_URL` TLS-proxy override, per-request HTTP close race fix, `HtmlExtractor` utility, and the new skills above)
- Upgraded `@biomejs/biome` from `^2.4.12` to `^2.4.13` (patch) and `vitest` from `^4.1.4` to `^4.1.5` (patch)
- Resynced 15 external skills to match framework 0.7.0 versions (`add-tool` 1.6→1.8, `design-mcp-server` 2.4→2.7, `field-test` 1.2→2.0, `polish-docs-meta` 1.4→1.7, `setup` 1.3→1.5, `maintenance` 1.3→1.5, and nine others)
- Resynced `scripts/devcheck.ts` and `scripts/tree.ts` from the framework (devcheck now runs Docs Sync, Skills Sync, and Changelog Sync steps)
- Simplified the `calculate` tool handler — destructured `input` once, spread `MathResult` into the return, dropped per-case block scopes; ~40% fewer lines, same 27/27 tests passing
- Agent protocol (`CLAUDE.md` / `AGENTS.md`): added `security-pass` and `release-and-publish` to the What's Next? progression, added `api-linter` / `security-pass` / `release-and-publish` to the skills table, rewrote the Publishing section to point at the `release-and-publish` skill
- `.github/ISSUE_TEMPLATE/` descriptions now use the scoped package name (`@cyanheads/calculator-mcp-server`) for consistency
- Bumped package, server metadata, README badge, and agent protocol files to `0.1.11`

### Fixed

- Added `.describe()` to each variant of the `variable` and `precision` unions in the `calculate` input schema — the 0.6.16 framework bump extended `describe-on-fields` to recurse into union options, which flagged the previously-bare `z.literal('')` and sibling variants

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
