#!/usr/bin/env node
/**
 * @fileoverview calculator-mcp-server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { helpResource } from '@/mcp-server/resources/definitions/help.resource.js';
import { calculateTool } from '@/mcp-server/tools/definitions/calculate.tool.js';
import { initMathService } from '@/services/math/math-service.js';

await createApp({
  name: 'calculator-mcp-server',
  title: 'calculator-mcp-server',
  tools: [calculateTool],
  resources: [helpResource],
  skills: 'skills',
  /**
   * No tool gates on `ctx.requestInput`, and nothing is held between calls, so
   * the session store earns nothing here. `MCP_SESSION_MODE` still overrides.
   */
  sessionMode: 'stateless',
  instructions:
    'Use `calculate` to verify math computations via math.js. `operation` selects `evaluate` (default, numeric), `simplify` (symbolic, with trig identities), or `derivative` (symbolic, requires `variable`). Covers arithmetic, trigonometry, logarithms, statistics, matrices and linear systems (`lusolve`), polynomial roots (`polynomialRoot`), complex numbers, combinatorics, unit conversion (e.g. `5 kg to lbs`), date arithmetic on quoted `YYYY-MM-DD` dates (`dateDiff`, `dateAdd`, `weekday`, `isoWeek`, `daysInMonth`), and numeric definite integrals (`integrate(f, x, a, b)`). For `evaluate`, pass variable values via `scope` (e.g. `{ "x": 5 }`) and bound numeric output with `precision` (1–16); symbolic operations ignore both. One expression per call. The `calculator://help` resource lists the operators, limits, and functions by category, with worked examples.',
  landing: {
    repoRoot: 'https://github.com/cyanheads/calculator-mcp-server',
    tagline:
      'A hardened math.js calculator MCP server — evaluate, simplify, and differentiate expressions.',
    requireAuth: false,
  },
  setup() {
    initMathService(getServerConfig());
  },
});
