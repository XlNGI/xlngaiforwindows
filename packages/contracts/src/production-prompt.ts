import type { ProductionInstruction, ProductionIssue } from './production.js';

const absent = /^(?:无|暂无|不适用|none|n\/a)[。.!！]?$/iu;
const clean = (value?: string) => value?.trim().replace(/[，；。]+$/u, '') ?? '';
const present = (value?: string) => Boolean(clean(value) && !absent.test(clean(value)));
const explicitNone = (value: string | undefined, meaning: string) =>
  clean(value) === '无' ? meaning : value;

/** Only descriptive lists are deduplicated. Actions, dialogue and sound rhythms
 * retain their original wording, including intentional repetitions. */
function descriptions(values: Array<string | undefined>): string {
  const seen = new Set<string>();
  return values
    .flatMap((value) => {
      const text = clean(value);
      return /[“”「」"()（）]/u.test(text) ? [text] : text.split(/[，；]/u);
    })
    .map(clean)
    .filter((value) => {
      if (!present(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .join('，');
}

function fields(entries: Array<[string, string | undefined]>, seen = new Set<string>()): string {
  const groups = new Map<string, string[]>();
  for (const [label, value] of entries) {
    const text = clean(value);
    if (!present(text) || seen.has(text)) continue;
    groups.set(text, [...(groups.get(text) ?? []), label]);
  }
  return [...groups]
    .map(([text, labels]) => {
      seen.add(text);
      return `${labels.join('与')}：${text}`;
    })
    .join('；');
}

const cameraFields = (camera: ProductionInstruction['camera']) =>
  [
    ['景别', camera?.framing],
    ['机位', camera?.angle],
    ['构图', camera?.composition],
    ['镜头', camera?.lens],
    ['景深', camera?.depthOfField],
    ['焦点', camera?.focus],
    ['运镜', explicitNone(camera?.movement, '无运镜')],
    ['速度', camera?.speed],
    ['幅度', camera?.amplitude],
    ['起始画面', camera?.startFrame],
    ['结束画面', camera?.endFrame],
    ['轴线', camera?.axis],
  ] as Array<[string, string | undefined]>;

export function renderProductionNegative(value: string): string {
  const text = clean(value).replace(/^(?:避免\s*[:：]?\s*)+/u, '避免');
  return /^(?:避免|不要|禁止|不得)/u.test(text) ? text : `避免${text}`;
}

/** Undefined preserves legacy inheritance; v2 explicitly declares its cast,
 * including an empty cast. IDs, never names or prompt prose, define the scope. */
export function productionCharacterIds(instruction?: ProductionInstruction): string[] | undefined {
  if (!instruction || (instruction.version === 1 && !instruction.subjects.length)) return;
  return [
    ...new Set([
      ...instruction.subjects.map((subject) => subject.documentId),
      ...instruction.beats.flatMap((beat) => [
        ...beat.characterDocumentIds,
        ...beat.dialogue.map((line) => line.characterDocumentId),
      ]),
    ]),
  ];
}

export function renderProductionInstruction(
  instruction: ProductionInstruction,
  names: Record<string, string> = {},
  options: { includeAudio?: boolean } = {},
): string {
  const name = (id: string) => names[id] ?? '角色';
  const lines: Array<string | undefined> = [instruction.summary.trim()];
  const add = (label: string, value?: string) => {
    if (present(value)) lines.push(`${label}：${value}`);
  };
  if (instruction.narrative) {
    const details = fields([
      ['冲突', instruction.narrative.conflict],
      ['情绪变化', instruction.narrative.emotionalProgression],
    ]);
    add('叙事目的', `${instruction.narrative.purpose}${details ? `；${details}` : ''}`);
  }
  if (instruction.storyTime) {
    const time = instruction.storyTime;
    add(
      '故事时间',
      descriptions([
        time.era,
        time.season,
        time.storyDay,
        time.date,
        time.timeOfDay,
        time.clockTime,
      ]),
    );
  }
  add('地点环境', descriptions(Object.values(instruction.location ?? {})));
  const visualSeen = new Set<string>();
  const style = descriptions(
    Object.entries(instruction.style ?? {}).map(([key, value]) =>
      key === 'linework' ? explicitNone(value, '无线条') : value,
    ),
  );
  add('视觉风格', style);
  for (const value of Object.values(instruction.style ?? {}))
    if (present(value)) visualSeen.add(clean(value));
  if (instruction.timing)
    lines.push(
      `剧情预计时长：${instruction.timing.estimatedDurationSeconds}秒；节奏依据：${instruction.timing.rationale}`,
    );
  add('画面定格', instruction.stillFrame);
  for (const subject of instruction.subjects) {
    const label = `人物「${name(subject.documentId)}」`;
    add(
      label,
      fields([
        [
          '外观与服装',
          descriptions([
            subject.description,
            subject.appearance,
            subject.wardrobe,
            subject.hairMakeup,
          ]),
        ],
        ['站位', subject.position],
        ['表情', subject.expression],
        ['视线', subject.gaze],
        ['道具', subject.props],
      ]),
    );
    add(`${label}初始状态`, subject.initialState);
    if (
      !instruction.beats.some(
        (beat) =>
          beat.characterDocumentIds.includes(subject.documentId) &&
          clean(beat.action) === clean(subject.action),
      )
    )
      add(`${label}动作概述`, subject.action);
    add(`${label}结束状态`, subject.endState);
  }
  add(
    '画面',
    fields(
      [
        ['环境', instruction.visual.environment],
        [
          '构图',
          instruction.visual.composition === instruction.camera?.composition
            ? undefined
            : instruction.visual.composition,
        ],
        [
          '光源',
          instruction.visual.lighting === instruction.lightingDesign?.source
            ? undefined
            : instruction.visual.lighting,
        ],
        ['风格', instruction.visual.style],
        ['色彩', instruction.visual.palette],
        [
          '镜头',
          instruction.visual.lens === instruction.camera?.lens
            ? undefined
            : instruction.visual.lens,
        ],
      ],
      visualSeen,
    ),
  );
  const camera = fields(cameraFields(instruction.camera));
  add('镜头设计', camera);
  const light = instruction.lightingDesign;
  add(
    '灯光设计',
    fields([
      ['光源', light?.source],
      ['方向', light?.direction],
      ['光质', light?.quality],
      ['色温', light?.colorTemperature],
      ['补光', explicitNone(light?.fill, '无补光')],
      ['轮廓光', light?.rim],
      ['实景光', light?.practicals],
    ]),
  );
  let previousCamera = new Map(cameraFields(instruction.camera));
  for (const [index, beat] of instruction.beats.entries()) {
    const timing =
      beat.startSeconds === undefined
        ? `动作段${index + 1}`
        : `${beat.startSeconds}—${beat.endSeconds}秒`;
    const effectiveCamera = cameraFields({ ...instruction.camera, ...beat.camera });
    const beatCamera = fields(
      effectiveCamera.filter(([label, value]) => clean(value) !== clean(previousCamera.get(label))),
    );
    previousCamera = new Map(effectiveCamera);
    const dialogue = beat.dialogue
      .map(
        (line) =>
          `${name(line.characterDocumentId)}${[line.emotion, line.delivery].filter(Boolean).join('，')}说：“${line.text}”`,
      )
      .join('；');
    lines.push(
      `${timing}｜${[
        `动作：${beat.action}`,
        beatCamera ? `镜头：${beatCamera}` : undefined,
        dialogue ? `对白：${dialogue}` : undefined,
      ]
        .filter(Boolean)
        .join('；')}`,
    );
  }
  if (options.includeAudio !== false) {
    if (instruction.audio.mode === 'silent') lines.push('无声音。');
    else {
      if (
        !instruction.beats.some((beat) => beat.dialogue.length) &&
        instruction.audio.mode !== 'dialogue-driven'
      )
        lines.push('对白：本镜未提供新增台词。');
      add('环境声', instruction.audio.ambience);
      if (instruction.audio.music?.trim()) lines.push(`配乐：${clean(instruction.audio.music)}`);
      add('音效', instruction.audio.effects);
    }
  }
  lines.push(
    ...instruction.continuity.before.map((fact) => `开始状态：${fact.key}=${fact.value}`),
    ...instruction.continuity.after.map((fact) => `结束状态：${fact.key}=${fact.value}`),
    ...instruction.continuity.locked.map((fact) => `保持不变：${fact.key}=${fact.value}`),
    ...new Set(instruction.continuity.constraints),
  );
  add('入镜衔接', instruction.transition?.entry);
  add('出镜衔接', instruction.transition?.exit);
  return lines.filter(Boolean).join('\n');
}

// Conservative review hints, never anatomical corrections or submission gates.
function missingArmSides(value: string): Set<string> {
  return new Set(
    [
      ...value.matchAll(
        /([左右])(?:肩|手臂|上臂|前臂|臂)[^，。；、\n]{0,10}?(?:空荡|断缺|缺失|缺如|截肢|残缺)/gu,
      ),
    ]
      .filter(
        (match) =>
          !/(?:未|没有|并非|不是|无)(?:曾|发生)?(?:空荡|断缺|缺失|缺如|截肢|残缺)/u.test(match[0]),
      )
      .map((match) => match[1]!),
  );
}

export function inspectProductionPrompt(
  instruction: ProductionInstruction,
  names: Record<string, string> = {},
): ProductionIssue[] {
  const notices: ProductionIssue[] = (instruction.reviewNotes ?? []).map((message) => ({
    code: 'AUTHORING_REVIEW_NOTE',
    message,
  }));
  for (const subject of instruction.subjects) {
    const name = names[subject.documentId] ?? '角色';
    const appearance = [subject.description, subject.appearance, subject.wardrobe]
      .filter(Boolean)
      .join('，');
    const sides = missingArmSides(appearance);
    for (const fact of instruction.continuity.locked) {
      if (
        fact.comparison?.entity.kind !== 'character' ||
        fact.comparison.entity.id !== subject.documentId
      )
        continue;
      const lockedSides = missingArmSides(fact.value);
      if (sides.size === 1 && lockedSides.size === 1 && [...sides][0] !== [...lockedSides][0])
        notices.push({
          code: 'CHARACTER_DETAIL_REVIEW',
          message: `「${name}」人物描述“${appearance}”与锁定要求“${fact.value}”使用了不同侧的断臂描述，请核实；已保留原文。`,
        });
    }
    const action = [
      subject.action,
      ...instruction.beats
        .filter((beat) => beat.characterDocumentIds.includes(subject.documentId))
        .map((beat) => beat.action),
    ].join('；');
    if (
      /(?:失明|目盲|盲人|视障)/u.test(appearance) &&
      /(?:行走|走向|走出|离去|迈步)/u.test(action) &&
      !/(?:探|触|辨|听|熟悉|扶|引导)/u.test(action)
    )
      notices.push({
        code: 'MOVEMENT_DETAIL_REVIEW',
        message: `「${name}」已声明视障和行走，但缺少方向确认或环境熟悉程度的动作说明，请按已有设定细化；不默认添加踉跄或跛行。`,
      });
  }
  if (
    instruction.audio.mode !== 'dialogue-driven' &&
    instruction.beats.some(
      (beat) => /(?:说完|说道|开口|答道|拒绝道)/u.test(beat.action) && !beat.dialogue.length,
    )
  )
    notices.push({
      code: 'DIALOGUE_BOUNDARY_REVIEW',
      message: '动作提及说话，但该动作段未提供台词；请明确对白属于上一镜还是本镜，不自动补写台词。',
    });
  return notices;
}
