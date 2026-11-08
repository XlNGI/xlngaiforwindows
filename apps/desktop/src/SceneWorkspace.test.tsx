import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetInfo, DocumentSummary, SceneInfo, ShotInfo } from '@ai-video/contracts';
import { SceneWorkspace } from './SceneWorkspace';

vi.mock('./dubbing/DubbingScenePanel', () => ({ DubbingScenePanel: () => null }));

afterEach(() => cleanup());

const scene: SceneInfo = {
  id: 'scene',
  projectId: 'project',
  title: '第一场',
  position: 0,
  rowVersion: 1,
  createdAt: 'now',
  updatedAt: 'now',
};

const documents: DocumentSummary[] = [
  {
    id: 'actor',
    projectId: 'project',
    kind: 'character',
    title: '林澈',
    scopeType: 'project',
    lifecycleStatus: 'active',
    rowVersion: 1,
    createdAt: 'now',
    updatedAt: 'now',
  },
  {
    id: 'location',
    projectId: 'project',
    kind: 'scene',
    title: '旧码头',
    scopeType: 'project',
    lifecycleStatus: 'active',
    rowVersion: 1,
    createdAt: 'now',
    updatedAt: 'now',
  },
  {
    id: 'radio',
    projectId: 'project',
    kind: 'prop',
    title: '旧收音机',
    scopeType: 'project',
    lifecycleStatus: 'active',
    rowVersion: 1,
    createdAt: 'now',
    updatedAt: 'now',
  },
];

const locationAsset: AssetInfo = {
  id: 'location-image',
  projectId: 'project',
  kind: 'scene',
  relativePath: 'assets/old-dock.png',
  contentHash: 'hash',
  sizeBytes: 100,
  createdAt: 'now',
};

function shot(
  id: string,
  title: string,
  references: NonNullable<ShotInfo['authoringIR']>['references'],
  rowBindings?: ShotInfo['referenceBindings'],
): ShotInfo {
  return {
    id,
    sceneId: scene.id,
    title,
    position: 0,
    status: 'draft',
    authoringIR: {
      schemaVersion: 1,
      kind: 'shot',
      prompt: title,
      references,
    },
    referenceBindings: rowBindings,
    rowVersion: 1,
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function props(overrides: Partial<ComponentProps<typeof SceneWorkspace>> = {}) {
  return {
    projectId: 'project',
    scene,
    shots: [
      shot(
        'shot-1',
        '镜头一',
        {
          characterDocumentIds: ['actor'],
          sceneDocumentIds: ['location'],
          propDocumentIds: ['radio'],
        },
        {
          sceneBindings: [{ sourceDocumentId: 'location', assetId: locationAsset.id }],
        },
      ),
      shot('shot-2', '镜头二', {
        characterDocumentIds: ['actor'],
        sceneDocumentIds: [],
        propDocumentIds: [],
      }),
    ],
    prompt: '本场视频提示词',
    documents,
    assets: [locationAsset],
    writable: true,
    onPromptChange: vi.fn(),
    onSave: vi.fn(),
    onGenerateVideo: vi.fn(),
    onOpenAsset: vi.fn(),
    ...overrides,
  };
}

describe('SceneWorkspace shot binding summary', () => {
  it('shows the union of per-shot references and identifies which shots use each object', () => {
    render(<SceneWorkspace {...props()} />);

    expect(screen.getByRole('heading', { name: '镜头绑定汇总' })).toBeVisible();
    expect(screen.getByText('林澈')).toBeVisible();
    expect(screen.getByText('旧码头')).toBeVisible();
    expect(screen.getByText('旧收音机')).toBeVisible();
    expect(screen.getByText('镜头一、镜头二')).toBeVisible();
    expect(
      screen.getAllByText('镜头一', { selector: '.scene-binding-summary-shots' }),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '助手关联' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择出场角色')).not.toBeInTheDocument();
  });

  it('opens an explicitly selected image from the shot summary', () => {
    const p = props();
    render(<SceneWorkspace {...p} />);

    fireEvent.click(screen.getByRole('button', { name: 'old-dock.png' }));
    expect(p.onOpenAsset).toHaveBeenCalledWith(locationAsset.id);
  });

  it('keeps scene prompt actions limited to prompt save and scene video form', () => {
    const p = props();
    render(<SceneWorkspace {...p} />);

    fireEvent.click(screen.getByRole('button', { name: '保存提示词' }));
    fireEvent.click(screen.getByRole('button', { name: '生成场次视频' }));
    expect(p.onSave).toHaveBeenCalledWith(p.prompt);
    expect(p.onGenerateVideo).toHaveBeenCalledOnce();
    expect(within(screen.getByLabelText('镜头绑定汇总')).getByText('3 个引用对象')).toBeVisible();
  });
});
