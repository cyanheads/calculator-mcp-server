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
  tools: [calculateTool],
  resources: [helpResource],
  instructions:
    'Use `calculate` to verify math computations via math.js. `operation` selects `evaluate` (default, numeric), `simplify` (symbolic, with trig identities), or `derivative` (symbolic, requires `variable`). Covers arithmetic, trigonometry, logarithms, statistics, matrices, complex numbers, combinatorics, and unit conversion (e.g. `5 kg to lbs`). Pass variable values via `scope` (e.g. `{ "x": 5 }`) and bound numeric output with `precision` (1–16). One expression per call.',
  landing: {
    repoRoot: 'https://github.com/cyanheads/calculator-mcp-server',
    tagline:
      'A hardened math.js calculator MCP server — evaluate, simplify, and differentiate expressions.',
  },
  setup() {
    initMathService(getServerConfig());
  },
});
