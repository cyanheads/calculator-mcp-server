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
        `One mathematical expression per call — neither \`;\` nor newlines separate statements. Inside matrices, \`;\` separates rows (e.g. \`[1, 2; 3, 4]\`). Supports arithmetic (+, -, *, /, ^, %), functions (sin, cos, sqrt, log, abs, round, etc.), constants (pi, e, phi, i), matrices, units (5 kg to lbs), and variables (when scope is provided).`,
      ),
    operation: z
      .enum(['evaluate', 'simplify', 'derivative'])
      .default('evaluate')
      .describe(
        'Operation to perform. "evaluate" computes a numeric result (default). "simplify" reduces an algebraic expression symbolically (e.g., "2x + 3x" -> "5 * x"). Supports algebraic and trigonometric identities. "derivative" computes the symbolic derivative (requires the variable parameter).',
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
  }),
  output: z.object({
    result: z.string().describe('The computed result as a string.'),
    resultType: z
      .string()
      .describe(
        'Type of result as reported by math.js: number, BigNumber, Complex, DenseMatrix, Unit, string, boolean. Symbolic operations return "string".',
      ),
    expression: z.string().describe('The original expression as received.'),
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
      when: 'Result type is function, parser, or multi-expression ResultSet — security guard.',
      recovery:
        'Rewrite the expression to produce a value (number, matrix, unit) instead of a function or parser.',
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
      code: JsonRpcErrorCode.ServiceUnavailable,
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

    switch (operation) {
      case 'evaluate':
        ctx.log.info('Evaluated expression', { expression });
        return { ...math.evaluateExpression(expression, ctx, scope, precision), expression };
      case 'simplify':
        ctx.log.info('Simplified expression', { expression });
        return { ...math.simplifyExpression(expression, ctx), expression };
      case 'derivative':
        if (!variable) {
          throw ctx.fail(
            'derivative_missing_variable',
            "The 'variable' parameter is required when operation is 'derivative'.",
            { ...ctx.recoveryFor('derivative_missing_variable') },
          );
        }
        ctx.log.info('Differentiated expression', { expression, variable });
        return { ...math.differentiateExpression(expression, variable, ctx), expression };
    }
  },

  format: (output) => [
    {
      type: 'text',
      text: `**Expression:** \`${output.expression}\`\n**Result:** ${output.result}\n**Type:** ${output.resultType}`,
    },
  ],
});
