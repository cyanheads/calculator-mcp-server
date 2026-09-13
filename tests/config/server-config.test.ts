/**
 * @fileoverview Environment normalization coverage for calculator configuration.
 * @module tests/config/server-config
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

describe('calculator environment configuration', () => {
  it.each([undefined, '', `\${user_config.limit}`])(
    'uses defaults for unset value %s',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('CALC_MAX_EXPRESSION_LENGTH', value);
      vi.stubEnv('CALC_EVALUATION_TIMEOUT_MS', value);
      vi.stubEnv('CALC_MAX_RESULT_LENGTH', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(getServerConfig()).toEqual({
        maxExpressionLength: 1000,
        evaluationTimeoutMs: 5000,
        maxResultLength: 100000,
      });
    },
  );

  it.each([`\${user_config.limit`, `\${user_config.limit}suffix`, 'bad', '0'])(
    'rejects invalid configuration %s',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('CALC_MAX_EXPRESSION_LENGTH', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(() => getServerConfig()).toThrow('CALC_MAX_EXPRESSION_LENGTH');
    },
  );

  it('honors explicit numeric settings', async () => {
    vi.resetModules();
    vi.stubEnv('CALC_MAX_EXPRESSION_LENGTH', '2000');
    vi.stubEnv('CALC_EVALUATION_TIMEOUT_MS', '6000');
    vi.stubEnv('CALC_MAX_RESULT_LENGTH', '200000');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      maxExpressionLength: 2000,
      evaluationTimeoutMs: 6000,
      maxResultLength: 200000,
    });
  });
});
