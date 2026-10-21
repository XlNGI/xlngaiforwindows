import { expect, it } from 'vitest';
import type { ProductionInstruction } from '@ai-video/contracts';
import { inheritProductionInstruction } from './scene-production.js';

const instruction = (overrides: Partial<ProductionInstruction> = {}): ProductionInstruction => ({
  version: 2,
  summary: 'scene',
  narrative: { purpose: 'shared' },
  storyTime: { timeOfDay: '夜' },
  location: { description: '山路' },
  style: { palette: '青灰' },
  lightingDesign: { source: '月光' },
  subjects: [],
  visual: {},
  beats: [],
  audio: { mode: 'silent' },
  generation: {},
  resources: [],
  continuity: { predecessors: [], before: [], after: [], locked: [], constraints: [] },
  ...overrides,
});

it('inherits shared appearance but keeps cast, blocking, action, continuity and one-off camera shot-specific', () => {
  const parent = instruction({
    camera: {
      framing: '中远景',
      movement: '缓慢横移',
      speed: '极慢',
      amplitude: '一尺',
      startFrame: '江晚在左，沈孤鸿在右',
      endFrame: '两人拔剑',
    },
    subjects: [
      {
        documentId: 'jiang-wan',
        description: '22岁女剑士',
        wardrobe: '青色粗布袍',
        position: '断剑石左侧',
        expression: '压抑',
        gaze: '盯住沈孤鸿',
        action: '按剑',
        props: '铁剑',
        initialState: '铁剑在鞘',
        endState: '拔剑',
      },
      { documentId: 'shen-guhong', description: '沧桑剑客', wardrobe: '暗青长袍' },
    ],
  });
  const shot = instruction({
    camera: { framing: '近景', movement: '固定机位' },
    subjects: [{ documentId: 'jiang-wan', gaze: '看向炉火', action: '锤击铁块' }],
    beats: [
      {
        id: 'hit',
        action: '江晚锤击铁块',
        characterDocumentIds: ['jiang-wan'],
        dialogue: [{ characterDocumentId: 'jiang-wan', text: '继续。' }],
      },
    ],
    continuity: {
      predecessors: [],
      before: [],
      after: [{ key: '锤声', value: '乱了一拍' }],
      locked: [],
      constraints: [],
    },
  });

  const effective = inheritProductionInstruction(parent, shot);
  expect(effective.subjects).toEqual([
    {
      documentId: 'jiang-wan',
      description: '22岁女剑士',
      wardrobe: '青色粗布袍',
      gaze: '看向炉火',
      action: '锤击铁块',
    },
  ]);
  expect(effective.camera).toEqual({ framing: '近景', movement: '固定机位' });
  expect(effective.beats).toEqual(shot.beats);
  expect(effective.continuity.after).toEqual([{ key: '锤声', value: '乱了一拍' }]);
  expect(effective.style?.palette).toBe('青灰');
  expect(effective.lightingDesign?.source).toBe('月光');
});

it('preserves legacy v1 cast fallback while excluding scene-only blocking and actions', () => {
  const parent = instruction({
    subjects: [{ documentId: 'jiang-wan', wardrobe: '深青短打', action: '打铁', position: '炉边' }],
  });
  const legacyShot = instruction({
    version: 1,
    subjects: [{ documentId: 'jiang-wan' }],
  });
  expect(inheritProductionInstruction(parent, legacyShot).subjects).toEqual([
    { documentId: 'jiang-wan', wardrobe: '深青短打' },
  ]);
});
