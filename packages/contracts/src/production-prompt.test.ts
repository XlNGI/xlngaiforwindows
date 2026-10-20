import { describe, expect, it } from 'vitest';
import {
  inspectProductionPrompt,
  productionCharacterIds,
  renderProductionInstruction,
  renderProductionNegative,
} from './production-prompt.js';
import type { ProductionInstruction } from './production.js';

function smithy(): ProductionInstruction {
  return {
    version: 2,
    summary: '江晚拒绝，老瞎子离去',
    narrative: { purpose: '留下悬念', emotionalProgression: '抗拒转为动摇' },
    storyTime: { era: '架空古代', season: '深秋', storyDay: '第一日，黄昏', timeOfDay: '黄昏' },
    location: { description: '铁匠铺，土墙茅顶。', layout: '门在背景右侧' },
    style: { palette: '青灰，墨黑，炉火橙黄', realism: '写实' },
    subjects: [
      {
        documentId: 'jiang',
        description: '铸剑传人',
        appearance: '墨黑长发半挽，乌木簪固定',
        hairMakeup: '墨黑长发半挽，乌木簪固定',
        position: '前景左侧，背对门口',
        expression: '不可见',
        gaze: '不可见',
        initialState: '继续打铁',
        action: '举锤后迟疑，再落下',
        endState: '锤声已乱',
      },
      {
        documentId: 'blind',
        description: '守潭人，双目失明',
        appearance: '花白散发，右肩空荡',
        position: '背景右侧，立于门内',
        props: '铁木杖',
        initialState: '立于门口',
        endState: '走入门外雾中',
      },
    ],
    visual: { palette: '青灰，墨黑，炉火橙黄', lens: '35mm等效，浅景深' },
    camera: { framing: '中远景', movement: '固定机位', focus: '老瞎子背影', axis: '无' },
    lightingDesign: { source: '炉火', practicals: '炉火', fill: '无填充光' },
    beats: [
      {
        id: 'turn',
        startSeconds: 0,
        endSeconds: 2,
        action: '老瞎子说完话，转身离去',
        characterDocumentIds: ['blind'],
        camera: { movement: '固定机位' },
        dialogue: [],
      },
      {
        id: 'step',
        startSeconds: 2,
        endSeconds: 6,
        action: '老瞎子先用杖尖探到门槛，确认后迈步跨过',
        characterDocumentIds: ['blind'],
        dialogue: [],
      },
      {
        id: 'hammer',
        startSeconds: 6,
        endSeconds: 8,
        action: '江晚举锤后悬停片刻，再迟一拍落下',
        characterDocumentIds: ['jiang'],
        dialogue: [],
      },
    ],
    audio: { mode: 'native', music: '无', effects: '笃、笃，杖声渐远；锤声由稳到乱' },
    generation: { duration: 8 },
    resources: [],
    continuity: {
      predecessors: [],
      before: [],
      after: [],
      locked: [
        {
          key: '断臂',
          value: '左臂自肘部断缺',
          comparison: {
            entity: { kind: 'character', id: 'blind' },
            attribute: 'arm',
            state: 'left-elbow',
          },
        },
      ],
      constraints: [],
    },
  };
}
const names = { jiang: '江晚', blind: '老瞎子' };

