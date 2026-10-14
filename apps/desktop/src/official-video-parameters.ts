import type {
  AdapterDescriptor,
  AdapterParameters,
  AdapterParameterValue,
  CharacterVoiceReferenceInfo,
} from '@ai-video/contracts';

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
type OfficialVideoAdapter = Pick<AdapterDescriptor, 'provider' | 'contractId' | 'capability'>;

export function seedOfficialVideoParameters(
  adapter: OfficialVideoAdapter,
  parameters: AdapterParameters,
  prompt?: string,
  images: string[] = [],
): AdapterParameters {
  images = images.map((value) =>
    value.startsWith('asset://') ? value.replace('asset://', 'project-asset://') : value,
  );
  const next = structuredClone(parameters);
  delete next.images;
  if (adapter.provider === 'wan-video') {
    if (prompt) next.prompt = prompt;
    if (images.length)
      next.media = images.map((url, index) => ({
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
      }));
  } else {
    const content = records(next.content);
    const previous = content.filter((item) => item.type !== 'text' && item.type !== 'image_url');
    const text = prompt ?? content.find((item) => item.type === 'text')?.text;
    next.content = [
      ...(typeof text === 'string' && text ? [{ type: 'text', text }] : []),
      ...(images.length
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
): AdapterParameters {
  const next = structuredClone(parameters);
  if (adapter.contractId?.includes('wan2-7')) {
    if (dialogueAudioId)
      next.media = [
        ...records(next.media).filter((item) => item.type !== 'driving_audio'),
        { type: 'driving_audio', url: `project-audio://${dialogueAudioId}` },
      ];
    return next;
  }
  if (!voices.length) return next;
  const extra = voices
    .map((voice, index) => `角色「${voice.characterName}」使用音频${index + 1}的音色。`)
    .join('\n');
  if (adapter.provider === 'wan-video') {
    const media = records(next.media);
    if (media.some((item) => item.type === 'first_frame' || item.type === 'last_frame'))
      throw new Error('严格首尾帧与声音参考不能混用，请切换为参考图片模式。');
    if (media.some((item) => item.type === 'reference_audio'))
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
      content.some(
        (item) =>
          item.role === 'first_frame' ||
          item.role === 'last_frame' ||
          (item.type === 'image_url' && !item.role),
      )
    )
      throw new Error('严格首尾帧与声音参考不能混用，请切换为参考图片模式。');
    if (content.some((item) => item.type === 'audio_url'))
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
