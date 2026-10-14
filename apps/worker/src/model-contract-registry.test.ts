import { describe, expect, it } from 'vitest';
import {
  getModelContract,
  listModelBindings,
  listModelContracts,
  listProtocolAdapters,
  listTaskAdapters,
  setCatalogStatus,
  resolveEffectiveCapabilities,
  resolveModelBinding,
} from './model-contract-registry.js';

describe('model contract registry', () => {
  it('registers verified audio contracts without granting unverified channels their capabilities', () => {
    const contract = getModelContract('cn.qwen.wan3-0-video', 2)!;
    expect(contract).toMatchObject({ status: 'verified', capabilities: { audioInput: true } });
    expect(contract.parameterSchema.properties).toHaveProperty('media');
    expect(getModelContract('cn.qwen.wan3-0-video', 1)?.capabilities.audioInput).toBe(false);
    expect(resolveModelBinding('unicompapi', 'wan3.0-video')?.contract.contractRevision).toBe(1);
    expect(
      getModelContract('cn.kling.character-element')?.parameterSchema.properties,
    ).toHaveProperty('element_voice_id');
    expect(
      getModelContract('cn.vidu.q4-preview.reference-video')?.parameterSchema.properties,
    ).toHaveProperty('sounds');
  });
  it('keeps canonical contracts separate from provider model IDs', () => {
    const contracts = listModelContracts();
    expect(contracts.map((contract) => contract.contractId)).toEqual(
      expect.arrayContaining([
        'cn.deepseek.v4-pro',
        'cn.deepseek.v4.1-flash',
        'cn.zhipu.glm-5',
        'cn.zhipu.glm-5.3',
        'cn.zhipu.glm-5.3-flash',
        'cn.kimi.k3',
        'cn.minimax.m3',
        'cn.minimax.h3',
        'cn.qwen.image.latest',
        'media.openai-compatible-image',
        'media.openai-compatible-video',
        'vidu.q3.start-end-video',
        'vidu.q3.reference-video',
      ]),
    );
    expect(listModelBindings().map((binding) => binding.remoteModelId)).toContain('MiniMax-H3');
  });

  it('does not make discovered contracts executable', () => {
    const resolved = resolveModelBinding('minimax', 'MiniMax-H3');
    expect(resolved).toBeDefined();
    expect(() => resolveEffectiveCapabilities(resolved!.contract, resolved!.binding)).toThrow(
      'Only enabled model bindings can be used at runtime.',
    );
  });

  it('returns immutable snapshots', () => {
    const first = getModelContract('cn.minimax.h3');
    first!.parameterSchema.properties = {};
    const second = getModelContract('cn.minimax.h3');
    expect(second!.parameterSchema.properties).toHaveProperty('messages');
  });

  it('keeps protocol transport separate from model contracts', () => {
    expect(listProtocolAdapters().map((adapter) => adapter.protocol)).toEqual(
      expect.arrayContaining([
        'openai-compatible-video',
        'dashscope-video',
        'openai-chat-completions',
        'openai-responses',
        'vidu-v2',
        'seedance-video',
        'minimax-video-v2',
      ]),
    );
  });

  it('exposes task adapters with explicit lifecycle contracts', () => {
    const video = listTaskAdapters().find((adapter) => adapter.id === 'video-generation-v1');
    expect(video?.lifecycle).toMatchObject({ mode: 'asynchronous', submit: '/v1/videos' });
  });

  it('changes catalog status without mutating the source snapshot', () => {
    const contract = listModelContracts().find(
      (candidate) => candidate.contractId === 'media.openai-compatible-image',
    )!;
    const enabled = setCatalogStatus(contract, true);
    expect(enabled.status).toBe('enabled');
    expect(enabled).not.toBe(contract);
    expect(enabled.parameterSchema).not.toBe(contract.parameterSchema);
  });

  it('resolves confirmed UniComp models to their canonical contracts', () => {
    const resolved = resolveModelBinding('unicompapi', 'glm-5.3');
    expect(resolved).toMatchObject({
      binding: { status: 'enabled', contractId: 'cn.zhipu.glm-5.3' },
      contract: { status: 'enabled', contractId: 'cn.zhipu.glm-5.3' },
    });
    expect(resolveModelBinding('unicompapi', 'deepseek-v4-flash-0731')).toMatchObject({
      binding: { status: 'enabled', contractId: 'cn.deepseek.v4.1-flash' },
    });
  });
});
