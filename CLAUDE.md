# Agent Protocol

**Server:** calculator-mcp-server
**Version:** 0.1.19
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

A publicly-hosted calculator MCP server that lets any LLM verify mathematical computations. Powered by [math.js](https://mathjs.org/) v15. No auth required — all operations are read-only and stateless.

### MCP Surface

| Primitive | Name | Purpose |
|:----------|:-----|:--------|
| Tool | `calculate` | Evaluate, simplify, or differentiate math expressions. Single tool — `operation` param defaults to `evaluate`. |
| Resource | `calculator://help` | Static reference of available functions, operators, constants, and syntax. |

### Security Model

MathService wraps a **hardened math.js instance** — dangerous functions (`import`, `createUnit`, `evaluate`, `parse`, `compile`, `chain`, `config`, `resolve`, `reviver`, `parser`) are disabled in the expression scope. `simplify` and `derivative` are also disabled in expressions but called programmatically by the tool handler. Evaluation runs inside `vm.runInNewContext()` with a timeout. Input length is capped. Expression separators (semicolons and newlines) are rejected — single expression per call only. Variable scope accepts `z.record(z.number())` only with prototype-polluting keys blocked. Result types are validated (functions, parsers, and result sets rejected). Result size is capped via `CALC_MAX_RESULT_LENGTH`. The math.js `version` constant is redacted to prevent fingerprinting.

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
11. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

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
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

On the wire, tool errors mirror the success-path `format-parity` invariant — both `content[]` (markdown, read by clients like Claude Desktop) and `structuredContent.error` (JSON `{ code, message, data? }`, read by clients like Claude Code) carry the same payload, with `data.recovery.hint` mirrored into the markdown text when present.

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound, when: 'No item matched the query' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

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

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

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
| `devcheck` | Lint, format, typecheck, audit |
| `security-pass` | Audit handlers for MCP-specific security gaps before shipping |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `release-and-publish` | Publish to npm, MCP Registry, and GHCR after git wrapup |
| `maintenance` | Sync skills and dependencies after updates |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | MCP definition linter rules reference (every rule ID + fix) |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |
| `migrate-mcp-ts-template` | Migrate a template fork to use `@cyanheads/mcp-ts-core` as a package |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP definitions |
| `bun run test` | Run tests |
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

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
2. **GHCR** — multi-arch Docker image:

   ```bash
   docker buildx build --platform linux/amd64,linux/arm64 \
     -t ghcr.io/cyanheads/calculator-mcp-server:<version> \
     -t ghcr.io/cyanheads/calculator-mcp-server:latest \
     --push .
   ```

The `release-and-publish` skill drives both — don't run the commands manually unless the skill halts.

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
