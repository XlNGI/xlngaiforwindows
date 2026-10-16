import type {
  AdapterDescriptor,
  AdapterParameters,
  AdapterParameterValue,
  CharacterVoiceReferenceInfo,
  SceneMaterialBindingInfo,
} from '@ai-video/contracts';
import { productionImageReference } from '@ai-video/contracts';

export const isOfficialVoiceVideo = (adapter: AdapterDescriptor | undefined) =>
  Boolean(adapter && ['wan-video', 'seedance-video', 'minimax-video'].includes(adapter.provider));
const records = (
  value: AdapterParameterValue | undefined,
): Array<Record<string, AdapterParameterValue>> =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, AdapterParameterValue> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)),
      )
    : [];
type OfficialVideoAdapter = Pick<AdapterDescriptor, 'provider' | 'contractId' | 'capability'> & {
  contractRevision?: number;
};

export function seedOfficialVideoParameters(
  adapter: OfficialVideoAdapter,
  parameters: AdapterParameters,
  prompt?: string,
  images: string[] = [],
  replaceImages = false,
): AdapterParameters {
  images = images.map((value) =>
    value.startsWith('asset://') ? value.replace('asset://', 'project-asset://') : value,
  );
  const next = structuredClone(parameters);
  delete next.images;
  if (adapter.provider === 'wan-video') {
    if (prompt) next.prompt = prompt;
    if (images.length || replaceImages)
      next.media = [
        ...images.map((url, index) => ({
          type: adapter.contractId?.includes('wan2-7')
            ? index === 0
              ? 'first_frame'
              : 'last_frame'
            : adapter.capability === 'START_END_TO_VIDEO'
              ? index === 0
                ? 'first_frame'
                : 'last_frame'
              : 'reference_image',
          url,
        })),
        ...records(next.media).filter(
          (item) =>
            typeof item.type !== 'string' ||
            !['reference_image', 'first_frame', 'last_frame'].includes(item.type),
        ),
      ];
  } else {
    const content = records(next.content);
    const previous = content.filter((item) => item.type !== 'text' && item.type !== 'image_url');
    const text = prompt ?? content.find((item) => item.type === 'text')?.text;
    next.content = [
      ...(typeof text === 'string' && text ? [{ type: 'text', text }] : []),
      ...(images.length || replaceImages
        ? images.map((url, index) => ({
            type: 'image_url',
            image_url: { url },
            role:
              adapter.capability === 'START_END_TO_VIDEO'
                ? index === 0
                  ? 'first_frame'
                  : 'last_frame'
                : 'reference_image',
          }))
        : content.filter((item) => item.type === 'image_url')),
      ...previous,
    ];
    delete next.prompt;
  }
  return next;
}

/** Only explicitly selected roles add voice references to the production request. */
export function addOfficialRoleVoices(
  adapter: OfficialVideoAdapter,
  parameters: AdapterParameters,
  voices: CharacterVoiceReferenceInfo[],
  dialogueAudioId?: string,
  imageBindings: SceneMaterialBindingInfo[] = [],
): AdapterParameters {
  const next = structuredClone(parameters);
  const imageUrls =
    adapter.provider === 'wan-video'
      ? records(next.media)
          .filter(
            (item) =>
              typeof item.type === 'string' &&
              ['reference_image', 'first_frame', 'last_frame'].includes(item.type),
          )
          .map((item) => item.url)
      : records(next.content)
          .filter((item) => item.type === 'image_url')
          .map((item) => (item.image_url as Record<string, AdapterParameterValue>)?.url);
  const canonical = (value: unknown) =>
    typeof value === 'string' ? value.replace(/^asset:\/\//u, 'project-asset://') : '';
  const imageLines = imageBindings.flatMap((binding) => {
    const index = imageUrls.findIndex(
      (url) => canonical(url) === `project-asset://${binding.assetId}`,
    );
    const reference = productionImageReference(adapter, index + 1);
    return index < 0 || !reference
      ? []
      : [
          `${binding.role === 'character' ? '角色' : binding.role === 'scene' ? '场景' : '素材'}「${binding.label}」参考${reference}。`,
        ];
  });
  if (adapter.contractId?.includes('wan2-7')) {
    if (dialogueAudioId)
      next.media = [
        ...records(next.media).filter((item) => item.type !== 'driving_audio'),
        { type: 'driving_audio', url: `project-audio://${dialogueAudioId}` },
      ];
    if (voices.length) throw new Error('万相 2.7 使用完整对白，不能提交角色音色参考。');
    if (imageLines.length)
      next.prompt =
        `${typeof next.prompt === 'string' ? next.prompt : ''}\n${imageLines.join('\n')}`.trim();
    return next;
  }
  const extra = [
    ...imageLines,
    ...voices.map((voice, index) => `角色「${voice.characterName}」使用音频${index + 1}的音色。`),
  ].join('\n');
  if (!extra) return next;
  if (adapter.provider === 'wan-video') {
    const media = records(next.media);
    if (
      voices.length &&
      media.some((item) => item.type === 'first_frame' || item.type === 'last_frame')
    )
      throw new Error('严格首尾帧与声音参考不能混用，请切换为参考图片模式。');
    if (voices.length && media.some((item) => item.type === 'reference_audio'))
      throw new Error('请使用角色声音选择或手动参考音频其中一种，避免音频编号不明确。');
    next.media = [
      ...media,
      ...voices.map((voice) => ({
        type: 'reference_audio',
        url: `character-voice://${voice.characterDocumentId}/${voice.versionId}`,
      })),
    ];
    next.prompt = `${typeof next.prompt === 'string' ? next.prompt : ''}\n${extra}`.trim();
  } else {
    const content = records(next.content);
    if (
      voices.length &&
      content.some(
        (item) =>
          item.role === 'first_frame' ||
          item.role === 'last_frame' ||
          (item.type === 'image_url' && !item.role),
      )
    )
      throw new Error('严格首尾帧与声音参考不能混用，请切换为参考图片模式。');
    if (voices.length && content.some((item) => item.type === 'audio_url'))
      throw new Error('请使用角色声音选择或手动参考音频其中一种，避免音频编号不明确。');
    const text = content.find((item) => item.type === 'text');
    next.content = [
      { type: 'text', text: `${typeof text?.text === 'string' ? text.text : ''}\n${extra}`.trim() },
      ...content.filter((item) => item.type !== 'text'),
      ...voices.map((voice) => ({
        type: 'audio_url',
        audio_url: { url: `character-voice://${voice.characterDocumentId}/${voice.versionId}` },
        role: 'reference_audio',
      })),
    ];
  }
  return next;
}
