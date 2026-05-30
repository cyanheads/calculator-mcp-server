/**
 * @fileoverview Tests for the calculator://help resource.
 * @module mcp-server/resources/definitions/help.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { helpResource } from '@/mcp-server/resources/definitions/help.resource.js';
import { initMathService } from '@/services/math/math-service.js';

beforeAll(() => {
  initMathService(getServerConfig());
});

describe('help resource', () => {
  it('returns a non-empty markdown string', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler(ctx);
    expect(typeof content).toBe('string');
    expect((content as string).length).toBeGreaterThan(0);
  });

  it('contains major section headings', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler(ctx) as string;
    expect(content).toContain('## Operators');
    expect(content).toContain('## Constants');
    expect(content).toContain('## Functions');
    expect(content).toContain('## Syntax Examples');
  });

  it('documents the evaluate/simplify/derivative operations', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler(ctx) as string;
    expect(content).toContain('evaluate');
    expect(content).toContain('simplify');
    expect(content).toContain('derivative');
  });

  it('mentions unit conversion syntax', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler(ctx) as string;
    expect(content).toContain('kg to lbs');
  });

  it('does not expose math.js version in help content', () => {
    const ctx = createMockContext({ uri: new URL('calculator://help') });
    const content = helpResource.handler(ctx) as string;
    // The version constant is redacted in the expression scope — it must
    // not be mentioned as a literal semver in the help text either.
    expect(content).not.toMatch(/math\.js\s+\d+\.\d+\.\d+/);
  });

  it('returns the same content on repeated calls (idempotent)', () => {
    const ctx1 = createMockContext({ uri: new URL('calculator://help') });
    const ctx2 = createMockContext({ uri: new URL('calculator://help') });
    expect(helpResource.handler(ctx1)).toBe(helpResource.handler(ctx2));
  });
});
