import { describe, expect, it } from 'vitest';
import { assertStorageCapacity } from './storage-capacity.js';

describe('assertStorageCapacity', () => {
  it('rejects a media write when required bytes would consume the reserve', () => {
    expect(() => assertStorageCapacity('unused', 10, () => ({ bavail: 1, bsize: 1_024 }))).toThrow(
      'Insufficient disk space',
    );
  });

  it('accepts a bounded write with sufficient free space', () => {
    expect(() =>
      assertStorageCapacity('unused', 1_024, () => ({ bavail: 64, bsize: 1024 * 1024 })),
    ).not.toThrow();
  });
});
