/** Synthetic read models matching multi-shot authoring/media continuation payloads. */
export function productionContextResults() {
  const assets = Array.from({ length: 4 }, (_, i) => ({
    assetId: `asset-${i}`,
    kind: i < 2 ? 'character' : i === 2 ? 'scene' : 'prop',
    alias: '',
    createdAt: '2026-11-02T03:14:28.701Z',
    availability: 'available',
  }));
  const bindings = assets.map((asset, i) => ({
    role: asset.kind,
    documentId: `document-${i}`,
    label: `制作参考资料 ${i}（草稿）`,
    selectionSource: 'auto',
    selectedAsset: asset,
    candidateAssets: [asset, { ...asset, assetId: `candidate-${i}` }],
    candidatesTruncated: false,
  }));
  const inputs = assets.map((asset, i) => ({
    role: asset.kind,
    label: bindings[i]!.label,
    ...asset,
  }));
  const result = (i: number, view: string, data: Record<string, unknown>) => ({
    status: 'read',
    target: { kind: 'shot', id: `shot-${i}` },
    sceneId: 'scene',
    shotId: `shot-${i}`,
    rowVersion: i + 1,
    version: i.toString(16).padStart(64, '0'),
    view,
    complete: true,
    ...data,
  });
  return [
    ...Array.from({ length: 7 }, (_, i) =>
      result(i, 'authoring', {
        authoring: {
          prompt: `镜头${i}要求`.repeat(240) + `完整保留手动修改${i}`,
          bindings: { schemaVersion: 1, characterDocumentIds: ['document-0', 'document-1'] },
        },
      }),
    ),
    ...Array.from({ length: 7 }, (_, i) =>
      result(i, 'media', {
        media: {
          scope: 'saved-production-bindings',
          modelAdapted: false,
          includesUnsavedFormEdits: false,
          target: { kind: 'shot', id: `shot-${i}` },
          bindings,
          inputs: { referenceImages: inputs, imageGeneration: inputs, videoGeneration: inputs },
        },
      }),
    ),
    result(7, 'authoring', {
      authoring: { prompt: '相邻镜头开场要求完整保留。' },
    }),
    result(8, 'authoring', {
      authoring: { prompt: '相邻镜头收尾要求完整保留。' },
    }),
  ];
}

/** Decode the public lossless history formats and check every original field. */
export function decodeProductionHistory(outputs: Array<{ callId: string; output: string }>) {
  const decoded = new Map<string, unknown>();
  const table = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(table);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.columns) && Array.isArray(record.rows))
      return record.rows.map((row: unknown) =>
        Object.fromEntries(
          (record.columns as string[]).flatMap((key, i) =>
            (row as unknown[])[i] === null ? [] : [[key, table((row as unknown[])[i])]],
          ),
        ),
      );
    if (record.resourcesTable) {
      const { resourcesTable, ...rest } = record;
      return { ...(table(rest) as object), resources: table(resourcesTable) };
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, table(child)]));
  };
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.$ref === 'string') {
      const reference = record.$ref;
      const match = /^tool-result:([^#]+)#(\/.*)$/.exec(reference);
      if (!match || !decoded.has(match[1]!)) throw new Error(`Unresolved ${reference}`);
      return match[2]!
        .slice(1)
        .split('/')
        .reduce((target: unknown, part) => {
          if (!target || typeof target !== 'object') throw new Error(`Missing ${reference}`);
          return (target as Record<string, unknown>)[
            part.replaceAll('~1', '/').replaceAll('~0', '~')
          ];
        }, decoded.get(match[1]!));
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, resolve(child)]));
  };
  for (const output of outputs) {
    const parsed = JSON.parse(output.output) as Record<string, unknown>;
    const format = (parsed.contextCompaction as { status?: string } | undefined)?.status;
    delete parsed.contextCompaction;
    decoded.set(
      output.callId,
      format === 'lossless_references'
        ? resolve(parsed)
        : format === 'lossless_table'
          ? table(parsed)
          : parsed,
    );
  }
  return decoded;
}
