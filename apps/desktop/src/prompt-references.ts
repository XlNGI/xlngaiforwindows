import {
  productionImageReference,
  type AdapterDescriptor,
  type AdapterParameters,
} from '@ai-video/contracts';

export interface PromptReference {
  id: string;
  kind: 'image' | 'audio' | 'video';
  url: string;
  label: string;
  text: string;
  aliases: string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Labels come from actual transport order, never from names mentioned in prose. */
export function promptReferences(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
): PromptReference[] {
  const inputs: Array<{ kind: PromptReference['kind']; url: string; role: string }> = [];
  const properties = adapter.parameterSchema.properties;
  const items = properties.media ? parameters.media : properties.content ? parameters.content : [];
  if (Array.isArray(items))
    for (const value of items) {
      const item = record(value);
      const type = typeof item.type === 'string' ? item.type : '';
      const kind = ['reference_image', 'first_frame', 'last_frame', 'image_url'].includes(type)
        ? 'image'
        : ['reference_audio', 'driving_audio', 'audio_url'].includes(type)
          ? 'audio'
          : ['reference_video', 'first_clip', 'video_url'].includes(type)
            ? 'video'
            : undefined;
      const url = type.endsWith('_url') ? record(item[type]).url : item.url;
      if (kind && typeof url === 'string' && url.trim())
        inputs.push({ kind, url, role: typeof item.role === 'string' ? item.role : type });
    }
  if (Array.isArray(parameters.images))
    for (const url of parameters.images)
      if (typeof url === 'string' && url.trim())
        inputs.push({ kind: 'image', url, role: 'reference_image' });
  if (typeof parameters.video === 'string' && parameters.video.trim())
    inputs.push({ kind: 'video', url: parameters.video, role: 'reference_video' });
  const counts = { image: 0, audio: 0, video: 0 };
  const occurrences = new Map<string, number>();
  return inputs.map(({ kind, url, role }) => {
    const index = ++counts[kind];
    const prefix = kind === 'image' ? '图片' : kind === 'audio' ? '音频' : '视频';
    const text =
      kind === 'image'
        ? (productionImageReference(adapter, index) ?? `图${index}`)
        : `${prefix}${index}`;
    const identity = `${kind}:${role}:${url.replace(/^asset:\/\//u, 'project-asset://')}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return {
      id: `${identity}:${occurrence}`,
      kind,
      url,
      label: `${prefix} ${index}`,
      text,
      aliases: [
        ...new Set([
          text,
          `${prefix}${index}`,
          `${prefix} ${index}`,
          ...(kind === 'image' ? [`图${index}`, `图 ${index}`] : []),
        ]),
      ],
    };
  });
}

export type PromptPart = { text: string; reference?: PromptReference };
export function splitPromptReferences(text: string, references: PromptReference[]): PromptPart[] {
  const aliases = new Map(
    references.flatMap((reference) =>
      reference.aliases.map((alias) => [alias, reference] as const),
    ),
  );
  if (!aliases.size) return [{ text }];
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const matcher = new RegExp(
    `(?:${[...aliases.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join('|')})(?![0-9])`,
    'gu',
  );
  const parts: PromptPart[] = [];
  let end = 0;
  for (const match of text.matchAll(matcher)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ text: match[0], reference: aliases.get(match[0]) });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts.length ? parts : [{ text }];
}

function rewritePromptParameters(
  parameters: AdapterParameters,
  rewrite: (text: string) => string,
): AdapterParameters {
  const next = { ...parameters };
  if (typeof next.prompt === 'string') next.prompt = rewrite(next.prompt);
  if (Array.isArray(next.content))
    next.content = next.content.map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'text' &&
        typeof item.text === 'string'
      )
        return { ...item, text: rewrite(item.text) };
      return item;
    });
  return next;
}

/** HTML never enters the transport. Resolve display aliases using the final input order. */
export function canonicalPromptParameters(
  parameters: AdapterParameters,
  references: PromptReference[],
): AdapterParameters {
  return rewritePromptParameters(parameters, (text) =>
    splitPromptReferences(text, references)
      .map((part) => part.reference?.text ?? part.text)
      .join(''),
  );
}

/** Change media and prompt in one state update, so an old number cannot bind a new item. */
export function remapPromptReferences(
  before: PromptReference[],
  after: PromptReference[],
  parameters: AdapterParameters,
): AdapterParameters {
  if (before.length === after.length && before.every((item, index) => item.id === after[index]?.id))
    return parameters;
  const byId = new Map(after.map((item) => [item.id, item]));
  const rewrite = (text: string) =>
    splitPromptReferences(text, before)
      .map((part) => (part.reference ? (byId.get(part.reference.id)?.text ?? '') : part.text))
      .join('');
  return rewritePromptParameters(parameters, rewrite);
}

export function updatePromptParameter(
  adapter: AdapterDescriptor,
  parameters: AdapterParameters,
  key: string,
  value: AdapterParameters[string] | undefined,
): AdapterParameters {
  const next = { ...parameters };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  return remapPromptReferences(
    promptReferences(adapter, parameters),
    promptReferences(adapter, next),
    next,
  );
}
