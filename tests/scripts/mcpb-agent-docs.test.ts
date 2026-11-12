/**
 * @fileoverview Keep the SDK's executable skills extension in cleaned MCPB bundles.
 * @module tests/scripts/mcpb-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

describe('MCPB agent documentation filtering', () => {
  const runtimeEntries = [
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/example/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.cjs',
    'node_modules/@scope/example/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.cjs',
    'node_modules/example/lib/skills/runtime.js',
    'node_modules/@scope/skills/index.js',
  ];
  const documentationEntries = [
    'node_modules/example/skills/example-guide/SKILL.md',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-skill/SKILL.md',
    'node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/skills/example/SKILL.md',
    'node_modules/example/SKILL.md',
    'node_modules/@scope/example/skills/example-guide/SKILL.md',
    'node_modules/example/node_modules/nested/skills/example-guide/SKILL.md',
    'node_modules/@scope/example/node_modules/@scope/nested/.agents/skills/example/SKILL.md',
    'node_modules/example/AGENTS.md',
    'node_modules/@cyanheads/mcp-ts-core/CLAUDE.md',
  ];

  it('preserves the executable SDK extension while removing agent documentation', () => {
    expect(filterAgentDocEntries([...runtimeEntries, ...documentationEntries])).toEqual(
      documentationEntries,
    );
  });

  it('accepts SDK runtime entries in the post-bundle packaging check', () => {
    for (const entry of runtimeEntries) expect(AGENT_DOC_ENTRY.test(entry)).toBe(false);
    for (const entry of documentationEntries) expect(AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });
});
