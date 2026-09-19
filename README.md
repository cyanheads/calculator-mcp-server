<div align="center">
  <h1>@cyanheads/calculator-mcp-server</h1>
  <p><b>Evaluate, simplify, and differentiate mathematical expressions via MCP. STDIO or Streamable HTTP.</b>
  <div>1 Tool • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/calculator-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/calculator-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/calculator-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Calculator powered by math.js. Verify numeric results, simplify algebraic expressions, and compute symbolic derivatives through one tool. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

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

- One `expression` per call. `operation` selects `evaluate` (default), `simplify`, or `derivative`; derivatives require `variable` (e.g. `"x"`).
- Evaluate arithmetic, trigonometry, logarithms, statistics, matrices, complex numbers, units, and combinatorics; assign numeric variables through `scope`, e.g. `{ "x": 5 }`.
- `numericType` selects `number`, `BigNumber`, or `Fraction`. Fractions require exact rational results; irrational or transcendental results return `fraction_unsupported` with guidance to change numeric type.
- `precision` sets 1–16 significant digits for numeric results. Blank optional `variable` and `precision` values are treated as omitted; scope and precision do not affect symbolic operations.
- Simplification includes algebraic and trigonometric identities (`2x + 3x` → `5 * x`); `unchanged: true` identifies expressions the simplifier cannot reduce, including polynomial factoring and rational cancellation cases.
- Returns the result string, result type, original expression, and operation. Validation failures include typed reasons and recovery hints.

---

### `calculator://help` <sub>resource</sub>

- Markdown reference for functions, operators, constants, units, and expression syntax; no parameters.
- Examples cover scope, matrices, complex numbers, precision, and all three operations.
- Cacheable for 24 hours with public scope (`cacheHint`) — static content that never changes at runtime.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Calculator-specific:

- Hardened math.js v15 instance — dangerous functions disabled, evaluation sandboxed via `vm.runInNewContext()` with timeout
- No auth required — all operations are read-only and stateless
- Input validation: expression length limits and rejection of multiple statements; matrix row separators and string contents remain valid
- Result validation: blocked result types (functions, parsers, result sets), configurable max result size
- Scope sanitization: numeric-only values, prototype pollution prevention (blocked `__proto__`, `constructor`, etc.)

Agent-friendly output:

- Effective-call echo — every response echoes the expression and operation, plus which scope variables and what precision were applied, so agents can verify what was actually computed
- Discriminated output contracts — `unchanged: true` on `simplify` flags a no-op result instead of silently returning the same expression
- Typed error reasons — validation and evaluation failures carry a typed `reason` (e.g. `fraction_unsupported`, `evaluation_timeout`, `disallowed_result_type`) plus an actionable recovery hint, rather than a raw exception

## Getting started

### Public Hosted Instance

A public instance is available at `https://calculator.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "calculator-mcp-server": {
      "type": "streamable-http",
      "url": "https://calculator.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add one of the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "calculator-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/calculator-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "calculator-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/calculator-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "calculator-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/calculator-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the built server:

```sh
MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/calculator-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd calculator-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CALC_MAX_EXPRESSION_LENGTH` | Maximum allowed expression string length (10–10,000). | `1000` |
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
docker build -t calculator-mcp-server .
docker run -p 3010:3010 calculator-mcp-server
```

The image defaults to Streamable HTTP on port `3010`, stateless sessions, and logs at `/var/log/calculator-mcp-server`. OpenTelemetry dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

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
