<div align="center">
  <h1>@cyanheads/calculator-mcp-server</h1>
  <p><b>A calculator MCP server that lets any LLM verify mathematical computations. Evaluate, simplify, and differentiate expressions via a single tool. Powered by math.js v15.</b></p>
  <p><b>1 Tool · 1 Resource</b></p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.28.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-6.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

## Tools

One tool for all mathematical operations:

| Tool Name | Description |
|:----------|:------------|
| `calculate` | Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives. |

### `calculate`

A single tool covering 100% of the server's purpose. The `operation` parameter defaults to `evaluate`, so the common case is just `{ expression: "..." }`.

- **Evaluate** — arithmetic, trigonometry, logarithms, statistics, matrices, complex numbers, unit conversion, combinatorics
- **Simplify** — reduce algebraic expressions symbolically (e.g., `2x + 3x` -> `5 * x`). Supports algebraic and trigonometric identities
- **Derivative** — compute symbolic derivatives (e.g., `3x^2 + 2x + 1` -> `6 * x + 2`)
- Variable scope via `scope` parameter: `{ "x": 5, "y": 3 }`
- Configurable precision for numeric results

---

## Resources

| URI Pattern | Description |
|:------------|:------------|
| `calculator://help` | Available functions, operators, constants, and syntax reference. |

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or in Docker

Calculator-specific:

- Hardened math.js v15 instance — dangerous functions disabled, evaluation sandboxed via `vm.runInNewContext()` with timeout
- No auth required — all operations are read-only and stateless
- Input validation: expression length limits, expression separator rejection (semicolons and newlines), variable name regex enforcement
- Result validation: blocked result types (functions, parsers, result sets), configurable max result size
- Scope sanitization: numeric-only values, prototype pollution prevention (blocked `__proto__`, `constructor`, etc.)

---

## Getting Started

### MCP Client Configuration

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "calculator": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/calculator-mcp-server@latest"]
    }
  }
}
```

### Prerequisites

- [Bun v1.2.0](https://bun.sh/) or higher

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

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CALC_MAX_EXPRESSION_LENGTH` | Maximum allowed expression string length (10–10,000). | `1000` |
| `CALC_EVALUATION_TIMEOUT_MS` | Maximum evaluation time in milliseconds (100–30,000). | `5000` |
| `CALC_MAX_RESULT_LENGTH` | Maximum result string length in characters (1,000–1,000,000). | `100000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |

---

## Running the Server

### Local Development

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

---

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/` | Resource definitions (`*.resource.ts`). |
| `src/services/` | Domain service integrations (MathService). |
| `src/config/` | Environment variable parsing and validation with Zod. |
| `docs/` | Generated directory tree. |

---

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging
- Register new tools and resources in `src/index.ts`

---

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
