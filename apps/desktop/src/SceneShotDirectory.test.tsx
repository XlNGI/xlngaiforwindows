import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneInfo, ShotInfo } from '@ai-video/contracts';
import { SceneShotDirectory } from './SceneShotDirectory';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const scene: SceneInfo = {
  id: 'a',
  projectId: 'project',
  title: '第一场',
  position: 0,
  rowVersion: 0,
  createdAt: 'now',
  updatedAt: 'now',
};
const next = { ...scene, id: 'b', title: '第二场', position: 1 };
const shot: ShotInfo = {
  id: 'a1',
  sceneId: scene.id,
  title: '第一场近景',
  position: 0,
  status: 'draft',
  rowVersion: 0,
  createdAt: 'now',
  updatedAt: 'now',
};
const nextShot = { ...shot, id: 'b1', sceneId: next.id, title: '第二场远景' };
describe('scene and shot directory', () => {
  it('keeps each shot directly under its parent while multiple scenes are expanded', async () => {
    vi.mocked(callWorker).mockResolvedValue([nextShot]);
    const onSelectScene = vi.fn();
    const onSelectShot = vi.fn();
    render(
      <SceneShotDirectory
        projectId="project"
        scenes={[scene, next]}
        sceneId={scene.id}
        shotId={shot.id}
        shots={[shot]}
        writable
        onAddScene={vi.fn()}
        onSelectScene={onSelectScene}
        onSelectShot={onSelectShot}
      />,
    );
    expect(
      within(screen.getByLabelText('第一场的镜头')).getByRole('button', { name: shot.title }),
    ).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '展开第二场' }));
    expect(
      await within(screen.getByLabelText('第二场的镜头')).findByRole('button', {
        name: nextShot.title,
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('第二场的镜头')).queryByText(shot.title),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: nextShot.title }));
    expect(onSelectShot).toHaveBeenCalledWith(next, nextShot);
    fireEvent.click(screen.getByRole('button', { name: scene.title }));
    expect(onSelectScene).toHaveBeenCalledWith(scene);
    fireEvent.click(screen.getByRole('button', { name: '收起第一场' }));
    expect(screen.queryByText(shot.title)).not.toBeInTheDocument();
    expect(screen.getByText(nextShot.title)).toBeInTheDocument();
    expect(screen.queryByLabelText('场次绑定场景')).not.toBeInTheDocument();
  });
});
