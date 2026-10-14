import type { AdapterParameterValue } from '@ai-video/contracts';

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

/** Preserve structured values throughout schema-derived forms. */
export function StructuredParameterField({
  schema,
  value,
  onChange,
  label,
  path = 'structured',
  depth = 0,
}: {
  schema: Schema;
  value?: AdapterParameterValue;
  label: string;
  path?: string;
  depth?: number;
  onChange: (value: AdapterParameterValue | undefined) => void;
}) {
  if (depth > 10) return <small>参数嵌套层级超出支持范围。</small>;
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf.map(object) : [];
  const current = object(value);
  const selected = Math.max(
    0,
    variants.findIndex((variant) => object(object(variant.properties).type).const === current.type),
  );
  const active = variants[selected] ?? schema;
  if (active.type === 'object' || variants.length)
    return (
      <fieldset className="parameter-field">
        <legend>{label}</legend>
        {variants.length > 0 && (
          <label>
            {label}类型
            <select
              aria-label={`${label}类型`}
              value={selected}
              onChange={(event) => onChange(initial(variants[Number(event.target.value)]!))}
            >
              {variants.map((variant, index) => {
                const kind = parameterScalarText(
                  object(object(variant.properties).type).const ?? index,
                );
                return (
                  <option key={index} value={index}>
                    {names[kind] ?? kind}
                  </option>
                );
              })}
            </select>
          </label>
        )}
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
              onChange={(next) => {
                const output = { ...current } as Record<string, AdapterParameterValue>;
                if (next === undefined) delete output[key];
                else output[key] = next;
                onChange(output);
              }}
            />
          ))}
      </fieldset>
    );
  if (active.type === 'array') {
    const items = Array.isArray(value) ? value : [];
    const itemSchema = object(active.items);
    return (
      <fieldset className="parameter-field">
        <legend>{label}</legend>
        {items.map((item, index) => (
          <div key={index}>
            <StructuredParameterField
              schema={itemSchema}
              value={item}
              label={`${label} ${index + 1}`}
              path={`${path}.${index}`}
              depth={depth + 1}
              onChange={(next) =>
                onChange(
                  items.map((previous, at) =>
                    at === index ? (next ?? initial(itemSchema)) : previous,
                  ),
                )
              }
            />
            <button
              type="button"
              className="button secondary"
              aria-label={`删除${label} ${index + 1}`}
              onClick={() => onChange(items.filter((_, at) => at !== index))}
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button secondary"
          disabled={items.length >= (typeof active.maxItems === 'number' ? active.maxItems : 64)}
          onClick={() => onChange([...items, initial(itemSchema)])}
        >
          添加{label}
        </button>
      </fieldset>
    );
  }
  if (active.type === 'boolean')
    return (
      <label className="parameter-field">
        <span>{label}</span>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  const choices = Array.isArray(active.enum) ? active.enum : [];
  if (choices.length)
    return (
      <label className="parameter-field">
        <span>{label}</span>
        <select
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
      </label>
    );
  const numeric = active.type === 'integer' || active.type === 'number';
  return (
    <label className="parameter-field" htmlFor={path}>
      <span>{label}</span>
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
      {typeof active.description === 'string' && <small>{active.description}</small>}
    </label>
  );
}
