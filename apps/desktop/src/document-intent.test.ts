import { describe, expect, it } from 'vitest';
import { inferDocumentIntent } from './App';

describe('inferDocumentIntent', () => {
  it('recognizes explicit document creation without changing ordinary chat', () => {
    expect(inferDocumentIntent('Create a project brief')).toEqual({
      intent: { operation: 'document.create_draft' },
      needsTarget: false,
    });
    expect(inferDocumentIntent('Explain how a project brief works')).toEqual({
      needsTarget: false,
    });
  });

  it('requires the currently selected document for targeted operations', () => {
    expect(inferDocumentIntent('Update this document')).toEqual({ needsTarget: true });
    expect(inferDocumentIntent('Update this document', 'document-1')).toEqual({
      intent: { operation: 'document.update_draft', documentId: 'document-1' },
      needsTarget: false,
    });
    expect(inferDocumentIntent('Archive this document', 'document-1')).toEqual({
      intent: { operation: 'document.archive', documentId: 'document-1' },
      needsTarget: false,
    });
    expect(inferDocumentIntent('Unarchive this document', 'document-1')).toEqual({
      intent: { operation: 'document.restore', documentId: 'document-1' },
      needsTarget: false,
    });
  });

  it('keeps negated requests side-effect free', () => {
    expect(inferDocumentIntent("Don't create a document")).toEqual({ needsTarget: false });
  });
});
