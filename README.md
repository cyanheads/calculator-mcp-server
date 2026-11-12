<div align="center">
  <h1>@cyanheads/calculator-mcp-server</h1>
  <p><b>Evaluate, simplify, and differentiate mathematical expressions via MCP. STDIO or Streamable HTTP.</b>
  <div>1 Tool • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/calculator-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/calculator-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/calculator-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/calculator-mcp-server/releases/latest/download/calculator-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=calculator-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2FsY3VsYXRvci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22calculator-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcalculator-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://calculator.caseyjhand.com/mcp](https://calculator.caseyjhand.com/mcp)

</div>

---

## Overview

Calculator powered by math.js. Verify numeric results, simplify algebraic expressions, and compute symbolic derivatives through one tool.

### Tools

| Tool | Description |
|:----------|:------------|
| `calculate` | Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives. |

### Resources

| Resource | Description |
|:------------|:------------|
| `calculator://help` | Available functions, operators, constants, and syntax reference. |

## Capability reference

### `calculate` <sub>tool</sub>

- One `expression` per call, up to 4,000 characters by default. `operation` selects `evaluate` (default), `simplify`, or `derivative` (requires `variable`, e.g. `"x"`); `scope` assigns numeric variables (`{ "x": 5 }`) and `precision` sets 1–16 significant digits, both for `evaluate` only.
- Covers arithmetic, trigonometry, logarithms, statistics, matrices and linear systems (`lusolve`), polynomial roots (`polynomialRoot`), complex numbers, units, combinatorics, dates as quoted `YYYY-MM-DD` strings (`dateDiff`, `dateAdd`, `weekday`, `isoWeek`, `daysInMonth`), and numeric definite integrals (`integrate(f, x, a, b)`). Accepts `**`, `×`, `÷`, `−`, and `°` (`°C`, `°F`) as math.js operators in every operation; `×` and `**` take scalar operands.
- `numericType` selects `number`, `BigNumber` (64 significant digits, for values that overflow a 64-bit float), or `Fraction` (exact rationals, including integer combinatorics and rational roots: `5!` → `120/1`). Fraction mode returns `fraction_unsupported` when a result has no exact rational value (`sqrt(2)`, `2^(1/2)`), the expression calls a function Fraction mode cannot compute (`log2(8)`, `stirlingS2(5, 2)`), or it uses a value Fraction mode holds only as a rounded float (`pi`, `random()`).
- Returns the result string, result type, original expression, and operation; `simplify` sets `unchanged: true` when it cannot reduce the expression (it does no polynomial factoring or rational cancellation). Failures carry a typed `reason` and a recovery hint.

---

### `calculator://help` <sub>resource</sub>

- Markdown reference for functions, operators, constants, units, limits, and expression syntax; no parameters.
- Worked examples cover scope, matrices, polynomial roots, dates, integrals, complex numbers, precision, each `numericType`, and all three operations.
- Cacheable for 24 hours with public scope (`cacheHint`) — static content that never changes at runtime.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Calculator-specific:

- Hardened math.js v15 instance — dangerous functions disabled, evaluation run under a `vm` timeout
- No auth required — all operations are read-only and stateless, and nothing reads a clock (`now()` and `today()` are rejected; pass dates as strings)
- Input validation: expression length limits and rejection of multiple statements; matrix row separators and string contents remain valid; nesting past the call stack fails with `expression_too_deep`
- Result validation: blocked result types (functions, parsers, result sets), configurable max result size
- Size limits: functions that build a matrix, range, or string from a size, product, broadcast, index, or precision argument are capped per call, `stirlingS2`, `bellNumbers`, and `bernoulli` bound their arguments, and each evaluation has a total element budget; oversized requests fail fast with `result_too_large`. `integrate()` uses at most 500 subintervals per call
- Scope sanitization: numeric-only values, prototype pollution prevention (blocked `__proto__`, `constructor`, etc.)

Agent-friendly output:

- Effective-call echo — every response echoes the expression and operation, plus which scope variables and what precision were applied, so agents can verify what was actually computed
- Discriminated output contracts — `unchanged: true` on `simplify` flags a no-op result instead of silently returning the same expression
- Typed error reasons — validation and evaluation failures carry a typed `reason` (e.g. `fraction_unsupported`, `evaluation_timeout`, `disallowed_result_type`) plus an actionable recovery hint, rather than a raw exception

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http calculator-mcp-server https://calculator.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add calculator-mcp-server -- npx -y @cyanheads/calculator-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "calculator-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/calculator-mcp-server"]
    }
  }
}
```

For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CALC_MAX_EXPRESSION_LENGTH` | Maximum allowed expression string length (10–10,000). | `4000` |
| `CALC_EVALUATION_TIMEOUT_MS` | Maximum evaluation time in milliseconds (100–30,000). | `5000` |
| `CALC_MAX_RESULT_LENGTH` | Maximum result string length in characters (1,000–1,000,000). | `100000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | Hostname for the HTTP server. | `127.0.0.1` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | Path for the HTTP MCP endpoint. | `/mcp` |
| `MCP_HTTP_MAX_BODY_BYTES` | Maximum inbound HTTP request size; `0` disables the limit. | `1048576` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | `auto`, `stateful`, or `stateless`. The server declares `stateless` in code, so every launch path resolves the same way; setting this overrides that declaration. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |

See [`.env.example`](./.env.example) for optional session, resumability, logging, and telemetry settings.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher. The built server also runs on Node.js v24+.

- **Clone and install:**
  ```sh
  git clone https://github.com/cyanheads/calculator-mcp-server.git
  cd calculator-mcp-server && bun install
  cp .env.example .env
  ```

- **Build and run the production version:**
  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/calculator-mcp-server:latest
```

The image defaults to Streamable HTTP on port `3010`, stateless sessions, and logs at `/var/log/calculator-mcp-server`. For stdio, use `docker run -i --rm -e MCP_TRANSPORT_TYPE=stdio ghcr.io/cyanheads/calculator-mcp-server:latest`. To build locally, run `docker build -t calculator-mcp-server .`; OpenTelemetry dependencies are installed by default, and `--build-arg OTEL_ENABLED=false` omits them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/` | Resource definitions (`*.resource.ts`). |
| `src/services/` | Domain service integrations (MathService). |
| `src/config/` | Environment variable parsing and validation with Zod. |
| `docs/` | Generated directory tree. |
| `tests/` | Calculation, configuration, and response-contract tests. |

## Development guide

See [`AGENTS.md`](./AGENTS.md) or [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging
- Register new tools and resources in `src/index.ts`

## Contributing

Issues are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
