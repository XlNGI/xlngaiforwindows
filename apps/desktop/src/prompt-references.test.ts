import { describe, expect, it } from 'vitest';
import type { AdapterDescriptor, AdapterParameterValue } from '@ai-video/contracts';
import {
  canonicalPromptParameters,
  promptReferences,
  remapPromptReferences,
  splitPromptReferences,
  updatePromptParameter,
} from './prompt-references';

export const referenceAdapter = {
  contractId: 'cn.qwen.wan3-0-video',
  contractRevision: 3,
  parameterSchema: { properties: { prompt: { type: 'string' }, media: { type: 'array' } } },
} as unknown as AdapterDescriptor;
const image = (url: string) => ({ type: 'reference_image', url });

describe('prompt reference projection', () => {
  it('numbers actual inputs by kind and preserves role, version and duplicate identities', () => {
    const refs = promptReferences(referenceAdapter, {
      media: [
        image('asset://a'),
        { type: 'reference_audio', url: 'character-voice://actor/v1' },
        image('project-asset://b'),
        image('asset://a'),
        { type: 'reference_video', url: 'video.mp4' },
      ],
    });
    expect(refs.map((item) => item.text)).toEqual(['图 1', '音频1', '图 2', '图 3', '视频1']);
    expect(new Set(refs.map((item) => item.id)).size).toBe(5);
    expect(promptReferences(referenceAdapter, { media: [image('project-asset://a')] })[0]?.id).toBe(
      refs[0]?.id,
    );
    expect(
      promptReferences(referenceAdapter, { media: [{ type: 'first_frame', url: 'asset://a' }] })[0]
        ?.id,
    ).not.toBe(refs[0]?.id);
  });
  it.each([
    ['cn.bytedance.seedance2-0.video', 2, '图片1'],
    ['cn.vidu.q4-preview.reference-video', 1, '@1'],
    ['cn.happyhorse.1.0.r2v', 1, '[image 1]'],
    ['cn.qwen.wan2-7-i2v', 2, '首帧图'],
  ])('uses the existing official syntax for %s', (contractId, contractRevision, text) => {
    expect(
      promptReferences({ ...referenceAdapter, contractId, contractRevision }, { images: ['a'] })[0]
        ?.text,
    ).toBe(text);
  });
  it('rewrites swaps once and keeps unknown prose intact', () => {
    const before = {
      prompt: '图1是人物，图片 2是场景。图10不在输入中。顾清影。',
      media: [image('a'), image('b')],
    };
    const next = updatePromptParameter(referenceAdapter, before, 'media', [image('b'), image('a')]);
    expect(next.prompt).toBe('图 2是人物，图 1是场景。图10不在输入中。顾清影。');
    expect(before.prompt).toContain('图1是人物');
  });
  it('removes a deleted reference rather than binding its number to a remaining input', () => {
    const before = { prompt: '图1人物和图2场景', media: [image('a'), image('b')] };
    expect(updatePromptParameter(referenceAdapter, before, 'media', [image('b')]).prompt).toBe(
      '人物和图 1场景',
    );
    expect(
      updatePromptParameter(referenceAdapter, before, 'media', [image('new'), image('b')]).prompt,
    ).toBe('人物和图 2场景');
  });
  it('projects structured content and rewrites only its text when media moves', () => {
    const adapter = {
      ...referenceAdapter,
      parameterSchema: {
        ...referenceAdapter.parameterSchema,
        properties: { content: { type: 'array' as const, title: '内容' } },
      },
    };
    const content: AdapterParameterValue[] = [
      { type: 'text', text: '图1对应音频1' },
      { type: 'image_url', image_url: { url: 'asset://a' }, role: 'reference_image' },
      { type: 'audio_url', audio_url: { url: 'audio.wav' } },
    ];
    const refs = promptReferences(adapter, { content });
    expect(refs.map((item) => item.kind)).toEqual(['image', 'audio']);
    const parameters = updatePromptParameter(adapter, { content }, 'content', [
      content[0]!,
      content[2]!,
    ]);
    expect(parameters.content).toEqual([{ type: 'text', text: '对应音频1' }, content[2]]);
  });
  it('supports audio selection reordering and preserves unrelated parameters', () => {
    const before = promptReferences(referenceAdapter, {
      media: [
        { type: 'reference_audio', url: 'a' },
        { type: 'reference_audio', url: 'b' },
      ],
    });
    const after = promptReferences(referenceAdapter, {
      media: [{ type: 'reference_audio', url: 'b' }],
    });
    expect(
      remapPromptReferences(before, after, { prompt: '音频2的声音，音频1的对白', duration: 5 }),
    ).toEqual({ prompt: '音频1的声音，的对白', duration: 5 });
  });
  it('canonicalizes display aliases using the final transport order without storing HTML', () => {
    const parameters = { prompt: '图片 1和图2\n不要文字', media: [image('a'), image('b')] };
    expect(
      canonicalPromptParameters(parameters, promptReferences(referenceAdapter, parameters)),
    ).toEqual({ ...parameters, prompt: '图 1和图 2\n不要文字' });
    expect(
      splitPromptReferences('没有明确引用的顾清影', promptReferences(referenceAdapter, parameters)),
    ).toEqual([{ text: '没有明确引用的顾清影' }]);
  });
});
