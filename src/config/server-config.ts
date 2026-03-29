/**
 * @fileoverview Server-specific configuration for calculator-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  maxExpressionLength: z.coerce
    .number()
    .default(1000)
    .describe('Maximum allowed expression string length'),
  evaluationTimeoutMs: z.coerce
    .number()
    .default(5000)
    .describe('Maximum evaluation time in milliseconds'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from env vars. */
export function getServerConfig(): ServerConfig {
  _config ??= ServerConfigSchema.parse({
    maxExpressionLength: process.env.CALC_MAX_EXPRESSION_LENGTH,
    evaluationTimeoutMs: process.env.CALC_EVALUATION_TIMEOUT_MS,
  });
  return _config;
}
