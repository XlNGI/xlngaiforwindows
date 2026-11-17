import { describe, expect, it } from 'vitest';
import { RequestValidationError, validateSessionRequestParams } from './request-validation.js';

describe('conversation prompt template request validation', () => {
  it('validates scoped types without adding creative defaults', () => {
    const params = {
      conversationId: 'c',
      content: '',
      templates: { 'video-prompt': '', 'prop-image': '白背景' },
      expectedRowVersion: 3,
    };
    expect(validateSessionRequestParams('conversation.promptTemplate.save', params)).toBe(params);
    for (const templates of [{ camera: 'fixed' }, { 'video-prompt': 12 }, []])
      expect(() =>
        validateSessionRequestParams('conversation.promptTemplate.save', { ...params, templates }),
      ).toThrow(RequestValidationError);
  });
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
