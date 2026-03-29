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
  setup() {
    initMathService(getServerConfig());
  },
});
