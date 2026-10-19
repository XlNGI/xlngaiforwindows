import {
  renderProductionInstruction,
  type AdapterDescriptor,
  type ProductionInstruction,
  type ProductionIssue,
  type ProductionSegment,
  type ProductionTimelineEntry,
  type SceneInfo,
  type ShotInfo,
} from '@ai-video/contracts';
import { resolveProductionDuration } from '@ai-video/generation-adapters';

export function inheritProductionInstruction(
  parent: ProductionInstruction,
  shot: ProductionInstruction,
): ProductionInstruction {
  const defaults = { ...parent.generation };
  delete defaults.duration;
  return {
    ...shot,
    storyTime: shot.storyTime ?? parent.storyTime,
    location: parent.location ? { ...parent.location, ...shot.location } : shot.location,
    style: { ...parent.style, ...shot.style },
    visual: { ...parent.visual, ...shot.visual },
    camera: { ...parent.camera, ...shot.camera },
    lightingDesign: { ...parent.lightingDesign, ...shot.lightingDesign },
    subjects: shot.subjects.map((subject) => ({
      ...parent.subjects.find((item) => item.documentId === subject.documentId),
      ...subject,
    })),
    generation: { ...defaults, ...shot.generation },
    resources: [...parent.resources, ...shot.resources].filter(
      (item, index, all) =>
        all.findIndex(
          (other) =>
            other.kind === item.kind &&
            other.documentId === item.documentId &&
            other.assetId === item.assetId,
        ) === index,
    ),
  };
}

export function emptyProductionInstruction(summary: string): ProductionInstruction {
  return {
    version: 1,
    summary,
    subjects: [],
    visual: {},
    beats: [],
    audio: { mode: 'auto' },
    generation: {},
    resources: [],
    continuity: { predecessors: [], before: [], after: [], locked: [], constraints: [] },
  };
}

