import type { AdapterParameterValue } from '@ai-video/contracts';
import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { ParameterHelp } from './ParameterHelp';
import { imageAssetId, ParameterImagePreview } from './ParameterImagePreview';
import { isLocalImageDataUrl } from './local-image-input';

type Schema = Record<string, unknown>;
export const parameterScalarText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
const object = (value: unknown): Schema =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : {};
const names: Record<string, string> = {
  text: '内容',
  prompt: '提示词',
  url: '媒体地址',
  role: '用途',
  id: '引用名称',
  element_id: '角色元素 ID',
  audio_url: '参考音频',
  image_url: '参考图片',
  video_url: '参考视频',
  reference_audio: '参考音频',
  driving_audio: '完整对白',
  reference_image: '参考图片',
  reference_video: '参考视频',
  first_frame: '首帧',
  last_frame: '尾帧',
  element: '角色',
};
function initial(schema: Schema): AdapterParameterValue {
  if (schema.default !== undefined) return structuredClone(schema.default) as AdapterParameterValue;
  const variant = Array.isArray(schema.oneOf) ? object(schema.oneOf[0]) : schema;
  if (variant.type === 'object')
    return Object.fromEntries(
      Object.entries(object(variant.properties))
        .filter(([, child]) => object(child).const !== undefined)
        .map(([key, child]) => [key, object(child).const as AdapterParameterValue]),
    );
  return variant.type === 'array' ? [] : '';
}

function variantSchema(schema: Schema, value: unknown): Schema {
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf.map(object) : [];
  return (
    variants.find(
      (variant) => object(object(variant.properties).type).const === object(value).type,
    ) ??
    variants[0] ??
    schema
  );
}

function imageProperty(schema: Schema): string | undefined {
  const properties = object(schema.properties);
  const kind = object(properties.type).const;
  if (
    ['first_frame', 'last_frame', 'reference_image'].includes(String(kind)) &&
    object(properties.url).type === 'string'
  )
    return 'url';
  if (
    kind === 'image_url' &&
    object(object(object(properties.image_url).properties).url).type === 'string'
  )
    return 'image_url';
  return undefined;
}

function previewableImage(url: string): boolean {
  return Boolean(imageAssetId(url)) || isLocalImageDataUrl(url) || /^https?:\/\//u.test(url);
}

function StructuredImageObject({
  schema,
  value,
  label,
  path,
  projectId,
  selector,
  actions,
  onChange,
  depth,
}: {
  schema: Schema;
  value: Schema;
  label: string;
  path: string;
  projectId?: string;
  selector: ReactNode;
  actions?: ReactNode;
  onChange: (value: AdapterParameterValue) => void;
  depth: number;
}) {
  const key = imageProperty(schema)!;
  const url = parameterScalarText(key === 'url' ? value.url : object(value[key]).url);
  const [editing, setEditing] = useState(!previewableImage(url));
  const properties = object(schema.properties);
  const sourceSchema =
    key === 'url' ? object(properties.url) : object(object(object(properties[key]).properties).url);
  const updateUrl = (next: string) =>
    onChange({
      ...value,
      [key]: key === 'url' ? next : { ...object(value[key]), url: next },
    } as Record<string, AdapterParameterValue>);
  return (
    <div className="parameter-field structured-image-object" role="group" aria-label={label}>
      {selector}
      {previewableImage(url) && !editing ? (
        <div className="local-image-value">
          <ParameterImagePreview value={url} label={label} projectId={projectId} />
        </div>
      ) : (
        <div className="parameter-field structured-image-editor">
          <label htmlFor={`${path}-image-url`}>媒体地址</label>
          <input
            id={`${path}-image-url`}
            value={url}
            placeholder="输入图片地址"
            onChange={(event) => updateUrl(event.target.value)}
          />
        </div>
      )}
      {Object.entries(properties)
        .filter(([name, child]) => name !== key && object(child).const === undefined)
        .map(([name, child]) => (
          <StructuredParameterField
            key={name}
            schema={object(child)}
            value={value[name] as AdapterParameterValue | undefined}
            label={parameterScalarText(object(child).title ?? names[name] ?? name)}
            path={`${path}.${name}`}
            depth={depth + 1}
            projectId={projectId}
            onChange={(next) => {
              const output = { ...value } as Record<string, AdapterParameterValue>;
              if (next === undefined) delete output[name];
              else output[name] = next;
              onChange(output);
            }}
          />
        ))}
      <div className="url-row-actions">
        <button
          type="button"
          className="icon-button subtle"
          title={editing ? '完成图片输入' : '更换图片'}
          aria-label={`${editing ? '完成图片输入' : '更换图片'}：${label}`}
          disabled={editing && !previewableImage(url)}
          onClick={() => setEditing(!editing)}
        >
          {editing ? <Check size={14} /> : <ImagePlus size={14} />}
        </button>
        {actions}
      </div>
      {editing && (
        <ParameterHelp
          description={
            typeof sourceSchema.description === 'string' ? sourceSchema.description : undefined
          }
          label={label}
        />
      )}
    </div>
  );
}

