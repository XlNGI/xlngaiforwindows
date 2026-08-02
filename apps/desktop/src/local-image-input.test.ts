import { describe, expect, it } from 'vitest';
import {
  hasLocalImageParameters,
  isLocalImageDataUrl,
  localImageDataBytes,
  MAX_LOCAL_IMAGE_BYTES,
  readLocalImageFile,
  totalLocalImageBytes,
} from './local-image-input';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe('local image input', () => {
  it('reads a supported image as a normalized Data URL', async () => {
    const selected = await readLocalImageFile(
      new File([PNG_BYTES], 'reference.png', { type: 'image/png' }),
    );

    expect(selected).toMatchObject({ name: 'reference.png', size: PNG_BYTES.length });
    expect(selected.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(isLocalImageDataUrl(selected.dataUrl)).toBe(true);
    expect(localImageDataBytes(selected.dataUrl)).toBe(PNG_BYTES.length);
    expect(totalLocalImageBytes([selected.dataUrl, 'https://example.invalid/image.png'])).toBe(
      PNG_BYTES.length,
    );
    expect(hasLocalImageParameters({ images: [selected.dataUrl] })).toBe(true);
  });

  it('rejects unsupported, spoofed, empty, and oversized files before submission', async () => {
    await expect(
      readLocalImageFile(new File(['gif'], 'reference.gif', { type: 'image/gif' })),
    ).rejects.toThrow('仅支持');
    await expect(
      readLocalImageFile(new File(['not-png'], 'reference.png', { type: 'image/png' })),
    ).rejects.toThrow('文件格式不匹配');
    await expect(
      readLocalImageFile(new File([], 'empty.png', { type: 'image/png' })),
    ).rejects.toThrow('空文件');

    const oversized = new File([PNG_BYTES], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { value: MAX_LOCAL_IMAGE_BYTES + 1 });
    await expect(readLocalImageFile(oversized)).rejects.toThrow('20 MiB');
  });
});
