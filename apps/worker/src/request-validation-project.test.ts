import { describe, expect, it } from 'vitest';
import { RequestValidationError, validateSessionRequestParams } from './request-validation.js';

describe('project request validation', () => {
  it('accepts a bounded project rename', () => {
    const params = { name: '新项目名称' };
    expect(validateSessionRequestParams('project.rename', params)).toBe(params);
  });

  it.each([
    {},
    { name: '   ' },
    { name: 'x'.repeat(201) },
    { name: 'Valid name', unexpected: true },
  ])('rejects invalid project rename params: %o', (params) => {
    expect(() => validateSessionRequestParams('project.rename', params)).toThrow(
      RequestValidationError,
    );
  });
});
