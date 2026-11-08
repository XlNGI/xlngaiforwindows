import { describe, expect, it } from 'vitest';
import {
  composeSceneReferenceImagePrompt,
  SCENE_REFERENCE_IMAGE_REQUIREMENTS,
  sceneReferenceImageParameters,
} from './scene-reference.js';

describe('scene reference image requests', () => {
  it('only supplies a count when supported by the selected image schema', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema' as const,
      type: 'object' as const,
      required: [],
      additionalProperties: false as const,
      properties: {},
    };
    expect(
      sceneReferenceImageParameters({ parameterSchema: schema }, { prompt: '码头', n: 6 }),
    ).toEqual({ prompt: '码头' });
    expect(
      sceneReferenceImageParameters(
        {
          parameterSchema: {
            ...schema,
            properties: {
              n: { type: 'integer', title: '数量' },
            },
          },
        },
        { prompt: '码头', n: 6 },
      ),
    ).toEqual({ prompt: '码头', n: 1 });
  });
  it('requires one composite with a dominant panorama and consistent detail insets', () => {
    expect(SCENE_REFERENCE_IMAGE_REQUIREMENTS).toContain('一张复合参考图');
    expect(SCENE_REFERENCE_IMAGE_REQUIREMENTS).toContain('主图是占画面主要面积');
    expect(SCENE_REFERENCE_IMAGE_REQUIREMENTS).toContain('关键局部特写');
    expect(SCENE_REFERENCE_IMAGE_REQUIREMENTS).toContain('不要把全景与特写拆成多张图片');
    expect(SCENE_REFERENCE_IMAGE_REQUIREMENTS).toContain('n=1');
    expect(SCENE_REFERENCE_IMAGE_REQUIREMENTS).toContain('对应到主全景中真实存在');
  });

  it('preserves authored scene text and appends the shared layout for direct generation', () => {
    const scene = `东墙开门，西墙有窗，木桌位于中央。${'场景原有细节。'.repeat(600)}`;

    expect(composeSceneReferenceImagePrompt(scene)).toBe(
      `${scene}\n\n${SCENE_REFERENCE_IMAGE_REQUIREMENTS}`,
    );
  });

  it('preserves authored markers and does not append the shared layout twice', () => {
    const original = '旧码头，保持蓝灰色；资料正文中的前后左右上下不得删除。';
    const main = composeSceneReferenceImagePrompt(original);
    expect(composeSceneReferenceImagePrompt(main)).toBe(main);
    expect(composeSceneReferenceImagePrompt(main, { referenceAssetId: 'asset-1' })).toBe(main);

    const quotedMarkers =
      '庭院说明\n【场景参考出图约束】\n保留这一段原始设定。\n【场景参考出图约束结束】';
    expect(composeSceneReferenceImagePrompt(quotedMarkers)).toContain(quotedMarkers);
  });

  it('keeps empty documents empty', () => {
    expect(composeSceneReferenceImagePrompt('  ')).toBe('');
  });
});
