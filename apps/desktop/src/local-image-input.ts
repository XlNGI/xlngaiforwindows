import type { AdapterParameters } from '@ai-video/contracts';

export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_LOCAL_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

const SUPPORTED_MEDIA_TYPES = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/webp', 'image/webp'],
]);

const EXTENSION_MEDIA_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);

export interface LocalImageSelection {
  dataUrl: string;
  name: string;
  size: number;
}

export function isLocalImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value);
}

export function hasLocalImageParameters(parameters: AdapterParameters): boolean {
  return Object.values(parameters).some((value) =>
    Array.isArray(value) ? value.some(isLocalImageDataUrl) : isLocalImageDataUrl(value),
  );
}

export function localImageDataBytes(value: string): number {
  if (!isLocalImageDataUrl(value)) return 0;
  const encoded = value.slice(value.indexOf(',') + 1).replace(/\s/g, '');
  if (!encoded) return 0;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

export function totalLocalImageBytes(values: string[]): number {
  return values.reduce((total, value) => total + localImageDataBytes(value), 0);
}

export async function readLocalImageFile(file: File): Promise<LocalImageSelection> {
  const mediaType = resolveMediaType(file);
  if (!mediaType) throw new Error('仅支持 PNG、JPEG/JPG 和 WebP 图片。');
  if (file.size === 0) throw new Error('所选图片为空文件。');
  if (file.size > MAX_LOCAL_IMAGE_BYTES) throw new Error('单张本地图片不能超过 20 MiB。');

  const source = await readAsDataUrl(file);
  const comma = source.indexOf(',');
  if (comma < 0) throw new Error('无法读取所选图片。');
  const encoded = source.slice(comma + 1);
  const dataUrl = `data:${mediaType};base64,${encoded}`;
  if (!hasExpectedSignature(dataUrl, mediaType)) {
    throw new Error('图片内容与文件格式不匹配。');
  }
  return { dataUrl, name: file.name, size: file.size };
}

function resolveMediaType(file: File): string | undefined {
  const declared = SUPPORTED_MEDIA_TYPES.get(file.type.toLowerCase());
  const extension = file.name.split('.').pop()?.toLowerCase();
  const inferred = extension ? EXTENSION_MEDIA_TYPES.get(extension) : undefined;
  if (declared && inferred && declared !== inferred) return undefined;
  return declared ?? inferred;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取所选图片。'));
    reader.onabort = () => reject(new Error('图片读取已取消。'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('无法读取所选图片。'));
    reader.readAsDataURL(file);
  });
}

function hasExpectedSignature(dataUrl: string, mediaType: string): boolean {
  try {
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 33);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (mediaType === 'image/png') {
      return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    }
    if (mediaType === 'image/jpeg') {
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    );
  } catch {
    return false;
  }
}
