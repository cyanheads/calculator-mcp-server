# Agent Protocol

**Server:** calculator-mcp-server
**Version:** 0.3.2
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.21`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` 1.29.0
**Zod:** 4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

A publicly-hosted calculator MCP server that lets any LLM verify mathematical computations. Powered by [math.js](https://mathjs.org/) v15. No auth required — all operations are read-only and stateless.

### MCP Surface

| Primitive | Name | Purpose |
|:----------|:-----|:--------|
| Tool | `calculate` | Evaluate, simplify, or differentiate math expressions. Single tool — `operation` param defaults to `evaluate`. |
| Resource | `calculator://help` | Static reference of available functions, operators, constants, and syntax. |

### Security Model

MathService wraps a **hardened math.js instance** — dangerous functions (`import`, `createUnit`, `evaluate`, `parse`, `compile`, `chain`, `config`, `resolve`, `reviver`, `parser`) are disabled in the expression scope. `simplify` and `derivative` are also disabled in expressions but called programmatically by the tool handler. Evaluation runs inside `vm.runInNewContext()` with a timeout. Input length is capped. Expression separators (semicolons and newlines) are rejected — single expression per call only (the separator scan is string-literal-aware so `;` inside `"..."` is not treated as a statement break). Variable scope accepts `z.record(z.number())` only with prototype-polluting keys blocked. Result types are validated (functions, parsers, and result sets rejected). `.toString()` / `.toLocaleString()` access on any value is rejected at parse time via an AST check — these method calls on function-valued identifiers would otherwise bypass the result-type guard by returning source as a plain string. Result size is capped via `CALC_MAX_RESULT_LENGTH`. The math.js `version` constant is redacted to prevent fingerprinting.

---


## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps (injection, blast radius, input sinks, tenant isolation)
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `release-and-publish` skill** — publish to npm + MCP Registry + GHCR after wrapup
11. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getMathService } from '@/services/math/math-service.js';
import { getServerConfig } from '@/config/server-config.js';

export const calculateTool = tool('calculate', {
  description: 'Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    expression: z.string()
      .describe('Mathematical expression to evaluate (e.g., "2 + 3 * 4", "sin(pi/4)", "5 kg to lbs").'),
    operation: z.enum(['evaluate', 'simplify', 'derivative']).default('evaluate')
      .describe('Operation: "evaluate" (default), "simplify", or "derivative".'),
    variable: z.string().optional()
      .describe('Variable for differentiation. Required when operation is "derivative".'),
    scope: z.record(z.number()).optional()
      .describe('Variable assignments. Example: { "x": 5, "y": 3 }.'),
    precision: z.number().int().min(1).max(16).optional()
      .describe('Significant digits for numeric results. Ignored for symbolic operations.'),
  }),
  output: z.object({
    result: z.string().describe('Computed result as a string.'),
    resultType: z.string().describe('Type: number, BigNumber, Complex, DenseMatrix, Unit, string, boolean.'),
    expression: z.string().describe('Original expression as received.'),
  }),

  handler(input, ctx) {
    const config = getServerConfig();
    const math = getMathService();
    // Dispatch based on operation mode — see design doc for full error table
    const result = math.evaluate(input.expression, input.scope);
    ctx.log.info('Evaluated expression', { expression: input.expression });
    return { result: String(result), resultType: typeof result, expression: input.expression };
  },

  format: (output) => [{
    type: 'text',
    text: `**Expression:** \`${output.expression}\`\n**Result:** ${output.result}\n**Type:** ${output.resultType}`,
  }],
});
```

### Resource

```ts
import { resource } from '@cyanheads/mcp-ts-core';
import { getMathService } from '@/services/math/math-service.js';

