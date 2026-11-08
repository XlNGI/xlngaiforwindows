import { describe, expect, it } from 'vitest';
import { RequestValidationError, validateSessionRequestParams } from './request-validation.js';

describe('conversation prompt template request validation', () => {
  it('accepts an empty editable template and validates its CAS version', () => {
    const params = {
      conversationId: 'conversation',
      content: '',
      expectedRowVersion: 0,
    };
    expect(validateSessionRequestParams('conversation.promptTemplate.save', params)).toBe(params);
    expect(
      validateSessionRequestParams('conversation.promptTemplate.get', {
        conversationId: 'conversation',
      }),
    ).toEqual({ conversationId: 'conversation' });
  });

  it('accepts long templates and rejects invalid content types or non-integer versions', () => {
    const params = {
      conversationId: 'conversation',
      content: 'x'.repeat(20_001),
      expectedRowVersion: 0,
    };
    expect(validateSessionRequestParams('conversation.promptTemplate.save', params)).toBe(params);
    expect(params.content).toBe('x'.repeat(20_001));
    expect(() =>
      validateSessionRequestParams('conversation.promptTemplate.save', {
        ...params,
        content: 42,
      }),
    ).toThrow(RequestValidationError);
    expect(() =>
      validateSessionRequestParams('conversation.promptTemplate.save', {
        conversationId: 'conversation',
        content: '约束',
        expectedRowVersion: 1.5,
      }),
    ).toThrow(RequestValidationError);
  });
});
