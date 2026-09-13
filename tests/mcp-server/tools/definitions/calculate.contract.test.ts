/**
 * @fileoverview Calculator response parity through the framework's production rendering path.
 * @module tests/mcp-server/tools/definitions/calculate.contract
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { initMathService } from '@/services/math/math-service.js';

beforeAll(() => initMathService(getServerConfig()));

describe('calculate response contract', () => {
  it.each([
    { expression: '2 + 3 * 4', operation: 'evaluate', expected: '14' },
    { expression: '2x + 3x', operation: 'simplify', expected: '5 * x' },
    { expression: 'x^2', operation: 'derivative', variable: 'x', expected: '2 * x' },
  ] as const)('renders $operation results on both surfaces', async ({ expected, ...input }) => {
    const result = await runToolContract(calculateTool, input);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: expected,
      expression: input.expression,
      operation: input.operation,
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain(expected);
    expect(text).toContain(input.expression);
    expect(text).toContain(input.operation);
  });

  it('mirrors domain validation and recovery instructions', async () => {
    const result = await runToolContract(calculateTool, {
      expression: 'x^2',
      operation: 'derivative',
    });
    expect(result.isError).toBe(true);
    const hint = 'Pass the variable parameter (e.g., "x") when operation is "derivative".';
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'derivative_missing_variable', recovery: { hint } },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining(hint) }),
      ]),
    );
  });
});
