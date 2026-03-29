/**
 * @fileoverview Calculate tool — evaluate, simplify, or differentiate math expressions.
 * Single tool covering 100% of the server's purpose.
 * @module mcp-server/tools/definitions/calculate.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { getMathService } from '@/services/math/math-service.js';

export const calculateTool = tool('calculate', {
  description:
    'Evaluate math expressions, simplify algebraic expressions, or compute symbolic derivatives. ' +
    'Supports arithmetic, trigonometry, statistics, matrices, complex numbers, units, and combinatorics. ' +
    'Powered by math.js — use calculator://help for the full function reference.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    expression: z
      .string()
      .describe(
        'Mathematical expression to evaluate. Supports standard notation: ' +
          'arithmetic (+, -, *, /, ^, %), functions (sin, cos, sqrt, log, abs, round, etc.), ' +
          'constants (pi, e, phi, i), matrices ([1, 2; 3, 4]), units (5 kg to lbs), ' +
          'and variables (when scope is provided).',
      ),
    operation: z
      .enum(['evaluate', 'simplify', 'derivative'])
      .default('evaluate')
      .describe(
        'Operation to perform. ' +
          '"evaluate" computes a numeric result (default). ' +
          '"simplify" reduces an algebraic expression symbolically (e.g., "2x + 3x" -> "5 * x"). ' +
          '"derivative" computes the symbolic derivative (requires variable parameter).',
      ),
    variable: z
      .string()
      .optional()
      .describe(
        'Variable to differentiate with respect to. Required when operation is "derivative". Example: "x".',
      ),
    scope: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        'Variable assignments for the expression. Example: { "x": 5, "y": 3 } makes "x + y" evaluate to 8.',
      ),
    precision: z
      .number()
      .int()
      .min(0)
      .max(64)
      .optional()
      .describe(
        'Number of significant digits for numeric results. Omit for full precision. Ignored for symbolic operations (simplify, derivative).',
      ),
  }),
  output: z.object({
    result: z.string().describe('The computed result as a string.'),
    resultType: z
      .string()
      .describe(
        'Type of result: number, BigNumber, Complex, Matrix, Unit, string, boolean. Symbolic operations return "string".',
      ),
    expression: z.string().describe('The original expression as received.'),
  }),

  handler(input, ctx) {
    const math = getMathService();

    switch (input.operation) {
      case 'evaluate': {
        const { result, resultType } = math.evaluateExpression(
          input.expression,
          input.scope,
          input.precision,
        );
        ctx.log.info('Evaluated expression', { expression: input.expression });
        return { result, resultType, expression: input.expression };
      }
      case 'simplify': {
        const { result, resultType } = math.simplifyExpression(input.expression);
        ctx.log.info('Simplified expression', { expression: input.expression });
        return { result, resultType, expression: input.expression };
      }
      case 'derivative': {
        if (!input.variable) {
          throw invalidParams(
            "The 'variable' parameter is required when operation is 'derivative'.",
          );
        }
        const { result, resultType } = math.differentiateExpression(
          input.expression,
          input.variable,
        );
        ctx.log.info('Differentiated expression', {
          expression: input.expression,
          variable: input.variable,
        });
        return { result, resultType, expression: input.expression };
      }
    }
  },

  format: (output) => [
    {
      type: 'text',
      text: `**Expression:** \`${output.expression}\`\n**Result:** ${output.result}\n**Type:** ${output.resultType}`,
    },
  ],
});
