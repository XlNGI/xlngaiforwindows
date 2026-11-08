import { convertFileSrc } from '@tauri-apps/api/core';
import { workerMediaUrl, workerScope } from '../worker-scope';
import { resolveAssetDrop } from './use-asset-drop';

/** Read only Worker-approved local media, with a bound even when Content-Length is absent. */
export async function assetAttachmentFiles(
  raw: string,
  projectId: string,
  maximumBytes: number,
  maximumTotal: number,
  maximumCount: number,
): Promise<File[]> {
  const { payload, sources, scope } = await resolveAssetDrop(
    raw,
    projectId,
    ['image', 'video'],
    maximumCount,
  );
  const files: File[] = [];
  let total = 0;
  for (const [index, source] of sources.entries()) {
    const url =
      '__TAURI_INTERNALS__' in window
        ? convertFileSrc(source.path)
        : workerMediaUrl(payload.assets[index]!.id, false, scope);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('素材文件读取失败，请检查文件是否仍然可用。');
      const limit = Math.min(maximumBytes, maximumTotal - total);
      if (Number(response.headers.get('content-length')) > limit)
        throw new Error('附件超过大小限制：单个 20 MiB，合计 40 MiB。');
      const reader = response.body?.getReader();
      const chunks: ArrayBuffer[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error('附件超过大小限制：单个 20 MiB，合计 40 MiB。');
            chunks.push(value.slice().buffer);
          }
        } finally {
          await reader.cancel();
        }
      } else {
        const bytes = await response.arrayBuffer();
        size = bytes.byteLength;
        if (size > limit) throw new Error('附件超过大小限制：单个 20 MiB，合计 40 MiB。');
        chunks.push(bytes);
      }
      if (!size) throw new Error('素材文件为空。');
      if (scope?.projectSessionId !== workerScope(projectId)?.projectSessionId)
        throw new Error('项目已切换，请重新拖入素材。');
      const name = source.path.split(/[\\/]/).pop() || `素材-${index + 1}`;
      files.push(new File(chunks, name, { type: source.contentType }));
      total += size;
    } finally {
      controller.abort();
      window.clearTimeout(timeout);
    }
  }
  return files;
}
