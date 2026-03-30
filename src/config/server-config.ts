/**
 * @fileoverview Server-specific configuration for calculator-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  maxExpressionLength: z.coerce
    .number()
    .int()
    .min(10)
    .max(10_000)
    .default(1000)
    .describe('Maximum allowed expression string length (10–10,000)'),
  evaluationTimeoutMs: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(5000)
    .describe('Maximum evaluation time in milliseconds (100–30,000)'),
  maxResultLength: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_000_000)
    .default(100_000)
    .describe('Maximum result string length in characters (1,000–1,000,000)'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from env vars. */
export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    maxExpressionLength: process.env.CALC_MAX_EXPRESSION_LENGTH,
    evaluationTimeoutMs: process.env.CALC_EVALUATION_TIMEOUT_MS,
    maxResultLength: process.env.CALC_MAX_RESULT_LENGTH,
  });
  return _config;
}