describe('production prompt organization', () => {
  it('keeps the smithy scene spatially and temporally explicit without duplicating static fields', () => {
    const spec = smithy();
    const before = structuredClone(spec);
    const prompt = renderProductionInstruction(spec, names);
    expect(prompt).toContain('故事时间：架空古代，深秋，第一日，黄昏');
    expect(prompt.match(/墨黑长发半挽/gu)).toHaveLength(1);
    expect(prompt.match(/青灰，墨黑，炉火橙黄/gu)).toHaveLength(1);
    expect(prompt.match(/固定机位/gu)).toHaveLength(1);
    expect(prompt).toContain('站位：前景左侧，背对门口');
    expect(prompt).toContain('表情与视线：不可见');
    expect(prompt).toContain('人物「老瞎子」初始状态：立于门口');
    expect(prompt).toContain('人物「老瞎子」结束状态：走入门外雾中');
    expect(prompt.indexOf('0—2秒')).toBeLessThan(prompt.indexOf('2—6秒'));
    expect(prompt.indexOf('2—6秒')).toBeLessThan(prompt.indexOf('6—8秒'));
    expect(prompt).toContain('无填充光');
    expect(prompt).not.toContain('轴线：无');
    expect(prompt).toContain('配乐：无');
    expect(prompt).toContain('笃、笃');
    expect(spec).toEqual(before);
  });

  it('preserves exact dialogue and intentional repetition with the right speaker and beat', () => {
    const spec = smithy();
    spec.beats[2]!.dialogue = [
      { characterDocumentId: 'jiang', text: '走吧，走吧。别再问了。', delivery: '压低声音' },
    ];
    const prompt = renderProductionInstruction(spec, names);
    expect(prompt).toContain('对白：江晚压低声音说：“走吧，走吧。别再问了。”');
    expect(prompt).not.toContain('本镜未提供新增台词');
    expect(prompt).not.toContain('老瞎子压低声音');
  });

  it('preserves a return to the default camera after a beat-specific move', () => {
    const spec = smithy();
    spec.beats[0]!.camera = { movement: '短暂跟拍' };
    const prompt = renderProductionInstruction(spec, names);
    expect(prompt).toContain('0—2秒｜动作：老瞎子说完话，转身离去；镜头：运镜：短暂跟拍');
    expect(prompt).toContain(
      '2—6秒｜动作：老瞎子先用杖尖探到门槛，确认后迈步跨过；镜头：运镜：固定机位',
    );
  });

  it('does not remove one character action because another character has the same wording', () => {
    const spec = smithy();
    spec.subjects[0]!.action = '转身离去';
    spec.beats[0]!.action = '转身离去';
    expect(renderProductionInstruction(spec, names)).toContain('人物「江晚」动作概述：转身离去');
  });

  it('reports a possible side conflict only for the explicitly identified character and preserves both sources', () => {
    const spec = smithy();
    const before = structuredClone(spec);
    expect(inspectProductionPrompt(spec, names).map((notice) => notice.code)).toEqual([
      'CHARACTER_DETAIL_REVIEW',
      'DIALOGUE_BOUNDARY_REVIEW',
    ]);
    const prompt = renderProductionInstruction(spec, names);
    expect(prompt).toContain('右肩空荡');
    expect(prompt).toContain('左臂自肘部断缺');
    spec.continuity.locked[0]!.comparison!.entity.id = 'jiang';
    expect(
      inspectProductionPrompt(spec, names).some(
        (notice) => notice.code === 'CHARACTER_DETAIL_REVIEW',
      ),
    ).toBe(false);
    expect(before.subjects[1]!.appearance).toBe('花白散发，右肩空荡');
  });

  it('keeps authored uncertainty outside the model prompt and does not claim every prose conflict is detectable', () => {
    const spec = smithy();
    spec.reviewNotes = ['旧人物资料与修订稿的断臂侧别不同，待核实。'];
    expect(inspectProductionPrompt(spec, names)).toContainEqual({
      code: 'AUTHORING_REVIEW_NOTE',
      message: spec.reviewNotes[0],
    });
    expect(renderProductionInstruction(spec, names)).not.toContain('旧人物资料与修订稿');
    delete spec.continuity.locked[0]!.comparison;
    expect(
      inspectProductionPrompt(spec, names).some(
        (notice) => notice.code === 'CHARACTER_DETAIL_REVIEW',
      ),
    ).toBe(false);
  });

  it('asks for movement detail without manufacturing a limp or changing a familiar-route action', () => {
    const spec = smithy();
    spec.beats = [
      { id: 'leave', action: '老瞎子转身离去', characterDocumentIds: ['blind'], dialogue: [] },
    ];
    expect(inspectProductionPrompt(spec, names).map((notice) => notice.code)).toContain(
      'MOVEMENT_DETAIL_REVIEW',
    );
    const prompt = renderProductionInstruction(spec, names);
    expect(prompt).not.toContain('跛');
    expect(prompt).not.toContain('踉跄');
    spec.beats[0]!.action = '老瞎子沿熟悉的通道离去';
    expect(
      inspectProductionPrompt(spec, names).some(
        (notice) => notice.code === 'MOVEMENT_DETAIL_REVIEW',
      ),
    ).toBe(false);
  });

  it('does not treat an explicitly retained arm or a bilateral amputation as a proven side conflict', () => {
    const spec = smithy();
    spec.subjects[1]!.appearance = '右臂未缺失，左臂自肘部断缺';
    expect(
      inspectProductionPrompt(spec, names).some(
        (notice) => notice.code === 'CHARACTER_DETAIL_REVIEW',
      ),
    ).toBe(false);
    spec.subjects[1]!.appearance = '左臂断缺，右臂断缺';
    expect(
      inspectProductionPrompt(spec, names).some(
        (notice) => notice.code === 'CHARACTER_DETAIL_REVIEW',
      ),
    ).toBe(false);
  });

  it('scopes references by declared IDs and preserves the unknown legacy roster', () => {
    const spec = smithy();
    expect(productionCharacterIds(spec)).toEqual(['jiang', 'blind']);
    spec.subjects = [];
    spec.beats = [];
    expect(productionCharacterIds(spec)).toEqual([]);
    spec.version = 1;
    expect(productionCharacterIds(spec)).toBeUndefined();
  });

  it.each(['现代元素', '避免现代元素', '避免避免现代元素'])(
    'renders one avoidance prefix for %s',
    (value) => {
      expect(renderProductionNegative(value)).toBe('避免现代元素');
    },
  );
});
