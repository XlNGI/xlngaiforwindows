import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdapterParameterValue } from '@ai-video/contracts';
import { resolveAssetDrop, useAssetDrop } from './use-asset-drop';

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : {};

function mediaShape(schema: Schema) {
  const properties = object(schema.properties);
  const type = object(properties.type).const;
  if (
    ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'first_clip'].includes(
      String(type),
    ) &&
    object(properties.url).type === 'string'
  )
    return {
      kind:
        String(type).includes('video') || type === 'first_clip'
          ? ('video' as const)
          : ('image' as const),
      key: 'url',
    };
  if (
    ['image_url', 'video_url'].includes(String(type)) &&
    object(object(object(properties[String(type)]).properties).url).type === 'string'
  )
    return {
      kind: type === 'video_url' ? ('video' as const) : ('image' as const),
      key: String(type),
    };
  return undefined;
}

export function StructuredAssetDrop({
  schema,
  value,
  projectId,
  onChange,
  children,
  mediaKind,
}: {
  schema: Schema;
  value?: AdapterParameterValue;
  projectId?: string;
  onChange: (value: AdapterParameterValue) => void;
  children: ReactNode;
  mediaKind?: 'image' | 'video';
}) {
  const array = schema.type === 'array';
  const itemSchema = array ? object(schema.items) : schema;
  const variants = Array.isArray(itemSchema.oneOf) ? itemSchema.oneOf.map(object) : [itemSchema];
  const media = mediaKind
    ? [{ schema, kind: mediaKind, key: '' }]
    : variants.flatMap((variant) => {
        const shape = mediaShape(variant);
        return shape ? [{ schema: variant, ...shape }] : [];
      });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef({ value, projectId, onChange });
  latest.current = { value, projectId, onChange };
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const drop = useAssetDrop<HTMLDivElement>({
    enabled: media.length > 0,
    onDrop: (raw) => {
      const snapshot = latest.current;
      const token = ++request.current;
      const items = Array.isArray(value) ? value : [];
      const maximum = array
        ? (typeof schema.maxItems === 'number' ? schema.maxItems : 64) - items.length
        : 1;
      const current = () =>
        token === request.current &&
        latest.current.value === snapshot.value &&
        latest.current.projectId === snapshot.projectId;
      setBusy(true);
      void (async () => {
        try {
          const { payload, sources } = await resolveAssetDrop(
            raw,
            projectId,
            media.map((item) => item.kind),
            maximum,
          );
          if (!current()) return;
          const usedFrames = new Set(items.map((item) => object(item).type));
          const added = payload.assets.map((asset, index) => {
            const candidates = media.filter((item) =>
              sources[index]!.contentType.startsWith(`${item.kind}/`),
            );
            const type = (item: (typeof media)[number]) =>
              object(object(item.schema.properties).type).const;
            const shape =
              candidates.find((item) => type(item) === 'reference_image') ??
              candidates.find(
                (item) =>
                  !['first_frame', 'last_frame'].includes(String(type(item))) ||
                  !usedFrames.has(type(item)),
              );
            if (!shape) throw new Error('当前表单没有更多可用的图片位置，请替换已有图片。');
            usedFrames.add(type(shape));
            const output: Schema = array ? {} : { ...object(value) };
            for (const [key, child] of Object.entries(object(shape.schema.properties))) {
              const property = object(child);
              const fallback: unknown =
                property.const ??
                property.default ??
                (Array.isArray(property.enum) && property.enum.length === 1
                  ? property.enum[0]
                  : undefined);
              if (fallback !== undefined && output[key] === undefined) output[key] = fallback;
            }
            const url = `asset://${asset.id}`;
            if (mediaKind) return url;
            output[shape.key] = shape.key === 'url' ? url : { ...object(output[shape.key]), url };
            return output as AdapterParameterValue;
          });
          setError('');
          snapshot.onChange(array ? [...items, ...added] : added[0]!);
        } catch (reason) {
          if (current()) setError(reason instanceof Error ? reason.message : '素材拖入失败。');
        } finally {
          if (token === request.current) setBusy(false);
        }
      })();
    },
  });
  if (!media.length) return children;
  return (
    <div
      ref={drop.ref}
      {...drop.handlers}
      className={`structured-asset-drop ${drop.hovering ? 'is-asset-drag-over' : ''}`}
      aria-busy={busy}
    >
      {children}
      {busy && <small role="status">正在读取素材…</small>}
      {error && (
        <small className="parameter-error" role="status">
          {error}
        </small>
      )}
    </div>
  );
}
