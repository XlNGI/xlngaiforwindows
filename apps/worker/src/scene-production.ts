import {
  renderProductionInstruction,
  seedProductionFacts,
  applyProductionFacts,
  type AdapterDescriptor,
  type ProductionInstruction,
  type ProductionIssue,
  type ProductionSegment,
  type ProductionTimelineEntry,
  type SceneInfo,
  type ShotInfo,
  productionCharacterIds,
} from '@ai-video/contracts';
import { resolveProductionDuration } from '@ai-video/generation-adapters';

export function inheritProductionInstruction(
  parent: ProductionInstruction,
  shot: ProductionInstruction,
): ProductionInstruction {
  const defaults = { ...parent.generation };
  delete defaults.duration;
  const characterIds = productionCharacterIds(shot);
  const parentSubjects = new Map(parent.subjects.map((subject) => [subject.documentId, subject]));
  const shotSubjects = new Map(shot.subjects.map((subject) => [subject.documentId, subject]));
  const inheritedSubjects =
    characterIds === undefined
      ? shot.subjects.map((subject) => ({
          ...stableSubject(parentSubjects.get(subject.documentId)),
          ...subject,
        }))
      : characterIds.map((documentId) => ({
          documentId,
          ...stableSubject(parentSubjects.get(documentId)),
          ...shotSubjects.get(documentId),
        }));
  const inheritedCamera = { ...parent.camera };
  // Scene camera fields describe one framing/setup unless a shot says more.
  // One-off movement and frame endpoints belong to the shot that authored them.
  delete inheritedCamera.movement;
  delete inheritedCamera.speed;
  delete inheritedCamera.amplitude;
  delete inheritedCamera.startFrame;
  delete inheritedCamera.endFrame;
  return {
    ...shot,
    storyTime: shot.storyTime ?? parent.storyTime,
    location: parent.location ? { ...parent.location, ...shot.location } : shot.location,
    style: { ...parent.style, ...shot.style },
    visual: { ...parent.visual, ...shot.visual },
    camera: { ...inheritedCamera, ...shot.camera },
    lightingDesign: { ...parent.lightingDesign, ...shot.lightingDesign },
    subjects: inheritedSubjects,
    reviewNotes: [...new Set([...(parent.reviewNotes ?? []), ...(shot.reviewNotes ?? [])])],
    generation: { ...defaults, ...shot.generation },
    resources: [
      ...parent.resources.filter(
        (resource) =>
          characterIds === undefined ||
          !['character-image', 'voice-reference'].includes(resource.kind) ||
          !resource.documentId ||
          characterIds.includes(resource.documentId),
      ),
      ...shot.resources,
    ].filter(
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

function stableSubject<T extends ProductionInstruction['subjects'][number] | undefined>(
  subject: T,
): Pick<NonNullable<T>, 'description' | 'wardrobe' | 'appearance' | 'hairMakeup'> | undefined {
  if (!subject) return undefined;
  return {
    description: subject.description,
    wardrobe: subject.wardrobe,
    appearance: subject.appearance,
    hairMakeup: subject.hairMakeup,
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
  shots: Array<{ shot: ShotInfo; instruction?: ProductionInstruction; promptText?: string }>,
  names: Record<string, string>,
  options: {
    sharedText?: string;
    isSegment?: boolean;
    continuityIssues?: (shotId: string) => ProductionIssue[];
  } = {},
) {
  const timeline: ProductionTimelineEntry[] = [];
  const issues: ProductionIssue[] = [];
  let cursor: number | undefined = 0;
  const resources = [...shared.resources];
  let audio = shared.audio;
  const modes = ['auto', 'silent', 'native', 'voice-reference', 'dialogue-driven'];
  const facts = seedProductionFacts(shared.continuity);
  for (const { shot, instruction, promptText } of shots) {
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
        target: { kind: 'shot', id: shot.id },
        targetTitle: shot.title,
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
      prompt:
        promptText ??
        (effective
          ? renderProductionInstruction(effective, names)
          : (shot.prompt ?? '分镜内容待补充')),
    });
    cursor = end;
    if (shared.version === 2 && !instruction?.timing)
      issues.push({
        code: 'MISSING_SHOT_TIMING',
        message: `分镜「${shot.title}」缺少结构化剧情时长，请补充，系统不会按固定秒数凑时长。`,
        target: { kind: 'shot', id: shot.id },
        targetTitle: shot.title,
      });
    if (effective) {
      resources.push(...effective.resources);
      if (modes.indexOf(effective.audio.mode) > modes.indexOf(audio.mode))
        audio = { ...shared.audio, ...effective.audio };
      issues.push(
        ...(options.continuityIssues
          ? options.continuityIssues(shot.id)
          : applyProductionFacts(
              facts,
              effective.continuity,
              timeline.length > 1 || effective.continuity.predecessors.length > 0,
            )
        ).map((issue) => ({
          ...issue,
          target: issue.target ?? { kind: 'shot' as const, id: shot.id },
          targetTitle:
            issue.targetTitle ??
            (!issue.target || issue.target.id === shot.id ? shot.title : undefined),
        })),
      );
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
