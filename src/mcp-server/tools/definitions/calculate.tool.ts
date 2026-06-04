/**
 * @fileoverview Calculate tool — evaluate, simplify, or differentiate math expressions.
 * Single tool covering 100% of the server's purpose.
 * @module mcp-server/tools/definitions/calculate.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getMathService } from '@/services/math/math-service.js';

export const calculateTool = tool('calculate', {
  description:
    'Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives. One expression per call. Supports arithmetic, trigonometry, statistics, matrices, complex numbers, units, and combinatorics.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    expression: z
      .string()
      .min(1)
      .describe(
        `One mathematical expression per call — neither \`;\` nor newlines separate statements. Inside matrices, \`;\` separates rows (e.g. \`[1, 2; 3, 4]\`). Supports arithmetic (+, -, *, /, ^, %), functions (sin, cos, sqrt, log, abs, round, etc.), constants (pi, e, phi, i), matrices, units (5 kg to lbs), and variables (when scope is provided). Standard notation \`ln\` and \`arc*\` (e.g. \`arcsin\`, \`arctan\`) is accepted alongside the math.js names \`log\` and \`asin\`/\`atan\`.`,
      ),
    operation: z
      .enum(['evaluate', 'simplify', 'derivative'])
      .default('evaluate')
      .describe(
        'Operation to perform. "evaluate" computes a numeric result (default). "simplify" reduces an algebraic expression symbolically (e.g., "2x + 3x" -> "5 * x"). Supports algebraic and trigonometric identities. When the simplifier cannot reduce the expression further (e.g. rational expressions requiring polynomial factoring), the result is returned unchanged and unchanged: true is set in the output. "derivative" computes the symbolic derivative (requires the variable parameter).',
      ),
    variable: z
      .union([
        z.literal('').describe('Empty string — treated as omitted.'),
        z
          .string()
          .max(50)
          .regex(
            /^[a-zA-Z_][a-zA-Z0-9_]*$/,
            'Variable name must be alphanumeric (a-z, A-Z, 0-9, _).',
          )
          .describe('Variable identifier (alphanumeric and underscores, max 50 chars).'),
      ])
      .optional()
      .describe(
        'Variable to differentiate with respect to. Required when operation is "derivative". Empty string is treated as omitted. Example: "x".',
      ),
    scope: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        'Variable assignments for the expression. Example: { "x": 5, "y": 3 } makes "x + y" evaluate to 8.',
      ),
    precision: z
      .union([
        z.literal('').describe('Empty string — treated as omitted.'),
        z.number().int().min(1).max(16).describe('Significant digits (integer, 1–16).'),
      ])
      .optional()
      .describe(
        'Significant digits (1–16) for numeric results. Omit for full precision. Empty string is treated as omitted. Ignored for symbolic operations (simplify, derivative).',
      ),
    numericType: z
      .enum(['number', 'BigNumber', 'Fraction'])
      .default('number')
      .describe(
        'Numeric type for evaluate. "number" (default): 64-bit IEEE 754 float — fastest, standard precision. "BigNumber": arbitrary-precision decimal — use when intermediate values overflow 64-bit float (e.g. large factorial ratios like 10000!/9999!); slower than "number". "Fraction": exact rational arithmetic — eliminates floating-point rounding (e.g. 0.1 + 0.2 = 0.3 exactly); limited to expressions without transcendental functions. Ignored for symbolic operations (simplify, derivative). When "number" evaluation produces a non-finite result (undefined_result error), retry with "BigNumber".',
      ),
  }),
  output: z.object({
    result: z.string().describe('The computed result as a string.'),
    resultType: z
      .string()
      .describe(
        'Type of result as reported by math.js: number, BigNumber, Complex, DenseMatrix, Unit, string, boolean. Symbolic operations return "string".',
      ),
    expression: z.string().describe('The original expression as received.'),
    operation: z
      .enum(['evaluate', 'simplify', 'derivative'])
      .describe('The operation that was applied.'),
    scopeVars: z
      .array(z.string())
      .optional()
      .describe(
        'Keys from the scope that were active during evaluation. Omitted when no scope was provided. Values are omitted to keep output compact.',
      ),
    precisionUsed: z
      .number()
      .optional()
      .describe(
        'Significant-digit precision applied to the result. Omitted when full precision was used or the operation is symbolic.',
      ),
    unchanged: z
      .boolean()
      .optional()
      .describe(
        "Present only for simplify operations. true means the simplifier returned the expression unchanged — it could not reduce it further (e.g. rational expressions requiring polynomial factoring are beyond math.js's built-in simplifier). false means simplification made progress. Omitted for evaluate and derivative.",
      ),
  }),
  errors: [
    {
      reason: 'empty_expression',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Expression is empty or whitespace-only.',
      recovery: 'Provide a non-empty math expression in the expression parameter.',
    },
    {
      reason: 'expression_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Expression exceeds the configured max length (CALC_MAX_EXPRESSION_LENGTH).',
      recovery: 'Shorten the expression or split it into multiple separate calls.',
    },
    {
      reason: 'multiple_expressions',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Expression contains a separator (`;` or newline) outside matrix brackets.',
      recovery: 'Send one expression per call; issue separate calls for each statement.',
    },
    {
      reason: 'reserved_scope_key',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Scope contains a reserved JS property name (`__proto__`, `constructor`, etc.).',
      recovery: 'Rename the variable to avoid reserved JavaScript property names.',
    },
    {
      reason: 'disallowed_result_type',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Result is a function, parser, or multi-expression ResultSet, or the expression converts a function to a string (e.g. `cos.toString()`) — security guard.',
      recovery:
        'Rewrite the expression to produce a value (number, matrix, unit) instead of a function or its source.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Stringified result exceeds the configured max size (CALC_MAX_RESULT_LENGTH).',
      recovery:
        'Reduce precision, narrow the input range, or compute smaller subproblems separately.',
    },
    {
      reason: 'undefined_result',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Expression evaluated to Infinity, -Infinity, or NaN (e.g., division by zero).',
      recovery:
        'Check for division by zero, log of non-positive numbers, or other undefined operations.',
    },
    {
      reason: 'parse_failed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'mathjs could not parse the expression.',
      recovery:
        'Check syntax for balanced parentheses, valid operators, and correct function names.',
    },
    {
      reason: 'derivative_missing_variable',
      code: JsonRpcErrorCode.ValidationError,
      when: '`operation` is `derivative` but `variable` was not provided.',
      recovery: 'Pass the variable parameter (e.g., "x") when operation is "derivative".',
    },
    {
      reason: 'evaluation_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Expression evaluation exceeded the configured timeout (CALC_EVALUATION_TIMEOUT_MS).',
      retryable: false,
      recovery:
        'Simplify the expression or reduce computational complexity to fit within the timeout.',
    },
  ],

  handler(input, ctx) {
    const math = getMathService();
    const { expression, operation, scope } = input;
    const variable = input.variable || undefined;
    const precision = typeof input.precision === 'number' ? input.precision : undefined;
    const numericType = input.numericType;

    switch (operation) {
      case 'evaluate':
        ctx.log.info('Evaluated expression', { expression, numericType });
        return {
          ...math.evaluateExpression(expression, ctx, scope, precision, numericType),
          expression,
          operation,
          // Omit context fields that carry no signal: scopeVars only when a scope
          // was supplied, precisionUsed only when a precision was applied (#14).
          ...(scope ? { scopeVars: Object.keys(scope) } : {}),
          ...(precision !== undefined ? { precisionUsed: precision } : {}),
        };
      case 'simplify': {
        const simplifyResult = math.simplifyExpression(expression, ctx);
        ctx.log.info('Simplified expression', { expression, unchanged: simplifyResult.unchanged });
        // Symbolic operations never carry scope/precision context — omit both.
        // Always include unchanged so callers can detect no-op simplifications (#1).
        return {
          result: simplifyResult.result,
          resultType: simplifyResult.resultType,
          expression,
          operation,
          unchanged: simplifyResult.unchanged,
        };
      }
      case 'derivative':
        if (!variable) {
          throw ctx.fail(
            'derivative_missing_variable',
            "The 'variable' parameter is required when operation is 'derivative'.",
            { ...ctx.recoveryFor('derivative_missing_variable') },
          );
        }
        ctx.log.info('Differentiated expression', { expression, variable });
        // Symbolic operations never carry scope/precision context — omit both.
        return {
          ...math.differentiateExpression(expression, variable, ctx),
          expression,
          operation,
        };
      default:
        throw new Error(`Unhandled operation: ${operation as string}`);
    }
  },

  format: (output) => {
    const scopeVars =
      output.scopeVars && output.scopeVars.length > 0 ? output.scopeVars.join(', ') : 'none';
    const precision = output.precisionUsed ?? 'full';
    const lines = [
      `**Expression:** \`${output.expression}\``,
      `**Operation:** ${output.operation}`,
      `**Result:** ${output.result}`,
      `**Type:** ${output.resultType}`,
    ];
    if (output.unchanged !== undefined) {
      // Present only for simplify — unchanged: true means the simplifier made no progress.
      lines.push(
        output.unchanged
          ? '**Simplified:** unchanged — expression could not be reduced further'
          : '**Simplified:** reduced (unchanged: false)',
      );
    }
    if (output.operation !== 'simplify') {
      lines.push(`**Scope variables:** ${scopeVars}`);
      lines.push(`**Precision:** ${precision}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