export function compileSceneSequence(
  scene: SceneInfo,
  shared: ProductionInstruction,
  shots: Array<{ shot: ShotInfo; instruction?: ProductionInstruction }>,
  names: Record<string, string>,
  options: { sharedText?: string; isSegment?: boolean } = {},
) {
  const timeline: ProductionTimelineEntry[] = [];
  const issues: ProductionIssue[] = [];
  let cursor: number | undefined = 0;
  const resources = [...shared.resources];
  let audio = shared.audio;
  const modes = ['auto', 'silent', 'native', 'voice-reference', 'dialogue-driven'];
  const states = new Map(shared.continuity.before.map((fact) => [fact.key, fact.value]));
  const locked = new Map(shared.continuity.locked.map((fact) => [fact.key, fact.value]));
  for (const { shot, instruction } of shots) {
    const effective = instruction ? inheritProductionInstruction(shared, instruction) : undefined;
    const seconds =
      instruction?.timing?.estimatedDurationSeconds ?? instruction?.generation.duration;
    const overlap =
      options.isSegment && timeline.length === 0
        ? 0
        : (instruction?.transition?.overlapSeconds ?? 0);
    const previous = timeline.at(-1);
    if (
      overlap &&
      (!previous ||
        seconds === undefined ||
        previous.estimatedDurationSeconds === undefined ||
        overlap >= seconds ||
        overlap >= previous.estimatedDurationSeconds)
    )
      issues.push({
        code: 'INVALID_TRANSITION_TIMING',
        message: `分镜「${shot.title}」的转场重叠时间无效。`,
      });
    const start: number | undefined =
      cursor === undefined ? undefined : Math.max(0, cursor - overlap);
    const end: number | undefined =
      start !== undefined && seconds !== undefined
        ? Math.round((start + seconds) * 1000) / 1000
        : undefined;
    timeline.push({
      shotId: shot.id,
      title: shot.title,
      startSeconds: start,
      endSeconds: end,
      estimatedDurationSeconds: seconds,
      prompt: effective
        ? renderProductionInstruction(effective, names)
        : (shot.prompt ?? '分镜内容待补充'),
    });
    cursor = end;
    if (shared.version === 2 && !instruction?.timing)
      issues.push({
        code: 'MISSING_SHOT_TIMING',
        message: `分镜「${shot.title}」缺少结构化剧情时长，请补充，系统不会按固定秒数凑时长。`,
      });
    if (effective) {
      resources.push(...effective.resources);
      if (modes.indexOf(effective.audio.mode) > modes.indexOf(audio.mode))
        audio = { ...shared.audio, ...effective.audio };
      for (const fact of effective.continuity.before)
        if (states.has(fact.key) && states.get(fact.key) !== fact.value)
          issues.push({
            code: 'CONTINUITY_CONFLICT',
            message: `分镜「${shot.title}」的开始状态 ${fact.key} 与前镜结束状态冲突。`,
          });
      for (const fact of [...effective.continuity.before, ...effective.continuity.after]) {
        if (locked.has(fact.key) && locked.get(fact.key) !== fact.value)
          issues.push({
            code: 'LOCKED_FACT_CHANGED',
            message: `分镜「${shot.title}」改变了整场锁定状态 ${fact.key}。`,
          });
        states.set(fact.key, fact.value);
      }
      for (const fact of effective.continuity.locked) locked.set(fact.key, fact.value);
    }
  }
  const estimatedDurationSeconds = timeline.length
    ? cursor
    : shared.timing?.estimatedDurationSeconds;
  const prompt = [
    `【场次：${scene.title}】`,
    options.sharedText ?? renderProductionInstruction({ ...shared, audio }, names),
    estimatedDurationSeconds === undefined
      ? '剧情预计时长：待补充；保留全部分镜。'
      : `${options.isSegment ? '本段' : '整场'}剧情预计时长：${estimatedDurationSeconds}秒（由分镜内容推导）。`,
    ...timeline.map(
      (entry, index) =>
        `【镜头${String(index + 1).padStart(2, '0')}：${entry.title}｜${entry.startSeconds === undefined || entry.endSeconds === undefined ? '时间待补充' : `${entry.startSeconds}—${entry.endSeconds}秒`}】\n${entry.prompt}`,
    ),
  ].join('\n\n');
  const instruction = {
    ...shared,
    audio,
    resources: resources.filter(
      (item, index, all) =>
        all.findIndex(
          (other) =>
            other.kind === item.kind &&
            other.documentId === item.documentId &&
            other.assetId === item.assetId,
        ) === index,
    ),
  };
  return { instruction, compiledPrompt: prompt, timeline, estimatedDurationSeconds, issues };
}

/** Plans production units without changing scene membership, wording or story timing. */
export function planProductionSegments(
  timeline: ProductionTimelineEntry[],
  adapter: AdapterDescriptor,
): ProductionSegment[] {
  if (!adapter.parameterSchema.properties.duration) return [];
  const segments: ProductionSegment[] = [];
  for (const [index, entry] of timeline.entries()) {
    const seconds = entry.estimatedDurationSeconds;
    if (seconds === undefined) return [];
    const last = segments.at(-1);
    const previous = timeline[index - 1];
    const overlap =
      previous?.endSeconds !== undefined && entry.startSeconds !== undefined
        ? Math.max(0, previous.endSeconds - entry.startSeconds)
        : 0;
    const combined = last
      ? Math.round((last.estimatedDurationSeconds + seconds - overlap) * 1000) / 1000
      : seconds;
    const requested = resolveProductionDuration(adapter, combined);
    if (last && !last.needsShotRevision && requested !== undefined) {
      last.shotIds.push(entry.shotId);
      last.estimatedDurationSeconds = combined;
      last.requestedDurationSeconds = requested;
    } else {
      const duration = resolveProductionDuration(adapter, seconds);
      segments.push({
        shotIds: [entry.shotId],
        estimatedDurationSeconds: seconds,
        requestedDurationSeconds: duration,
        ...(duration === undefined ? { needsShotRevision: true } : {}),
      });
    }
  }
  return segments;
}
