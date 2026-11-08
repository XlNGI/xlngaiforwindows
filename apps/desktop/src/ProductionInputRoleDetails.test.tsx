import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  officialVideoAudioContracts,
  productionImagesFromParameters,
  seedProductionInputs,
  type AdapterDescriptor,
} from '@ai-video/contracts';
import { ProductionInputRoleDetails } from './ProductionInputRoleDetails';

afterEach(cleanup);
it('describes the actual Wan3 input roles and updates after a form role change', () => {
  const contract = officialVideoAudioContracts.find(
    (item) => item.contractId === 'cn.qwen.wan3-0-video' && item.contractRevision === 3,
  )!;
  const adapter = {
    contractId: contract.contractId,
    contractRevision: 3,
    capability: 'REFERENCE_TO_VIDEO',
    parameterSchema: contract.parameterSchema,
  } as unknown as AdapterDescriptor;
  const parameters = seedProductionInputs(adapter, {}, '原提示词', [
    { url: 'project-asset://frame', role: 'reference' },
  ]);
  const view = render(
    <ProductionInputRoleDetails images={productionImagesFromParameters(adapter, parameters)} />,
  );
  expect(screen.getByText('图片 1：普通参考输入')).toBeInTheDocument();
  expect(screen.getByText(/未指定首帧用途/)).toBeInTheDocument();
  const changed = seedProductionInputs(adapter, parameters, undefined, [
    { url: 'project-asset://frame', role: 'first-frame' },
  ]);
  view.rerender(
    <ProductionInputRoleDetails images={productionImagesFromParameters(adapter, changed)} />,
  );
  expect(screen.getByText('图片 1：首帧输入')).toBeInTheDocument();
  expect(screen.getByText(/仍需核对实际开头的光照/)).toBeInTheDocument();
  expect(screen.queryByText(/未指定首帧用途/)).not.toBeInTheDocument();
  expect(changed.prompt).toBe('原提示词');
  view.rerender(<ProductionInputRoleDetails images={[]} />);
  expect(screen.queryByLabelText('当前视频图片用途')).not.toBeInTheDocument();
});
