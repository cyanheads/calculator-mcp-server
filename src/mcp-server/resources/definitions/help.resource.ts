/**
 * @fileoverview Help resource — static reference of available functions, operators, and syntax.
 * @module mcp-server/resources/definitions/help.resource
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { getMathService } from '@/services/math/math-service.js';

export const helpResource = resource('calculator://help', {
  name: 'Calculator Help',
  description: 'Available functions, operators, constants, and syntax reference.',
  mimeType: 'text/markdown',
  handler() {
    return getMathService().getHelpContent();
  },
});
