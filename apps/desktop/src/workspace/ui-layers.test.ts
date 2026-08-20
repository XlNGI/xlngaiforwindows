import { describe, expect, it } from 'vitest';
import { MODAL_Z_INDEX, workspaceFloatingZIndex } from './ui-layers';

describe('workspace UI layers', () => {
  it('keeps modal confirmations above focused floating windows', () => {
    expect(MODAL_Z_INDEX).toBeGreaterThan(workspaceFloatingZIndex(2));
  });
});
