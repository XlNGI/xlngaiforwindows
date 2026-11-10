import type {
  AdapterDescriptor,
  AdapterParameters,
  AdapterParameterValue,
  CharacterVoiceReferenceInfo,
  ProductionImageSelection,
  ProductionInputImage,
  ShotInfo,
  SceneMaterialBindingInfo,
} from './index.js';
import { productionAudioSupport, productionImageRoleSupport } from './production-schema.js';
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
export interface ProductionShotReferenceIds {
  characterDocumentIds: string[];
  sceneDocumentIds: string[];
  propDocumentIds: string[];
}
/** Resolve one shot's document relationships; scene-owned bindings are never inherited. */
export function productionShotReferenceIds(
  shot: Pick<ShotInfo, 'bindings' | 'referenceBindings'>,
): ProductionShotReferenceIds {
  const references = shot?.bindings;
  return {
    characterDocumentIds: [
      ...new Set(
        references?.characterDocumentIds ??
          shot.referenceBindings?.characterBindings?.map(
            (binding) => binding.characterDocumentId,
          ) ??
          [],
      ),
    ],
    sceneDocumentIds: [
      ...new Set(
        references?.sceneDocumentIds ??
          shot.referenceBindings?.sceneBindings?.map((binding) => binding.sourceDocumentId) ??
          [],
      ),
    ],
    propDocumentIds: [...new Set(references?.propDocumentIds ?? [])],
  };
}
/**
 * Convert saved scene bindings into the ordered image selections consumed by
 * the production form and compiler. `prop`/`other` are generic references;
 * character and scene bindings retain their semantic roles for models that
 * support strict frame inputs.
 */
export function productionImageSelectionsFromBindings(
  bindings: SceneMaterialBindingInfo[] | undefined,
): ProductionImageSelection[] | undefined {
  if (!bindings) return undefined;
  return bindings.map(({ assetId, label, role }) => ({
    assetId,
    ...(role === 'character' || role === 'scene' ? { role } : { role: 'reference' as const }),
    ...(label ? { label } : {}),
  }));
}
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
    const role =
      kind === 'image_url'
        ? (item.role ?? (adapter.capability.endsWith('_TO_VIDEO') ? 'first_frame' : undefined))
        : kind;
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
          .map((url, index): ProductionInputImage => ({
            url,
            role:
              index === 0 && ['IMAGE_TO_VIDEO', 'START_END_TO_VIDEO'].includes(adapter.capability)
                ? 'first-frame'
                : index === 1 && adapter.capability === 'START_END_TO_VIDEO'
                  ? 'last-frame'
                  : 'reference',
          }))
      : []),
  ];
}
export interface ProductionImageBindingPromptEntry {
  imageIndex: number;
  role: ProductionImageSelection['role'];
  label?: string;
  /** A saved frame binding deliberately changed to an ordinary reference in the form. */
  frameAsReference?: boolean;
}
/**
 * A character-to-image reference resolved from the final ordered request.
 *
 * Wan's API only exposes media indexes inside the prompt, so the image
 * reference must be resolved after the form has assembled its actual media
 * order. Keeping the character document id here prevents the voice list
 * order from being confused with the character image order.
 */