export const helpResource = resource('calculator://help', {
  description: 'Available functions, operators, constants, and syntax reference.',
  handler() {
    const math = getMathService();
    return math.getHelpContent();
  },
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
const ServerConfigSchema = z.object({
  maxExpressionLength: z.coerce.number().int().min(10).max(10_000).default(1000)
    .describe('Maximum allowed expression string length (10–10,000)'),
  evaluationTimeoutMs: z.coerce.number().int().min(100).max(30_000).default(5000)
    .describe('Maximum evaluation time in milliseconds (100–30,000)'),
  maxResultLength: z.coerce.number().int().min(1_000).max(1_000_000).default(100_000)
    .describe('Maximum result string length in characters (1,000–1,000,000)'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= ServerConfigSchema.parse({
    maxExpressionLength: process.env.CALC_MAX_EXPRESSION_LENGTH,
    evaluationTimeoutMs: process.env.CALC_EVALUATION_TIMEOUT_MS,
    maxResultLength: process.env.CALC_MAX_RESULT_LENGTH,
  });
  return _config;
}
```

| Env Var | Default | Description |
|:--------|:--------|:------------|
| `CALC_MAX_EXPRESSION_LENGTH` | `1000` | Max input string length |
| `CALC_EVALUATION_TIMEOUT_MS` | `5000` | Evaluation timeout in ms |
| `CALC_MAX_RESULT_LENGTH` | `100000` | Max result string length |

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.enrich` | Success-path enrichment — `.notice(text)`, `.total(n)`, `.echo(query)`, `.delta({ field, before, after })`. Merges into `structuredContent` and `content[]` trailer automatically. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire payload's `data.recovery.hint` (which the framework mirrors into `content[]` text), pass it explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

On the wire, tool errors mirror the success-path `format-parity` invariant — both `content[]` (markdown, read by clients like Claude Desktop) and `structuredContent.error` (JSON `{ code, message, data? }`, read by clients like Claude Code) carry the same payload, with `data.recovery.hint` mirrored into the markdown text when present.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture (input, output, errors, handler, format). Don't extract a shared `errors[]` constant or contract module to deduplicate; per-tool repetition is the intended cost of locality, and dynamic `recovery` hints often need tool-specific context anyway.

**Fallback (no contract entry fits, prototype tools, service-layer code):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code, concise
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Available factories: `invalidParams`, `invalidRequest`, `notFound`, `forbidden`, `unauthorized`, `validationError`, `conflict`, `rateLimited`, `timeout`, `serviceUnavailable`, `configurationError`, `internalError`, `serializationError`, `databaseError`. For HTTP responses from upstream APIs, use `httpErrorFromResponse(response, { service, data })` from `/utils`.

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table and contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    [domain]/
      [domain]-service.ts               # Domain service (init/accessor pattern)
      types.ts                          # Domain types
  mcp-server/
    tools/definitions/
      [tool-name].tool.ts               # Tool definitions
    resources/definitions/
      [resource-name].resource.ts       # Resource definitions
    prompts/definitions/
      [prompt-name].prompt.ts           # Prompt definitions
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `code-simplifier` | Post-session code review and cleanup against `git diff` — modernize syntax, consolidate duplication, align with codebase |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `devcheck` | Lint, format, typecheck, audit |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent SQLite-backed local mirror of bulk upstream datasets — Tier 3 opt-in, Node/Bun only |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run list-skills` | Print skill index from `skills/` frontmatter |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run lint:mcp` | Validate MCP definitions |
| `bun run lint:packaging` | Validate env var alignment between `manifest.json` and `server.json` |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run release:github` | Create GitHub Release with tag subject as title, attach `.mcpb` bundle if present |
| `bun run test` | Run tests |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` to skip; `lint:packaging` skips cleanly when `manifest.json` is absent.

**Adding an env var requires both files:** `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

After git wrapup (version bumps, changelog, commit, annotated tag) is complete, run the **`release-and-publish`** skill — it handles the full publish flow with retry-on-transient-failure across every registry.

### Wrapup flow

When running the git wrapup checklist (`polish-docs-meta` or equivalent):

- **Minimum version bump is `0.0.1` (patch)** unless the user specifies a larger bump.
- After the final commit, **create an annotated tag** and **push** (tags included):

```bash
git tag -a v<version> -m "v<version>"
git push && git push --tags
```

### Targets

This server publishes to:

1. **npm** — `bun publish --access public`
2. **GitHub Release** — `.mcpb` bundle attached via `gh release create --verify-tag --notes-from-tag dist/*.mcpb` (powers the Claude Desktop install badge)
3. **GHCR** — multi-arch Docker image:

   ```bash
   docker buildx build --platform linux/amd64,linux/arm64 \
     -t ghcr.io/cyanheads/calculator-mcp-server:<version> \
     -t ghcr.io/cyanheads/calculator-mcp-server:latest \
     --push .
   ```

The `release-and-publish` skill drives all three — don't run the commands manually unless the skill halts.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMathService } from '@/services/math/math-service.js';
import { getServerConfig } from '@/config/server-config.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
