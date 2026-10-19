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

  it('rejects an oversized or non-integer version', () => {
    expect(() =>
      validateSessionRequestParams('conversation.promptTemplate.save', {
        conversationId: 'conversation',
        content: 'x'.repeat(20_001),
        expectedRowVersion: 0,
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
