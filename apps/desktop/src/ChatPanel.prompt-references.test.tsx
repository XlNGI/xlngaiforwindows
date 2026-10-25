import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { officialVideoAudioContracts, type AdapterDescriptor } from '@ai-video/contracts';
import { ChatPanel } from './ChatPanel';
import { replacePromptText } from './prompt-editor.test-utils';

afterEach(cleanup);
const props: ComponentProps<typeof ChatPanel> = {
  scopeType: 'project',
  scopeAvailable: true,
  writable: true,
  conversations: [],
  messages: [],
  composer: '',
  statusMessage: '',
  legacyLlmConfigured: false,
  llmProfiles: [],
  llmModels: [],
  selectedLlmProfileId: '',
  selectedLlmModelId: '',
  onSelectConversation: vi.fn(),
  onCreateConversation: vi.fn(),
  onRetryGeneration: vi.fn(),
  onLlmProfileChange: vi.fn(),
  onLlmModelChange: vi.fn(),
  onOpenProviderSettings: vi.fn(),
  onComposerChange: vi.fn(),
  onCancelGeneration: vi.fn(),
  onSendMessage: vi.fn(),
};
describe('Agent reviewed form prompt references', () => {
  it.each(['cn.qwen.wan3-0-video', 'cn.bytedance.seedance2-0.video'])(
    'seeds and directly submits the reviewed prompt and image for %s',
    async (contractId) => {
      const contract = officialVideoAudioContracts
        .filter((item) => item.contractId === contractId)
        .at(-1)!;
      const adapter: AdapterDescriptor = {
        key: 'test',
        capability: 'REFERENCE_TO_VIDEO',
        capabilityLabel: '参考生视频',
        provider: 'wan-video',
        providerLabel: '测试',
        model: contractId,
        modelLabel: '模型',
        apiVersion: 'v1',
        schemaVersion: 1,
        endpoint: '/test',
        documentationUrl: 'https://example.com',
        credentialProvider: 'wan-video',
        contractId,
        contractRevision: contract.contractRevision,
        parameterSchema: {
          ...structuredClone(contract.parameterSchema),
          $schema: 'https://json-schema.org/draft/2020-12/schema',
        } as AdapterDescriptor['parameterSchema'],
        uiSchema: { fields: [] },
      };
      if (adapter.parameterSchema.properties.prompt)
        adapter.parameterSchema.properties.prompt.title = '提示词';
      const submitted = vi.fn();
      render(
        <ChatPanel
          {...props}
          agentParameterRequest={{
            modelName: '测试模型',
            providerProfileId: 'profile',
            modelId: 'model',
            affectsCost: true,
            capability: 'video',
            prompt: '图1中的女子穿入雨幕',
            referenceImageInputs: ['https://example.com/actor.png'],
            adapters: [adapter],
          }}
          onSubmitAgentParameters={submitted}
        />,
      );
      const editor = await screen.findByRole('textbox', {
        name: adapter.parameterSchema.properties.content ? '内容' : '提示词',
      });
      await waitFor(() => expect(editor.querySelector('.prompt-reference-chip')).not.toBeNull());
      await replacePromptText(editor, '图片 1中的女子回身\n保持脸部清晰');
      fireEvent.click(screen.getByRole('button', { name: '提交生成' }));
      expect(submitted).toHaveBeenCalledOnce();
      const parameters = submitted.mock.calls[0]![1] as Record<string, unknown>;
      if (adapter.parameterSchema.properties.content) {
        expect(parameters.content).toEqual(
          expect.arrayContaining([
            { type: 'text', text: '图片1中的女子回身\n保持脸部清晰' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/actor.png' },
              role: 'reference_image',
            },
          ]),
        );
        expect(parameters).not.toHaveProperty('prompt');
      } else {
        expect(parameters.prompt).toBe('图 1中的女子回身\n保持脸部清晰');
        expect(parameters.media).toEqual([
          { type: 'reference_image', url: 'https://example.com/actor.png' },
        ]);
      }
      expect(JSON.stringify(parameters)).not.toContain('data-reference-id');
      fireEvent.click(screen.getByRole('button', { name: '正在提交…' }));
      expect(submitted).toHaveBeenCalledOnce();
    },
  );
});
