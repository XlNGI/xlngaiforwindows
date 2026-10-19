import type { AdapterDescriptor, AdapterParameters } from './index.js';

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Schema) : undefined;

/** Only positive item variants declare accepted media, not `not`/`if`/`contains` rules. */
function itemVariants(value: unknown): Schema[] {
  const schema = object(value);
  if (!schema) return [];
  return [
    schema,
    ...['oneOf', 'anyOf', 'allOf'].flatMap((key) =>
      Array.isArray(schema[key]) ? schema[key].flatMap(itemVariants) : [],
    ),
  ];
}
const accepts = (schema: unknown, value: string) => {
  const property = object(schema);
  return (
    property?.const === value || (Array.isArray(property?.enum) && property.enum.includes(value))
  );
};

export function productionAudioSupport(adapter: Pick<AdapterDescriptor, 'parameterSchema'>) {
  const properties = adapter.parameterSchema.properties;
  const media = itemVariants(properties.media?.items);
  const content = itemVariants(properties.content?.items);
  const has = (variants: Schema[], field: string, value: string) =>
    variants.some((variant) => accepts(object(variant.properties)?.[field], value));
  return {
    outputField:
      properties.audio?.type === 'boolean'
        ? 'audio'
        : properties.generate_audio?.type === 'boolean'
          ? 'generate_audio'
          : undefined,
    voiceReference:
      has(media, 'type', 'reference_audio') ||
      content.some((variant) => {
        const fields = object(variant.properties);
        return accepts(fields?.type, 'audio_url') && accepts(fields?.role, 'reference_audio');
      }),
    dialogueDriven: has(media, 'type', 'driving_audio'),
  };
}

export function productionInputSupport(adapter: Pick<AdapterDescriptor, 'parameterSchema'>) {
  const p = adapter.parameterSchema.properties;
  const types = [...itemVariants(p.media?.items), ...itemVariants(p.content?.items)].flatMap(
    (variant) => {
      const type = object(variant.properties)?.type;
      const field = object(type);
      return typeof field?.const === 'string'
        ? [field.const]
        : Array.isArray(field?.enum)
          ? field.enum.filter((v): v is string => typeof v === 'string')
          : [];
    },
  );
  return {
    images: Boolean(
      p.images ||
      types.some((type) =>
        ['reference_image', 'first_frame', 'last_frame', 'image_url'].includes(type),
      ),
    ),
    video: Boolean(
      p.video ||
      types.some((type) => ['reference_video', 'first_clip', 'video_url'].includes(type)),
    ),
    minImages: p.images?.minItems ?? 0,
    maxImages: p.images?.maxItems ?? p.media?.maxItems ?? p.content?.maxItems ?? 30,
  };
}

/** Drop fields from a previous model without removing values for declared optional fields. */
export function projectProductionParameters(
  adapter: Pick<AdapterDescriptor, 'parameterSchema'>,
  parameters: AdapterParameters,
): AdapterParameters {
  return Object.fromEntries(
    Object.entries(parameters).filter(([field]) =>
      Object.hasOwn(adapter.parameterSchema.properties, field),
    ),
  );
}
