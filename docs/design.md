# Calculator MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `calculate` | Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives. | `expression`, `operation?`, `variable?`, `scope?`, `precision?` | `readOnlyHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `calculator://help` | Available functions, operators, constants, and syntax reference. | No |

### Prompts

None. The tool description and `calculator://help` resource provide sufficient guidance.

---

## Overview

A publicly-hosted calculator MCP server that lets any LLM verify mathematical computations. LLMs are unreliable at arithmetic and math — this server provides a simple, secure interface for evaluating arbitrary mathematical expressions.

**Deployment model:**

- Open source at `github.com/cyanheads/calculator-mcp-server`
- Hosted via cloudflared tunnel on personal domain for public HTTP access
- Anyone can connect to perform calculations — no auth required

**Powered by [math.js](https://mathjs.org/) v15** — an actively maintained, TypeScript-native math library with AST-based expression parsing (no `eval`).

---

## Requirements

- Accept natural math expressions as strings (e.g., `2 + 3 * 4`, `sin(pi/4)`, `5 kg to lbs`)
- Support arithmetic, trigonometry, logarithms, statistics, matrices, complex numbers, units, combinatorics
- Symbolic operations: simplify and differentiate algebraic expressions
- Secure evaluation — hardened math.js instance with dangerous functions disabled
- Input length limits and evaluation timeout to prevent DoS
- Single tool interface — simple for any LLM to use
- Works over both stdio (local) and HTTP (public)

---

## Tool Design

### `calculate`

The single tool. Handles 100% of the server's purpose.

**Why one tool:** The user's intent is "a simple interface that accepts written equations of all kinds." One tool with an optional operation mode achieves this — the 95% case (evaluate) requires only `{ expression: "..." }`. Simplify and derivative are modes rather than separate tools because they share the same primary input and the agent thinks of them as "calculate things."

#### Input Schema

```ts
z.object({
  expression: z.string()
    .describe(
      'Mathematical expression to evaluate. Supports standard notation: '
      + 'arithmetic (+, -, *, /, ^, %), functions (sin, cos, sqrt, log, abs, round, etc.), '
      + 'constants (pi, e, phi, i), matrices ([1, 2; 3, 4]), units (5 kg to lbs), '
      + 'and variables (when scope is provided).'
    ),
  operation: z.enum(['evaluate', 'simplify', 'derivative'])
    .default('evaluate')
    .describe(
      'Operation to perform. '
      + '"evaluate" computes a numeric result (default). '
      + '"simplify" reduces an algebraic expression symbolically (e.g., "2x + 3x" → "5 * x"). Supports algebraic and trigonometric identities. '
      + '"derivative" computes the symbolic derivative (requires variable parameter).'
    ),
  variable: z.string().optional()
    .describe(
      'Variable to differentiate with respect to. Required when operation is "derivative". '
      + 'Example: "x".'
    ),
  scope: z.record(z.number()).optional()
    .describe(
      'Variable assignments for the expression. '
      + 'Example: { "x": 5, "y": 3 } makes "x + y" evaluate to 8.'
    ),
  precision: z.number().int().min(0).max(64).optional()
    .describe(
      'Number of significant digits for numeric results. Omit for full precision. Ignored for symbolic operations (simplify, derivative).'
    ),
})
```

#### Output Schema

```ts
z.object({
  result: z.string()
    .describe('The computed result as a string.'),
  resultType: z.string()
    .describe('Type of result: number, BigNumber, Complex, Matrix, Unit, string, boolean. Symbolic operations (simplify, derivative) return "string".'),
  expression: z.string()
    .describe('The original expression as received.'),
})
```

#### Format

```ts
format: (output) => [{
  type: 'text',
  text: `**Expression:** \`${output.expression}\`\n**Result:** ${output.result}\n**Type:** ${output.resultType}`,
}],
```

#### Error Design

| Origin | Example | Code | Recovery |
|:-------|:--------|:-----|:---------|
| Bad syntax | `2 + + 3` | `InvalidParams` | "Syntax error at position 4. Check for missing operands or mismatched parentheses." |
| Missing variable | derivative without `variable` | `InvalidParams` | "The 'variable' parameter is required when operation is 'derivative'." |
| Expression too long | 1001+ chars | `InvalidParams` | "Expression exceeds maximum length of 1000 characters." |
| Unknown function | `foo(5)` | `InvalidParams` | "Unknown function 'foo'. Use calculator://help to see available functions." |
| Evaluation timeout | `det(zeros(1000, 1000))` | `ServiceUnavailable` | "Expression evaluation timed out after 5 seconds. Simplify the expression or reduce matrix dimensions." |
| Dimension mismatch | `[1,2] + [1,2,3]` | `InvalidParams` | math.js error message passed through |

#### Annotations

```ts
annotations: {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
```

---

## Resource Design

### `calculator://help`

Static resource listing all available functions, operators, constants, and syntax examples. Populated from the math.js instance at server startup.

**Sections:**
- Operators (`+`, `-`, `*`, `/`, `^`, `%`, `!`)
- Constants (`pi`, `e`, `phi`, `i`, `Infinity`, `NaN`, `true`, `false`)
- Function categories: arithmetic, trigonometry, logarithmic, statistical, matrix, combinatorics, unit conversion, bitwise, logical, complex, comparison
- Syntax examples for common patterns (unit conversion, matrix notation, variable scope)

**Tool coverage:** This data is not locked behind the resource — the tool description covers the key capabilities, and any expression can be tried directly. The resource adds exhaustive discoverability for clients that support it.

---

## Services

### MathService

Wraps math.js with a hardened evaluation environment.

| Concern | Implementation |
|:--------|:---------------|
| **Initialization** | Create a restricted math.js instance via `create(all)`, then override dangerous functions (`import`, `createUnit`, `evaluate`, `parse`, `simplify`, `derivative`, `resolve`, `reviver`) |
| **evaluate(expr, scope?)** | Calls the pre-hardened `evaluate` function. Validates input length first. |
| **simplify(expr)** | Calls `math.simplify()` directly (the handler calls it, not the expression). Returns string representation. |
| **derivative(expr, variable)** | Calls `math.derivative()` directly. Returns string representation. |
| **Timeout** | Runs evaluation inside `vm.runInNewContext()` with Node's built-in `timeout` option, which interrupts synchronous execution and throws on exceed. No worker threads needed for v1. |
| **Input validation** | Max expression length enforced before any parsing. Semicolons (`;`) rejected — single expression per call only. Prevents variable assignment side effects within expression strings. |

**Hardened functions (disabled in expression scope):**

| Function | Why disabled |
|:---------|:------------|
| `import` | Can override built-in functions |
| `createUnit` | Can alter the unit system |
| `evaluate` | Recursive evaluation — arbitrary sub-expression execution |
| `parse` | AST manipulation from within expressions |
| `simplify` | Called programmatically by handler, not from expression scope |
| `derivative` | Called programmatically by handler, not from expression scope |
| `resolve` | AST manipulation |
| `reviver` | Deserialization vector |
| `compile` | Returns compiled expression with its own `.evaluate()` method |
| `chain` | Method chaining — transitive access to APIs |
| `config` | Can reconfigure the math.js instance at runtime |

**Note:** `simplify` and `derivative` are disabled *in the expression scope* but called directly by the tool handler. The handler is the only entry point — users cannot chain these functions in unexpected ways within expression strings.

### Future: Worker Pool (v1.1)

The `vm.runInNewContext` timeout provides real CPU-time protection for v1. For higher-throughput scenarios, a `worker_threads` pool adds:
- Memory limits per worker
- Parallel evaluation without blocking the main event loop
- Process-level isolation (crash containment)

---

## Config

```ts
// src/config/server-config.ts
const ServerConfigSchema = z.object({
  maxExpressionLength: z.coerce.number().default(1000)
    .describe('Maximum allowed expression string length'),
  evaluationTimeoutMs: z.coerce.number().default(5000)
    .describe('Maximum evaluation time in milliseconds'),
});
```

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CALC_MAX_EXPRESSION_LENGTH` | No | `1000` | Max input string length |
| `CALC_EVALUATION_TIMEOUT_MS` | No | `5000` | Evaluation timeout in ms |

---

## Domain Mapping

| Noun | Operations | MCP Primitive |
|:-----|:-----------|:--------------|
| Expression | evaluate, simplify, differentiate | Tool (`calculate` with `operation` mode) |
| Functions/Constants | discover, list | Resource (`calculator://help`) |
| Unit conversion | convert via expression syntax | Tool (handled within `calculate` evaluate mode) |

---

## Workflow Analysis

### Primary: Verify a calculation

```
LLM → calculate({ expression: "17 * 23" }) → { result: "391", resultType: "number" }
```

### Unit conversion

```
LLM → calculate({ expression: "5 miles to km" }) → { result: "8.04672 km", resultType: "Unit" }
```

### Algebraic simplification

```
LLM → calculate({ expression: "2x + 3x + x^2 - x^2", operation: "simplify" })
    → { result: "5 * x", resultType: "string" }
```

### Symbolic differentiation

```
LLM → calculate({ expression: "3x^2 + 2x + 1", operation: "derivative", variable: "x" })
    → { result: "6 * x + 2", resultType: "string" }
```

### With variable scope

```
LLM → calculate({ expression: "a^2 + b^2", scope: { a: 3, b: 4 } })
    → { result: "25", resultType: "number" }
```

### Statistics

```
LLM → calculate({ expression: "mean([85, 90, 78, 92, 88])" })
    → { result: "86.6", resultType: "number" }
```

### Matrix operations

```
LLM → calculate({ expression: "det([1, 2; 3, 4])" })
    → { result: "-2", resultType: "number" }
```

---

## Design Decisions

### One tool, not many

A calculator is a single concept. Splitting into `evaluate`, `simplify`, `differentiate` tools adds cognitive load with no workflow benefit — an LLM thinking "I need to check some math" should reach for exactly one tool. The `operation` parameter defaults to `evaluate`, so the 95% case is just `{ expression: "..." }`.

### math.js over alternatives

| Library | Math breadth | Security model | Maintained | Decision |
|:--------|:-------------|:---------------|:-----------|:---------|
| math.js v15 | Full (algebra, matrices, units, stats, trig, complex) | AST-based, documented hardening | Active (Feb 2026) | **Selected** |
| expr-eval | Basic arithmetic + trig | No eval, but unmaintained | Last commit 2021 | Rejected — stale |
| filtrex | Arithmetic only | Best sandbox guarantee | Oct 2024 | Rejected — too narrow |
| math-expression-evaluator | Arithmetic + trig | No security docs | Jun 2025 | Rejected — no security story |

### No auth for v1

The server is intentionally public — any LLM can connect and compute. All operations are read-only and stateless. The hardened math.js instance + input limits provide the security boundary. Auth can be layered on later if needed (the framework supports JWT/OAuth).

### Scope uses `z.record(z.number())`

Variable scope accepts only numeric values — no strings, objects, or functions can be injected. This is a deliberate security constraint that prevents scope-based attacks while covering all legitimate calculation use cases.

---

## Known Limitations

- **No symbolic integration** — math.js supports differentiation but not antiderivatives
- **No equation solving** — cannot solve `2x + 3 = 7` for x (only linear systems via `lusolve`)
- **Synchronous evaluation** — math.js evaluate is synchronous; truly malicious expressions (e.g., massive matrix allocation) may block the event loop until the timeout wrapper acts. Worker isolation (v1.1) addresses this.
- **Scope is numeric-only** — `scope` accepts `z.record(z.number())`, so complex numbers and matrices cannot be passed as scope variables. They can still be written inline in the expression (e.g., `2 + 3i`, `[1, 2; 3, 4]`).
- **Infinity and NaN pass through** — `1/0` returns `Infinity`, `0/0` returns `NaN`. These are valid math.js results, not errors.
- **No persistent state** — each calculation is independent. No session variables across calls. (Scope must be passed explicitly each time.)

---

## Implementation Order

1. **Install math.js** and add server config
2. **MathService** — hardened math.js wrapper with evaluate/simplify/derivative
3. **`calculate` tool** — the single tool definition
4. **`calculator://help` resource** — function/constant reference
5. **Tests** — mock context tests for each operation mode and error case
6. **Remove echo tool** — clean up the scaffold placeholder
7. **devcheck** — lint, format, typecheck, audit

Each step is independently testable.
