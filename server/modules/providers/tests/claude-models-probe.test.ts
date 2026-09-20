import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeModelsDefinitionFromModelInfos } from '@/modules/providers/list/claude/claude-models.provider.js';

/**
 * The probe is the primary source of the model catalogue: whatever the CLI
 * reports is by definition what this deployment accepts. These tests pin the
 * mapping — effort levels, the ultracode rule, and the refusal to build a
 * catalogue from nothing.
 */

test('maps value, label, and description; no effort block when not effort-capable', () => {
  const definition = buildClaudeModelsDefinitionFromModelInfos([
    { value: 'claude-sonnet-5[1m]', displayName: 'Sonnet (1M)', description: 'Everyday coding.' },
  ]);

  assert.ok(definition);
  assert.equal(definition.DEFAULT, 'default');
  assert.deepEqual(definition.OPTIONS, [{
    value: 'claude-sonnet-5[1m]',
    label: 'Sonnet (1M)',
    description: 'Everyday coding.',
  }]);
});

test('effort levels come from the CLI, and xhigh capability earns the ultracode option', () => {
  const definition = buildClaudeModelsDefinitionFromModelInfos([
    {
      value: 'claude-opus-5[1m]',
      displayName: 'Opus (1M)',
      description: 'Hardest tasks.',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ]);

  assert.ok(definition);
  assert.deepEqual(definition.OPTIONS[0].effort, {
    default: 'high',
    values: [
      { value: 'low' },
      { value: 'medium' },
      { value: 'high' },
      { value: 'xhigh' },
      { value: 'max' },
      { value: 'ultracode', description: 'Highest effort plus standing workflow orchestration.' },
    ],
  });
});

test('an effort-capable model without reported levels falls back to the standard four', () => {
  const definition = buildClaudeModelsDefinitionFromModelInfos([
    { value: 'claude-haiku-4-5', displayName: 'Haiku', description: 'Fast.', supportsEffort: true },
  ]);

  assert.ok(definition);
  assert.deepEqual(
    definition.OPTIONS[0].effort?.values.map((level) => level.value),
    ['low', 'medium', 'high', 'max'],
  );
  assert.equal(definition.OPTIONS[0].effort?.values.some((level) => level.value === 'ultracode'), false);
});

test('entries without a usable value are dropped, and nothing usable means null', () => {
  const definition = buildClaudeModelsDefinitionFromModelInfos([
    { value: '  ', displayName: 'Blank' },
    { displayName: 'No value at all' },
    { value: 'claude-sonnet-5', displayName: 'Sonnet' },
  ]);
  assert.ok(definition);
  assert.deepEqual(definition.OPTIONS.map((option) => option.value), ['claude-sonnet-5']);

  assert.equal(buildClaudeModelsDefinitionFromModelInfos([]), null);
});
