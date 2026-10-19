import type {
  AdapterDescriptor,
  AdapterParameters,
  AdapterParameterValue,
  CharacterVoiceReferenceInfo,
  ProductionInputImage,
  SceneMaterialBindingInfo,
} from './index.js';
import { productionAudioSupport } from './production-schema.js';
import { productionImageReference } from './production.js';

const records = (
  value: AdapterParameterValue | undefined,
): Record<string, AdapterParameterValue>[] =>
  Array.isArray(value)
    ? value.filter((v): v is Record<string, AdapterParameterValue> =>
        Boolean(v && typeof v === 'object' && !Array.isArray(v)),
      )
    : [];
const tag = (value: AdapterParameterValue | undefined) => (typeof value === 'string' ? value : '');
const canonical = (url: string) => url.replace(/^asset:\/\//u, 'project-asset://');

export function productionImagesFromParameters(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
): ProductionInputImage[] {
  const items = adapter.parameterSchema.properties.media
    ? records(parameters.media)
    : records(parameters.content);
  const result = items.flatMap((item) => {
    const kind = tag(item.type);
    if (!['reference_image', 'first_frame', 'last_frame', 'image_url'].includes(kind)) return [];
    const url =
      kind === 'image_url'
        ? (item.image_url as Record<string, AdapterParameterValue>)?.url
        : item.url;
    const role = kind === 'image_url' ? item.role : kind;
    return typeof url === 'string'
      ? [
          {
            url,
            role:
              role === 'first_frame'
                ? ('first-frame' as const)
                : role === 'last_frame'
                  ? ('last-frame' as const)
                  : ('reference' as const),
          },
        ]
      : [];
  });
  return [
    ...result,
    ...(Array.isArray(parameters.images)
      ? parameters.images
          .filter((v): v is string => typeof v === 'string')
          .map((url) => ({ url, role: 'reference' as const }))
      : []),
  ];
}

/** One canonical model-input projector used by Desktop, Worker and Agent. */
export function seedProductionInputs(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  prompt?: string,
  images?: ProductionInputImage[],
): AdapterParameters {
  const next = structuredClone(parameters);
  const properties = adapter.parameterSchema.properties;
  const known = images?.map((image) => ({ ...image, url: canonical(image.url) }));
  let chosen = known;
  const frames =
    adapter.capability === 'IMAGE_TO_VIDEO' || adapter.capability === 'START_END_TO_VIDEO';
  if (frames && known?.some((image) => image.role && image.role !== 'reference')) {
    const first = known.find((image) => image.role === 'first-frame');
    const last = known.find((image) => image.role === 'last-frame');
    if (known.length && !first)
      throw new Error('当前生成方式需要本镜首帧；角色与场景参考图不能自动当作首帧。');
    chosen = [first, ...(adapter.capability === 'START_END_TO_VIDEO' ? [last] : [])].filter(
      (image): image is ProductionInputImage => Boolean(image),
    );
  }
  const role = (index: number) =>
    frames ? (index === 0 ? 'first_frame' : 'last_frame') : 'reference_image';
  if (properties.media) {
    delete next.images;
    if (prompt !== undefined && properties.prompt) next.prompt = prompt;
    if (chosen !== undefined)
      next.media = [
        ...chosen.map((image, index) => ({ type: role(index), url: image.url })),
        ...records(next.media).filter(
          (item) => !['reference_image', 'first_frame', 'last_frame'].includes(tag(item.type)),
        ),
      ];
    if (Array.isArray(next.media) && !next.media.length) delete next.media;
  } else if (properties.content) {
    delete next.images;
    const content = records(next.content);
    const text = prompt ?? content.find((item) => item.type === 'text')?.text;
    next.content = [
      ...(typeof text === 'string' && text ? [{ type: 'text', text }] : []),
      ...(chosen !== undefined
        ? chosen.map((image, index) => ({
            type: 'image_url',
            image_url: { url: image.url },
            role: role(index),
          }))
        : content.filter((item) => item.type === 'image_url')),
      ...content.filter((item) => item.type !== 'text' && item.type !== 'image_url'),
    ];
    delete next.prompt;
  } else {
    if (prompt !== undefined && properties.prompt) next.prompt = prompt;
    if (chosen !== undefined && properties.images) next.images = chosen.map((image) => image.url);
  }
  return next;
}

/** Selected local voices and image labels are projected once, after actual ordering is known. */
export function addProductionRoleVoices(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  voices: CharacterVoiceReferenceInfo[],
  dialogueAudioId?: string,
  imageBindings: SceneMaterialBindingInfo[] = [],
): AdapterParameters {
  const next = structuredClone(parameters);
  const support = productionAudioSupport(adapter);
  const media = records(next.media),
    content = records(next.content);
  const imageUrls = adapter.parameterSchema.properties.media
    ? media
        .filter((item) => ['reference_image', 'first_frame', 'last_frame'].includes(tag(item.type)))
        .map((item) => item.url)
    : adapter.parameterSchema.properties.content
      ? content
          .filter((item) => item.type === 'image_url')
          .map((item) => (item.image_url as Record<string, AdapterParameterValue>)?.url)
      : Array.isArray(next.images)
        ? next.images
        : [];
  const lines = imageBindings.flatMap((binding) => {
    const index = imageUrls.findIndex(
      (url) => typeof url === 'string' && canonical(url) === `project-asset://${binding.assetId}`,
    );
    const reference = productionImageReference(adapter, index + 1);
    return index < 0 || !reference
      ? []
      : [
          `${binding.role === 'character' ? '角色' : binding.role === 'scene' ? '场景' : '素材'}「${binding.label}」参考${reference}。`,
        ];
  });
  if (dialogueAudioId) {
    if (!support.dialogueDriven) throw new Error('当前模型不接受完整对白录音驱动。');
    if (voices.length) throw new Error('完整对白驱动不能同时提交角色音色参考。');
    next.media = [
      ...media.filter((item) => item.type !== 'driving_audio'),
      { type: 'driving_audio', url: `project-audio://${dialogueAudioId}` },
    ];
  }
  if (voices.length) {
    if (!support.voiceReference)
      throw new Error('当前模型不能使用角色音色样本；请选择完整对白或支持音色参考的模型。');
    if (
      media.some((item) => ['first_frame', 'last_frame'].includes(tag(item.type))) ||
      content.some(
        (item) =>
          ['first_frame', 'last_frame'].includes(tag(item.role)) ||
          (item.type === 'image_url' && !item.role),
      )
    )
      throw new Error('严格首尾帧与声音参考不能混用，请切换为参考图片模式。');
    if (
      media.some((item) => item.type === 'reference_audio') ||
      content.some((item) => item.type === 'audio_url')
    )
      throw new Error('请使用角色声音选择或手动参考音频其中一种，避免音频编号不明确。');
    lines.push(
      ...voices.map((voice, index) => `角色「${voice.characterName}」使用音频${index + 1}的音色。`),
    );
    if (adapter.parameterSchema.properties.media)
      next.media = [
        ...records(next.media),
        ...voices.map((voice) => ({
          type: 'reference_audio',
          url: `character-voice://${voice.characterDocumentId}/${voice.versionId}`,
        })),
      ];
    else
      next.content = [
        ...content,
        ...voices.map((voice) => ({
          type: 'audio_url',
          audio_url: { url: `character-voice://${voice.characterDocumentId}/${voice.versionId}` },
          role: 'reference_audio',
        })),
      ];
  }
  const currentText = adapter.parameterSchema.properties.content
    ? records(next.content).find((item) => item.type === 'text')?.text
    : next.prompt;
  const additions = lines.filter(
    (line) => typeof currentText !== 'string' || !currentText.includes(line),
  );
  if (additions.length) {
    if (adapter.parameterSchema.properties.content) {
      const values = records(next.content);
      const text = values.find((item) => item.type === 'text')?.text;
      next.content = [
        {
          type: 'text',
          text: `${typeof text === 'string' ? text : ''}\n${additions.join('\n')}`.trim(),
        },
        ...values.filter((item) => item.type !== 'text'),
      ];
    } else if (adapter.parameterSchema.properties.prompt)
      next.prompt =
        `${typeof next.prompt === 'string' ? next.prompt : ''}\n${additions.join('\n')}`.trim();
  }
  return next;
}
