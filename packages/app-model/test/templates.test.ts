import { describe, expect, it } from 'vitest';
import { lintDefinition, TEMPLATES, validateDefinition } from '@platform/app-model';

describe('templates', () => {
  it('each pass the checks of any definition, and leave nothing for a reviewer to weigh', () => {
    expect(TEMPLATES.map((template) => template.id)).toEqual(['expenses', 'leave', 'purchasing']);
    for (const template of TEMPLATES) {
      const result = validateDefinition(template.definition);
      expect(result.ok ? [] : result.issues, template.id).toEqual([]);
      if (result.ok) expect(lintDefinition(result.definition), template.id).toEqual([]);
    }
  });
});
