import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderEditor } from './ProviderEditor';
import type { ProviderDefinitionInfo } from '@ai-video/contracts';

afterEach(cleanup);
it('requires the Wan workspace ID and preserves its official endpoint when editing', async () => {
  const wan: ProviderDefinitionInfo = {
    id: 'wan-video',
    name: '万相视频',
    category: 'multi',
    providerType: 'wan-video',
    accessType: 'official',
    protocol: 'dashscope-video',
    baseUrl: 'https://dashscope.aliyuncs.com',
  };
  const onSubmit = vi.fn().mockResolvedValue({ secretStored: true, completed: false });
  const props = { definitions: [wan], credentialConfigured: true, onCancel: vi.fn(), onSubmit };
  const view = render(<ProviderEditor {...props} />);
  expect(screen.getByRole('button', { name: '保存并测试' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('百炼业务空间 ID（北京地域）'), {
    target: { value: 'workspace-123' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存并测试' }));
  const baseUrl = 'https://workspace-123.cn-beijing.maas.aliyuncs.com';
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ providerType: 'wan-video', baseUrl }),
      '',
    ),
  );
  view.rerender(
    <ProviderEditor
      {...props}
      profile={{
        ...wan,
        baseUrl,
        id: 'profile-id',
        enabled: true,
        connectionStatus: 'ready',
        createdAt: '',
        updatedAt: '',
      }}
    />,
  );
  expect(screen.getByLabelText('百炼业务空间 ID（北京地域）')).toHaveValue('workspace-123');
  expect(screen.getByLabelText('Base URL')).toHaveValue(baseUrl);
});
