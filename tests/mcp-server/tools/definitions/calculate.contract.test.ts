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

type ToolInput = Parameters<typeof runToolContract<typeof calculateTool>>[1];

/** The text blocks of a result, joined. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The declared recovery hint for a reason, read from the tool's own contract. */
function recoveryFor(reason: string): string {
  const entry = calculateTool.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No contract entry for ${reason}`);
  return entry.recovery;
}

/** Assert a failure's code, reason, and recovery hint on both response surfaces. */
async function expectWireError(
  input: ToolInput,
  code: JsonRpcErrorCode,
  reason: string,
): Promise<string> {
  const result = await runToolContract(calculateTool, input);
  expect(result.isError).toBe(true);
  const hint = recoveryFor(reason);
  expect(result.structuredContent).toMatchObject({
    error: { code, data: { reason, recovery: { hint } } },
  });
  const text = textOf(result);
  expect(text).toContain(hint);
  expect(text).toContain(`reason ${reason}`);
  return text;
}

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
    const text = textOf(result);
    expect(text).toContain(expected);
    expect(text).toContain(input.expression);
    expect(text).toContain(input.operation);
  });

  it.each([
    ['10 m / 2 s', '5 m / s'],
    ['10 m * 1 ly / 1 s', '94607304725808000 m^2 / s'],
    ['5 m/s to knot', '9.719222462203023 knot'],
  ])('simplifies %s to %s on both surfaces (#37)', async (expression, expected) => {
    const result = await runToolContract(calculateTool, { expression });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ result: expected, resultType: 'Unit' });
    expect(textOf(result)).toContain(`**Result:** \`${expected}\``);
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

  it.each([
    { input: { expression: "concat('a;b', 'c')" }, expected: '"a;bc"', resultType: 'string' },
    { input: { expression: '"ln("' }, expected: '"ln("', resultType: 'string' },
    {
      input: { expression: 'eigs([1,0;0,2]).values' },
      expected: '[1, 2]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'ln(e)', numericType: 'BigNumber' },
      expected: '1',
      resultType: 'BigNumber',
    },
    {
      input: { expression: 'identity(2)', numericType: 'Fraction' },
      expected: '[[1, 0], [0, 1]]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: '2e5', numericType: 'Fraction' },
      expected: '200000/1',
      resultType: 'Fraction',
    },
    {
      input: { expression: '[1, 2, 3][2]', numericType: 'Fraction' },
      expected: '2/1',
      resultType: 'Fraction',
    },
    {
      input: { expression: 'row([1, 2; 3, 4], 1)', numericType: 'Fraction' },
      expected: '[[1/1, 2/1]]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'count([1, 2, 3])', numericType: 'Fraction' },
      expected: '3',
      resultType: 'number',
    },
    {
      input: { expression: 'mean([1, 2])', numericType: 'Fraction' },
      expected: '3/2',
      resultType: 'Fraction',
    },
    {
      input: { expression: 'sum([1, 2; 3, 4], 1)', numericType: 'Fraction' },
      expected: '[4/1, 6/1]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'max([1, 2; 3, 4], 2)', numericType: 'Fraction' },
      expected: '[2/1, 4/1]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'min([1, 2; 3, 4], 1)', numericType: 'Fraction' },
      expected: '[1/1, 2/1]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'mean([1, 2; 4, 7], 1)', numericType: 'Fraction' },
      expected: '[5/2, 9/2]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'variance([1, 2; 3, 4], 1)', numericType: 'Fraction' },
      expected: '[2/1, 2/1]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'cumsum([1, 2; 3, 4], 1)', numericType: 'Fraction' },
      expected: '[[1/1, 2/1], [4/1, 6/1]]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'concat([1, 2], [3, 4], 1)', numericType: 'Fraction' },
      expected: '[1/1, 2/1, 3/1, 4/1]',
      resultType: 'DenseMatrix',
    },
    {
      input: { expression: 'sum([1, 2, 3])', numericType: 'Fraction' },
      expected: '6/1',
      resultType: 'Fraction',
    },
    {
      input: { expression: 'sum([1, 2; 3, 4], 1)' },
      expected: '[4, 6]',
      resultType: 'DenseMatrix',
    },
  ] as const)(
    'renders $input.expression on both surfaces',
    async ({ input, expected, resultType }) => {
      const result = await runToolContract(calculateTool, input);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ result: expected, resultType });
      const text = textOf(result);
      expect(text).toContain(`**Result:** \`${expected}\``);
      expect(text).toContain(`**Type:** ${resultType}`);
    },
  );

  describe('structuredContent for Markdown-active values (#26)', () => {
    it.each([
      [{ expression: '"a`b"' }, { result: '"a`b"', resultType: 'string' }],
      [
        { expression: '"[click](https://example.com)"' },
        { result: '"[click](https://example.com)"', resultType: 'string' },
      ],
      [
        { expression: '"<script>alert(1)</script>"' },
        { result: '"<script>alert(1)</script>"', resultType: 'string' },
      ],
      [
        { expression: '["<b>x</b>", "[l](u)"]' },
        { result: '["<b>x</b>", "[l](u)"]', resultType: 'DenseMatrix' },
      ],
      [{ expression: '{a: "<i>"}' }, { result: '{"a": "<i>"}', resultType: 'Object' }],
      [
        { expression: '1 + 1', scope: { '<img src=x>': 1, 'a`b': 2 } },
        { result: '2', resultType: 'number', scopeVars: ['<img src=x>', 'a`b'] },
      ],
      [
        { expression: 'sparse([1, 0; 0, 1])' },
        {
          result: 'Sparse Matrix [2 x 2] density: 0.5\n\n    (0, 0) ==> 1\n    (1, 1) ==> 1',
          resultType: 'SparseMatrix',
        },
      ],
      [
        { expression: 'x^2 * y', operation: 'derivative', variable: 'x', scope: { y: 3 } },
        { result: '2 * y * x', resultType: 'string' },
      ],
    ] as const)('keeps %o structured values literal', async (input, fields) => {
      const result = await runToolContract(calculateTool, input as ToolInput);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        operation: 'evaluate',
        expression: input.expression,
        ...fields,
        ...('operation' in input ? { operation: input.operation } : {}),
      });
    });

    it.each([
      ['"a`b"', '``"a`b"``'],
      ['"[click](https://example.com)"', '`"[click](https://example.com)"`'],
      ['"<script>alert(1)</script>"', '`"<script>alert(1)</script>"`'],
      ['["<b>x</b>", "[l](u)"]', '`["<b>x</b>", "[l](u)"]`'],
      ['{a: "<i>"}', '`{"a": "<i>"}`'],
    ])('renders %s with its structured result inside a code span', async (expression, span) => {
      const result = await runToolContract(calculateTool, { expression });
      const { result: value } = result.structuredContent as { result: string };
      expect(span).toContain(value);
      const text = textOf(result);
      expect(text).toContain(`\n**Result:** ${span}\n`);
      expect(text).not.toContain(`**Result:** ${value}`);
    });

    it('renders the backtick expression in a sized span', async () => {
      const result = await runToolContract(calculateTool, { expression: '"a`b"' });
      expect(textOf(result)).toMatch(/^\*\*Expression:\*\* ``"a`b"``\n/);
    });

    it('renders each scope key in its own span', async () => {
      const result = await runToolContract(calculateTool, {
        expression: '1 + 1',
        scope: { '<img src=x>': 1, 'a`b': 2 },
      });
      expect(textOf(result)).toContain('**Scope variables:** `<img src=x>`, ``a`b``\n');
    });

    it('renders a SparseMatrix result in a fenced block', async () => {
      const result = await runToolContract(calculateTool, { expression: 'sparse([1, 0; 0, 1])' });
      const { result: value } = result.structuredContent as { result: string };
      expect(textOf(result)).toContain(
        `**Result:**\n\`\`\`\n${value}\n\`\`\`\n**Type:** SparseMatrix`,
      );
    });

    it('renders an expression holding a line break in a fenced block', async () => {
      const expression = '"a\nb"';
      const result = await runToolContract(calculateTool, { expression });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toMatch(/^\*\*Expression:\*\*\n```\n"a\nb"\n```\n\*\*Operation:\*\*/);
    });

    it('leaves scope and precision lines out of derivative output', async () => {
      const result = await runToolContract(calculateTool, {
        expression: 'x^2 * y',
        operation: 'derivative',
        variable: 'x',
        scope: { y: 3 },
        precision: 4,
      });
      const text = textOf(result);
      expect(text).toContain('**Result:** `2 * y * x`');
      expect(text).not.toContain('Scope variables');
      expect(text).not.toContain('Precision');
    });
  });

  it('lists only the caller-supplied scope keys on both surfaces', async () => {
    const scope = { x: 1 };
    const result = await runToolContract(calculateTool, { expression: '(y = 2) + x', scope });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ result: '3', scopeVars: ['x'] });
    expect(textOf(result)).toContain('**Scope variables:** `x`\n');
    expect(scope).toEqual({ x: 1 });
  });

  describe('declared failure reasons on the wire', () => {
    it.each([
      {
        input: { expression: 'derivative("0.2*x + 5", "x")' },
        reason: 'operation_as_function',
        detail: 'operation: "derivative"',
      },
      {
        input: { expression: 'simplify("2*x")', operation: 'derivative', variable: 'x' },
        reason: 'operation_as_function',
        detail: '"simplify"',
      },
      { input: { expression: '5 kg + 3' }, reason: 'type_mismatch', detail: 'addScalar' },
      { input: { expression: '2^(3 m)' }, reason: 'type_mismatch', detail: 'pow' },
      {
        input: { expression: 'factorial(-1)' },
        reason: 'evaluation_failed',
        detail: 'non-negative',
      },
      { input: { expression: 'det([1,2,3])' }, reason: 'evaluation_failed', detail: 'square' },
      { input: { expression: 'foo(5)' }, reason: 'parse_failed', detail: 'Undefined function foo' },
      {
        input: { expression: '1 / 0', numericType: 'BigNumber' },
        reason: 'undefined_result',
        detail: 'non-finite',
      },
      {
        input: { expression: '1 / 0', numericType: 'Fraction' },
        reason: 'undefined_result',
        detail: 'non-finite',
      },
      {
        input: { expression: '{a: [1 kg / 0]}' },
        reason: 'undefined_result',
        detail: 'non-finite',
      },
      { input: { expression: '171!' }, reason: 'undefined_result', detail: 'overflowed' },
      {
        input: { expression: 'sqrt(4)', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'calls a function Fraction mode cannot compute',
      },
      {
        input: { expression: 'sqrt(2)', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'no exact rational value',
      },
      {
        input: { expression: 'pi', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'rounded 64-bit float',
      },
      {
        input: { expression: 'sin(pi)', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'rounded 64-bit float',
      },
      {
        input: { expression: '2^(1/2)', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'rounded 64-bit float',
      },
      {
        input: { expression: '[[1, 2], [3, pi]]', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'rounded 64-bit float',
      },
      {
        input: { expression: 'pi * 2/3', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'rounded 64-bit float',
      },
      {
        input: { expression: '[1, 2, 3][3/2]', numericType: 'Fraction' },
        reason: 'evaluation_failed',
        detail: 'needs whole-number indexes',
      },
      {
        input: { expression: 'sum([1, 2; 3, 4], 1/2)', numericType: 'Fraction' },
        reason: 'evaluation_failed',
        detail: 'sum() needs whole-number dimensions; got 1/2.',
      },
      {
        input: { expression: 'median([1, 2; 3, 4], 1)', numericType: 'Fraction' },
        reason: 'evaluation_failed',
        detail: 'median(A, dim) is not yet supported',
      },
      {
        input: { expression: 'prod([1, 2; 3, 4], 1)', numericType: 'Fraction' },
        reason: 'evaluation_failed',
        detail: 'prod(A, dim) is not yet supported',
      },
      {
        input: { expression: 'std([1, 2; 3, 6; 5, 10], 1)', numericType: 'Fraction' },
        reason: 'fraction_unsupported',
        detail: 'calls a function Fraction mode cannot compute',
      },
      {
        input: { expression: 'help("sin")' },
        reason: 'disallowed_result_type',
        detail: 'calculator://help',
      },
      { input: { expression: 'help(sin)' }, reason: 'disallowed_result_type', detail: 'help()' },
      {
        input: { expression: `'"' ; 1+1` },
        reason: 'multiple_expressions',
        detail: 'Multiple expressions',
      },
      { input: { expression: 'range(1, 1/0)' }, reason: 'result_too_large', detail: 'range()' },
      { input: { expression: 'zeros(33334)' }, reason: 'result_too_large', detail: '100000' },
    ] as const)('$reason for $input.expression', async ({ input, reason, detail }) => {
      const text = await expectWireError(input, JsonRpcErrorCode.ValidationError, reason);
      expect(text).toContain(detail);
    });

    it('evaluation_failed with a symbolic hint for a function with no derivative rule', async () => {
      const result = await runToolContract(calculateTool, {
        expression: 'floor(x)',
        operation: 'derivative',
        variable: 'x',
      });
      expect(result.isError).toBe(true);
      const hint =
        '"floor" has no symbolic derivative rule — rewrite the expression without it, or evaluate it numerically with operation "evaluate", passing values for its variables (such as x) through scope.';
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'evaluation_failed', recovery: { hint } },
        },
      });
      const text = textOf(result);
      expect(text).toContain('no rule for the function "floor"');
      expect(text).toContain(hint);
      expect(text).toContain('reason evaluation_failed');
    });

    it.each([
      {
        expression: '5 min to s',
        detail: '"min" is a function, not the unit "minute"',
        hint: 'write minute',
      },
      {
        expression: '(f(x) = x^2)(3)',
        detail: 'a function was used as a value',
        hint: 'parentheses',
      },
    ])(
      'type_mismatch with a function-as-value hint for $expression',
      async ({ expression, detail, hint }) => {
        const result = await runToolContract(calculateTool, { expression });
        expect(result.isError).toBe(true);
        const error = (
          result.structuredContent as {
            error: { message: string; data: { reason: string; recovery: { hint: string } } };
          }
        ).error;
        expect(error.data.reason).toBe('type_mismatch');
        expect(error.message).toContain(detail);
        expect(error.data.recovery.hint).toContain(hint);
        expect(error.data.recovery.hint).not.toBe(recoveryFor('type_mismatch'));
        const text = textOf(result);
        expect(text).toContain(detail);
        expect(text).toContain(error.data.recovery.hint);
        expect(text).toContain('reason type_mismatch');
      },
    );

    it('evaluation_timeout for an expression past the timeout', async () => {
      initMathService({ ...getServerConfig(), evaluationTimeoutMs: 1 });
      try {
        const text = await expectWireError(
          { expression: 'sum(map(range(1, 1e6), x^2))' },
          JsonRpcErrorCode.Timeout,
          'evaluation_timeout',
        );
        expect(text).toContain('timed out');
      } finally {
        initMathService(getServerConfig());
      }
    });
  });
});