export interface ProductionAudioImageBindingPromptEntry {
  characterDocumentId: string;
  imageReference: string;
}
function stripProductionPromptSection(prompt: string, marker: string): string {
  let result = prompt;
  let markerIndex = result.lastIndexOf(marker);
  while (markerIndex >= 0) {
    const lineStart = result.lastIndexOf('\n', markerIndex - 1) + 1;
    const start = lineStart > 0 && result[lineStart - 2] === '\n' ? lineStart - 1 : lineStart;
    const nextParagraph = result.indexOf('\n\n', markerIndex);
    const end = nextParagraph < 0 ? result.length : nextParagraph + 2;
    const before = result.slice(0, start).trimEnd();
    const after = result.slice(end).trimStart();
    result = [before, after].filter(Boolean).join('\n\n');
    markerIndex = result.lastIndexOf(marker);
  }
  return result.trimEnd();
}
export function stripProductionImageBindingPrompt(prompt: string): string {
  return stripProductionPromptSection(prompt, '【输入图片说明】');
}
export function stripProductionAudioBindingPrompt(prompt: string): string {
  return stripProductionPromptSection(prompt, '【输入音频说明】');
}
export function productionImageBindingPrompt(
  prompt: string,
  imageCount: number,
  bindings: ProductionImageBindingPromptEntry[],
  referenceForIndex: (index: number) => string = (index) => `图片${index}`,
): string {
  const base = stripProductionImageBindingPrompt(prompt);
  if (!imageCount || !bindings.length) return base;
  const lines = bindings.map(({ imageIndex, role, label, frameAsReference }) => {
    const name = label?.trim();
    const description =
      role === 'character'
        ? name
          ? `角色「${name}」的角色参考图`
          : '出场角色的角色参考图'
        : role === 'scene'
          ? name
            ? `场景「${name}」的场景参考图`
            : '当前场景的场景参考图'
          : role === 'first-frame'
            ? frameAsReference
              ? '本镜视频的开场构图参考（不锁定首帧）'
              : '本镜视频的首帧'
            : role === 'last-frame'
              ? frameAsReference
                ? '本镜视频的结束构图参考（不锁定尾帧）'
                : '本镜视频的尾帧'
              : name
                ? `参考素材「${name}」`
                : `第${imageIndex}张参考图`;
    return `${referenceForIndex(imageIndex)}为${description}。`;
  });
  const section = `【输入图片说明】（本段传入${imageCount}张参考图）：\n${lines.join('\n')}`;
  return `${base}${base ? '\n\n' : ''}${section}`;
}
export function productionAudioBindingPrompt(
  prompt: string,
  voices: CharacterVoiceReferenceInfo[],
  imageBindings: ProductionAudioImageBindingPromptEntry[] = [],
): string {
  const base = stripProductionAudioBindingPrompt(prompt);
  if (!voices.length) return base;
  const imageReferenceByCharacter = new Map(
    imageBindings.map((binding) => [binding.characterDocumentId, binding.imageReference]),
  );
  const lines = voices.map((voice, index) => {
    const imageReference = imageReferenceByCharacter.get(voice.characterDocumentId);
    return imageReference
      ? `${imageReference}中的角色「${voice.characterName}」仅使用音频${index + 1}的音色。`
      : `角色「${voice.characterName}」使用音频${index + 1}的音色。`;
  });
  const section = `【输入音频说明】（本段传入${voices.length}段角色音色参考）：\n${lines.join('\n')}`;
  return `${base}${base ? '\n\n' : ''}${section}`;
}
/** Resolve character image references from the request's final image order. */
export function productionAudioImageBindings(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  bindings: SceneMaterialBindingInfo[] = [],
): ProductionAudioImageBindingPromptEntry[] {
  const images = productionImagesFromParameters(adapter, parameters);
  const indexesByUrl = new Map<string, number[]>();
  images.forEach(({ url }, index) => {
    const canonicalUrl = canonical(url);
    indexesByUrl.set(canonicalUrl, [...(indexesByUrl.get(canonicalUrl) ?? []), index + 1]);
  });
  const usedOccurrences = new Map<string, number>();
  return bindings.flatMap((binding) => {
    if (binding.role !== 'character' || !binding.sourceDocumentId) return [];
    const url = canonical(`project-asset://${binding.assetId}`);
    const indexes = indexesByUrl.get(url) ?? [];
    const occurrence = usedOccurrences.get(url) ?? 0;
    const imageIndex = indexes[occurrence];
    const imageReference =
      imageIndex === undefined
        ? undefined
        : (productionImageReference(adapter, imageIndex) ?? `图片${imageIndex}`);
    if (!imageReference) return [];
    usedOccurrences.set(url, occurrence + 1);
    return [{ characterDocumentId: binding.sourceDocumentId, imageReference }];
  });
}
/** Keep role voice declarations visible in the authored prompt and the submitted request. */
export function addProductionAudioBindings(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  voices: CharacterVoiceReferenceInfo[],
  imageBindings: ProductionAudioImageBindingPromptEntry[] = [],
): AdapterParameters {
  const properties = adapter.parameterSchema.properties;
  if (!properties.prompt && !properties.content) return parameters;
  if (properties.content) {
    const content = records(parameters.content);
    const textIndex = content.findIndex((item) => item.type === 'text');
    const textValue = content[textIndex]?.text;
    const prompt = typeof textValue === 'string' ? textValue : '';
    const nextPrompt = productionAudioBindingPrompt(prompt, voices, imageBindings);
    if (!nextPrompt && textIndex < 0) return parameters;
    if (nextPrompt === prompt && textIndex >= 0) return parameters;
    const nextContent = [...content];
    if (textIndex < 0) nextContent.unshift({ type: 'text', text: nextPrompt });
    else nextContent[textIndex] = { ...nextContent[textIndex]!, text: nextPrompt };
    return { ...parameters, content: nextContent };
  }
  const prompt = typeof parameters.prompt === 'string' ? parameters.prompt : '';
  const nextPrompt = productionAudioBindingPrompt(prompt, voices, imageBindings);
  return nextPrompt === prompt ? parameters : { ...parameters, prompt: nextPrompt };
}
/** Add role declarations from the bound asset IDs and the final model input order. */
export function addProductionImageBindings(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  bindings: ProductionImageSelection[],
): AdapterParameters {
  const properties = adapter.parameterSchema.properties;
  if (!properties.prompt && !properties.content) return parameters;
  const images = productionImagesFromParameters(adapter, parameters);
  const indexesByUrl = new Map<string, number[]>();
  images.forEach(({ url }, index) => {
    const canonicalUrl = canonical(url);
    indexesByUrl.set(canonicalUrl, [...(indexesByUrl.get(canonicalUrl) ?? []), index + 1]);
  });
  const usedOccurrences = new Map<string, number>();
  const mapped = bindings.flatMap(({ assetId, role, label }) => {
    const url = canonical(`project-asset://${assetId}`);
    const indexes = indexesByUrl.get(url) ?? [];
    const occurrence = usedOccurrences.get(url) ?? 0;
    const imageIndex = indexes[occurrence];
    if (imageIndex === undefined) return [];
    usedOccurrences.set(url, occurrence + 1);
    const actualRole = images[imageIndex - 1]?.role;
    const structured = Boolean(properties.media || properties.content);
    return [
      {
        imageIndex,
        role:
          structured && (actualRole === 'first-frame' || actualRole === 'last-frame')
            ? actualRole
            : role,
        label,
        frameAsReference:
          structured &&
          actualRole === 'reference' &&
          (role === 'first-frame' || role === 'last-frame'),
      },
    ];
  });
  const referenceForIndex = (index: number) =>
    productionImageReference(adapter, index) ?? `图片${index}`;
  if (properties.content) {
    const content = records(parameters.content);
    const textIndex = content.findIndex((item) => item.type === 'text');
    const textValue = content[textIndex]?.text;
    const prompt = typeof textValue === 'string' ? textValue : '';
    const nextPrompt = productionImageBindingPrompt(
      prompt,
      images.length,
      mapped,
      referenceForIndex,
    );
    if (!nextPrompt && textIndex < 0) return parameters;
    const nextContent = [...content];
    if (textIndex < 0) nextContent.unshift({ type: 'text', text: nextPrompt });
    else nextContent[textIndex] = { ...nextContent[textIndex]!, text: nextPrompt };
    return { ...parameters, content: nextContent };
  }
  const prompt = typeof parameters.prompt === 'string' ? parameters.prompt : '';
  const nextPrompt = productionImageBindingPrompt(prompt, images.length, mapped, referenceForIndex);
  return nextPrompt === prompt ? parameters : { ...parameters, prompt: nextPrompt };
}
/** One canonical model-input projector used by Desktop, Worker and Agent. */
export function seedProductionInputs(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  prompt?: string,
  images?: ProductionInputImage[],
): AdapterParameters {
  const next = { ...parameters };
  const properties = adapter.parameterSchema.properties;
  const known = images?.map((image) => ({ ...image, url: canonical(image.url) }));
  const frames =
    adapter.capability === 'IMAGE_TO_VIDEO' || adapter.capability === 'START_END_TO_VIDEO';
  if (frames && known?.some((image) => image.role && image.role !== 'reference')) {
    const first = known.find((image) => image.role === 'first-frame');
    if (known.length && !first)
      throw new Error('当前生成方式需要本镜首帧；角色与场景参考图不能自动当作首帧。');
  }
  // Explicit purposes are never discarded or changed to satisfy a model. The
  // form/schema reports incompatible combinations so the user can choose.
  const role = (image: ProductionInputImage, index: number) =>
    image.role
      ? image.role === 'first-frame'
        ? 'first_frame'
        : image.role === 'last-frame'
          ? 'last_frame'
          : 'reference_image'
      : frames
        ? index === 0
          ? 'first_frame'
          : 'last_frame'
        : 'reference_image';
  if (properties.media) {
    delete next.images;
    if (prompt !== undefined && properties.prompt) next.prompt = prompt;
    if (known !== undefined)
      next.media = [
        ...known.map((image, index) => ({ type: role(image, index), url: image.url })),
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
      ...(known !== undefined
        ? known.map((image, index) => ({
            type: 'image_url',
            image_url: { url: image.url },
            role: role(image, index),
          }))
        : content.filter((item) => item.type === 'image_url')),
      ...content.filter((item) => item.type !== 'text' && item.type !== 'image_url'),
    ];
    delete next.prompt;
  } else {
    if (prompt !== undefined && properties.prompt) next.prompt = prompt;
    if (known !== undefined && properties.images) next.images = known.map((image) => image.url);
  }
  return next;
}
/** Conflict in the current form, rather than in the saved source bindings. */
export function productionFrameInputConflict(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  bindings: ProductionImageSelection[] = [],
):
  | {
      field: 'media' | 'content' | 'images';
      canUseReferences: boolean;
      firstFrameIndex: number;
    }
  | undefined {
  const properties = adapter.parameterSchema.properties;
  const field = properties.media ? 'media' : properties.content ? 'content' : 'images';
  const support = productionImageRoleSupport(adapter);
  const images = productionImagesFromParameters(adapter, parameters);
  if (field === 'images') {
    if (!['IMAGE_TO_VIDEO', 'START_END_TO_VIDEO'].includes(adapter.capability)) return;
    const limit =
      properties.images?.maxItems ?? (adapter.capability === 'START_END_TO_VIDEO' ? 2 : 1);
    if (images.length <= limit) return;
    const sourceFrame = bindings.find((image) => image.role === 'first-frame');
    const firstFrameIndex = sourceFrame
      ? images.findIndex(
          (image) => canonical(image.url) === `project-asset://${sourceFrame.assetId}`,
        )
      : 0;
    return { field, canUseReferences: false, firstFrameIndex };
  }
  const items = records(parameters[field]);
  const roles = items.map((item) =>
    field === 'media'
      ? item.type
      : (item.role ?? (item.type === 'image_url' ? 'first_frame' : undefined)),
  );
  if (
    !support.exclusive ||
    !roles.some((role) => role === 'first_frame' || role === 'last_frame') ||
    !roles.some((role) => typeof role === 'string' && role.startsWith('reference_'))
  )
    return;
  return {
    field,
    canUseReferences: support.references,
    firstFrameIndex: images.findIndex((image) => image.role === 'first-frame'),
  };
}
/** Explicit user choice; all other form fields and the source bindings are untouched. */
export function resolveProductionFrameInputs(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  choice: 'references' | 'first-frame',
  bindings: ProductionImageSelection[] = [],
): AdapterParameters {
  const conflict = productionFrameInputConflict(adapter, parameters, bindings);
  if (
    !conflict ||
    (choice === 'references' && !conflict.canUseReferences) ||
    (choice === 'first-frame' && conflict.firstFrameIndex < 0)
  )
    return parameters;
  const { field } = conflict;
  if (field === 'images')
    return {
      ...parameters,
      images: [productionImagesFromParameters(adapter, parameters)[conflict.firstFrameIndex]!.url],
    };
  let imageIndex = 0;
  const items = records(parameters[field]).flatMap((item) => {
    const image =
      field === 'content'
        ? item.type === 'image_url'
        : ['first_frame', 'last_frame', 'reference_image'].includes(tag(item.type));
    if (image) {
      const keep = imageIndex++ === conflict.firstFrameIndex;
      if (choice === 'first-frame') return keep ? [item] : [];
      return [{ ...item, [field === 'content' ? 'role' : 'type']: 'reference_image' }];
    }
    // "Only first frame" explicitly removes other reference media, retaining text.
    return choice === 'first-frame' && item.type !== 'text' ? [] : [item];
  });
  return { ...parameters, [field]: items };
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
  const audioImageBindings = productionAudioImageBindings(adapter, next, imageBindings);
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
    const selectedUrls = voices.map(
      (voice) => `character-voice://${voice.characterDocumentId}/${voice.versionId}`,
    );
    const existingUrls = adapter.parameterSchema.properties.media
      ? media.filter((item) => item.type === 'reference_audio').map((item) => item.url)
      : content
          .filter((item) => item.type === 'audio_url')
          .map((item) => (item.audio_url as Record<string, AdapterParameterValue>)?.url);
    const alreadyProjected =
      existingUrls.length === selectedUrls.length &&
      existingUrls.every((url, index) => url === selectedUrls[index]);
    if (existingUrls.length && !alreadyProjected)
      throw new Error('请使用角色声音选择或手动参考音频其中一种，避免音频编号不明确。');
    if (!alreadyProjected && adapter.parameterSchema.properties.media)
      next.media = [
        ...records(next.media),
        ...voices.map((voice) => ({
          type: 'reference_audio',
          url: `character-voice://${voice.characterDocumentId}/${voice.versionId}`,
        })),
      ];
    else if (!alreadyProjected)
      next.content = [
        ...content,
        ...voices.map((voice) => ({
          type: 'audio_url',
          audio_url: { url: `character-voice://${voice.characterDocumentId}/${voice.versionId}` },
          role: 'reference_audio',
        })),
      ];
  }
  const audioBound = addProductionAudioBindings(adapter, next, voices, audioImageBindings);
  const currentText = adapter.parameterSchema.properties.content
    ? records(audioBound.content).find((item) => item.type === 'text')?.text
    : audioBound.prompt;
  const additions = lines.filter(
    (line) => typeof currentText !== 'string' || !currentText.includes(line),
  );
  if (!additions.length) return audioBound;
  if (adapter.parameterSchema.properties.content) {
    const values = records(audioBound.content);
    const text = values.find((item) => item.type === 'text')?.text;
    audioBound.content = [
      {
        type: 'text',
        text: `${typeof text === 'string' ? text : ''}\n${additions.join('\n')}`.trim(),
      },
      ...values.filter((item) => item.type !== 'text'),
    ];
  } else if (adapter.parameterSchema.properties.prompt)
    audioBound.prompt =
      `${typeof audioBound.prompt === 'string' ? audioBound.prompt : ''}\n${additions.join('\n')}`.trim();
  return audioBound;
}