/** Preserve structured values throughout schema-derived forms. */
export function StructuredParameterField({
  schema,
  value,
  onChange,
  label,
  path = 'structured',
  depth = 0,
  projectId,
  actions,
  multiline = false,
}: {
  schema: Schema;
  value?: AdapterParameterValue;
  label: string;
  path?: string;
  depth?: number;
  projectId?: string;
  actions?: ReactNode;
  multiline?: boolean;
  onChange: (value: AdapterParameterValue | undefined) => void;
}) {
  if (depth > 10) return <small className="parameter-error">参数嵌套层级超出支持范围。</small>;
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf.map(object) : [];
  const current = object(value);
  const selected = Math.max(
    0,
    variants.findIndex((variant) => object(object(variant.properties).type).const === current.type),
  );
  const active = variants[selected] ?? schema;
  const selector =
    variants.length > 0 ? (
      <select
        className="structured-variant-select"
        aria-label={`${label}类型`}
        value={selected}
        onChange={(event) => onChange(initial(variants[Number(event.target.value)]!))}
      >
        {variants.map((variant, index) => {
          const kind = parameterScalarText(object(object(variant.properties).type).const ?? index);
          return (
            <option key={index} value={index}>
              {names[kind] ?? kind}
            </option>
          );
        })}
      </select>
    ) : null;
  if (imageProperty(active))
    return (
      <StructuredImageObject
        key={`${projectId}:${parameterScalarText(object(object(active.properties).type).const)}`}
        schema={active}
        value={current}
        label={label}
        path={path}
        projectId={projectId}
        selector={selector}
        actions={actions}
        onChange={onChange}
        depth={depth}
      />
    );
  if (active.type === 'object' || variants.length)
    return (
      <fieldset className="parameter-field structured-parameter-object">
        <legend>{label}</legend>
        {selector}
        {Object.entries(object(active.properties))
          .filter(([, child]) => object(child).const === undefined)
          .map(([key, child]) => (
            <StructuredParameterField
              key={key}
              schema={object(child)}
              value={current[key] as AdapterParameterValue | undefined}
              label={parameterScalarText(object(child).title ?? names[key] ?? key)}
              path={`${path}.${key}`}
              depth={depth + 1}
              projectId={projectId}
              multiline={['text', 'prompt'].includes(key)}
              onChange={(next) => {
                const output = { ...current } as Record<string, AdapterParameterValue>;
                if (next === undefined) delete output[key];
                else output[key] = next;
                onChange(output);
              }}
            />
          ))}
        {actions && <div className="structured-item-actions">{actions}</div>}
      </fieldset>
    );
  if (active.type === 'array') {
    const items = Array.isArray(value) ? value : [];
    const itemSchema = object(active.items);
    return (
      <section className="parameter-field structured-parameter-array" aria-label={label}>
        <div className="parameter-field-heading">
          <span className="parameter-label">{label}</span>
          <button
            type="button"
            className="button secondary url-list-add"
            disabled={items.length >= (typeof active.maxItems === 'number' ? active.maxItems : 64)}
            onClick={() => onChange([...items, initial(itemSchema)])}
          >
            <Plus size={14} />
            添加{label}
          </button>
        </div>
        <div className="structured-parameter-list">
          {items.map((item, index) => (
            <div
              className={
                imageProperty(variantSchema(itemSchema, item))
                  ? 'url-list-item is-image'
                  : 'structured-parameter-item'
              }
              key={index}
            >
              <StructuredParameterField
                schema={itemSchema}
                value={item}
                label={`${label} ${index + 1}`}
                path={`${path}.${index}`}
                depth={depth + 1}
                projectId={projectId}
                actions={
                  <>
                    {[-1, 1].map((offset) => (
                      <button
                        key={offset}
                        type="button"
                        className="icon-button subtle"
                        title={offset < 0 ? '上移' : '下移'}
                        aria-label={`${offset < 0 ? '上移' : '下移'}${label} ${index + 1}`}
                        disabled={index + offset < 0 || index + offset >= items.length}
                        onClick={() => {
                          const next = [...items];
                          [next[index], next[index + offset]] = [
                            next[index + offset]!,
                            next[index]!,
                          ];
                          onChange(next);
                        }}
                      >
                        {offset < 0 ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="icon-button subtle"
                      title="删除"
                      aria-label={`删除${label} ${index + 1}`}
                      onClick={() => onChange(items.filter((_, at) => at !== index))}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                }
                onChange={(next) =>
                  onChange(
                    items.map((previous, at) =>
                      at === index ? (next ?? initial(itemSchema)) : previous,
                    ),
                  )
                }
              />
            </div>
          ))}
        </div>
        {actions && <div className="structured-item-actions">{actions}</div>}
      </section>
    );
  }
  if (active.type === 'boolean')
    return (
      <div className="parameter-field toggle-field">
        <label htmlFor={path}>{label}</label>
        <input
          id={path}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {actions && <div className="structured-item-actions">{actions}</div>}
      </div>
    );
  const choices = Array.isArray(active.enum) ? active.enum : [];
  if (choices.length)
    return (
      <div className="parameter-field">
        <label htmlFor={path}>{label}</label>
        <select
          id={path}
          aria-label={label}
          value={parameterScalarText(value)}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">请选择</option>
          {choices.map((choice) => (
            <option key={String(choice)} value={String(choice)}>
              {names[String(choice)] ?? String(choice)}
            </option>
          ))}
        </select>
        {actions && <div className="structured-item-actions">{actions}</div>}
      </div>
    );
  const numeric = active.type === 'integer' || active.type === 'number';
  if (multiline)
    return (
      <div className="parameter-field prompt-field">
        <label htmlFor={path}>{label}</label>
        <textarea
          id={path}
          aria-label={label}
          value={parameterScalarText(value)}
          maxLength={typeof active.maxLength === 'number' ? active.maxLength : undefined}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
        <ParameterHelp
          description={typeof active.description === 'string' ? active.description : undefined}
          label={label}
        />
        {actions && <div className="structured-item-actions">{actions}</div>}
      </div>
    );
  return (
    <div className="parameter-field">
      <label htmlFor={path}>{label}</label>
      <input
        id={path}
        aria-label={label}
        type={numeric ? 'number' : 'text'}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        onChange={(event) =>
          onChange(
            event.target.value === ''
              ? undefined
              : numeric
                ? Number(event.target.value)
                : event.target.value,
          )
        }
      />
      <ParameterHelp
        description={typeof active.description === 'string' ? active.description : undefined}
        label={label}
      />
      {actions && <div className="structured-item-actions">{actions}</div>}
    </div>
  );
}
