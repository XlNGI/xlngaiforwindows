import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MediaGenerationDraft,
  MediaModelSelectionDecision,
  MediaSubmissionResult,
  DubbingCueInfo,
  DubbingJobInfo,
} from '@ai-video/contracts';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { MediaReviewService } from './media-review-service.js';
import { readProductionSkill } from './production-skill-service.js';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';
import { validateSessionRequestParams } from './request-validation.js';
import type { MediaPrepareArguments, MediaSelectionContext } from './media-preparation-service.js';
import type { MediaGenerationKind } from '@ai-video/contracts';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const selection: MediaModelSelectionDecision = {
  providerProfileId: 'profile',
  modelId: 'model',
  adapterKey: 'image',
  parameters: { prompt: '用户审核的提示词' },
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'review-forms-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.create(join(directory, 'project'), 'Review');
  cleanups.push(() => {
    projects.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const content = new ContentService(projects);
  const conversation = content.createConversation({ scopeType: 'project' });
  const results = new Map<string, string[]>();
  const media: ConstructorParameters<typeof MediaReviewService>[1] = {
    selectionContext: vi.fn(
      (kind: MediaGenerationKind, args: MediaPrepareArguments): MediaSelectionContext => ({
        kind,
        arguments: args,
        inputAttachmentCount: 0,
        inputAttachments: [],
        candidates: [],
      }),
    ),
    selectionRequest: vi.fn((context: MediaSelectionContext, token: string, expiresAt: string) => ({
      selectionToken: token,
      expiresAt,
      kind: context.kind,
      prompt: context.arguments.prompt,
      inputAssetIds: context.arguments.inputAssetIds,
      inputAttachmentCount: 0,
      proposedParameters: {},
      candidates: [],
    })),
    prepareSelected: vi.fn(() => ({ draftId: 'job-1' }) as MediaGenerationDraft),
    getTask: vi.fn((id: string) => ({
      taskId: id,
      kind: 'image' as const,
      state: results.has(id) ? ('succeeded' as const) : ('polling' as const),
      adapterKey: 'image',
      resultAssetIds: results.get(id) ?? [],
      createdAt: '',
      updatedAt: '',
    })),
  };
  const submission = {
    requestSubmission: vi.fn(
      () =>
        ({
          kind: 'image',
          job: { id: 'job-1' },
          confirmation: { confirmationToken: 'review-token' },
        }) as MediaSubmissionResult,
    ),
    confirmSubmission: vi.fn(() =>
      Promise.resolve({ kind: 'image', job: { id: 'job-1' } } as MediaSubmissionResult),
    ),
  };
  const dubbing: ConstructorParameters<typeof MediaReviewService>[3] = {
    scene: vi.fn(() => ({ sceneId: 'scene', voices: [], cues: [], audioFiles: [], jobs: [] })),
    listVoices: vi.fn(() => []),
    saveCue: vi.fn((args) => ({ ...args, id: 'cue', rowVersion: 0 }) as DubbingCueInfo),
    generateTake: vi.fn(() => ({ id: 'audio-job' }) as DubbingJobInfo),
  };
  const service = new MediaReviewService(projects, media, submission, dubbing);
  const image = (key = 'character') => ({ key, label: key, kind: 'image', prompt: '角色设定图' });
  const owner = { conversationId: conversation.id };
  const addAsset = (id: string) => {
    const relativePath = `assets/${id}.png`;
    mkdirSync(join(projects.current()!.rootPath, 'assets'), { recursive: true });
    writeFileSync(join(projects.current()!.rootPath, relativePath), 'image');
    projects.access(true, (db, project) =>
      createRepositories(db).assets.save({
        id,
        projectId: project.id,
        kind: 'character',
        relativePath,
        sizeBytes: 5,
        contentHash: 'hash',
        createdAt: new Date().toISOString(),
      }),
    );
  };
  return {
    projects,
    content,
    conversation,
    media,
    submission,
    dubbing,
    service,
    image,
    owner,
    results,
    addAsset,
  };
}

describe('production skills and persistent media reviews', () => {
  it('loads declarative skills through the shared registry, without executing business logic', () => {
    expect(readProductionSkill({ skillId: 'chapters-to-script' })).toMatchObject({
      revision: 1,
      skillId: 'chapters-to-script',
    });
    expect(readProductionSkill({ skillId: 'script-to-media' }).instructions).toContain(
      'media.review.prepare',
    );
    expect(() => readProductionSkill({ skillId: 'other' })).toThrow();
    expect(unifiedAgentToolRegistry.require('production.skill.read').riskLevel).toBe('R0');
    expect(unifiedAgentToolRegistry.require('media.review.prepare').riskLevel).toBe('R1');
    expect(validateSessionRequestParams('media.review.list', {})).toEqual({});
    expect(() =>
      validateSessionRequestParams('media.review.submit', { formId: 'id', expectedRowVersion: -1 }),
    ).toThrow();
  });
  it('prepares multiple forms without Provider calls and deduplicates retries across service recreation', () => {
    const f = fixture();
    const first = f.service.prepare(f.image(), f.owner);
    const video = f.service.prepare(
      {
        key: 'shot-video',
        label: '镜头视频',
        kind: 'video',
        prompt: '图1角色在雨中转身',
        inputReferences: [{ reviewFormId: first.id, resultIndex: 0 }],
      },
      f.owner,
    );
    expect(video.blockers.join()).toContain('等待参考图');
    const reopened = new MediaReviewService(f.projects, f.media, f.submission, f.dubbing);
    expect(reopened.prepare(f.image(), f.owner).id).toBe(first.id);
    expect(reopened.list(f.conversation.id)).toHaveLength(2);
    expect(JSON.stringify(reopened.list(f.conversation.id))).not.toContain('角色设定图');
    expect(f.media.prepareSelected).not.toHaveBeenCalled();
    expect(f.submission.confirmSubmission).not.toHaveBeenCalled();
    expect(f.dubbing.generateTake).not.toHaveBeenCalled();
  });
  it('carries every saved character, scene, and prop binding into the review form', () => {
    const f = fixture();
    const character = f.content.saveDocument({
      kind: 'character',
      title: '顾清影',
      contentMarkdown: '角色设定',
    });
    const sceneDocument = f.content.saveDocument({
      kind: 'scene',
      title: '屋外雨坪',
      contentMarkdown: '场景设定',
    });
    const propDocument = f.content.saveDocument({
      kind: 'prop',
      title: '斗笠',
      contentMarkdown: '道具设定',
    });
    f.addAsset('bound-character');
    f.addAsset('bound-scene');
    f.addAsset('bound-prop');
    const scene = f.content.saveScene({
      title: '雨夜决战',
      characterBindings: [{ characterDocumentId: character.id, imageAssetId: 'bound-character' }],
      materialBindings: [
        {
          id: 'scene-reference',
          role: 'scene',
          label: '屋外雨坪',
          assetId: 'bound-scene',
          sourceDocumentId: sceneDocument.id,
          source: 'manual',
        },
        {
          id: 'prop-reference',
          role: 'prop',
          label: '斗笠',
          assetId: 'bound-prop',
          sourceDocumentId: propDocument.id,
          source: 'manual',
        },
      ],
    });
    const shot = f.content.saveShot({
      sceneId: scene.id,
      title: '顾清影破阵',
      prompt: '顾清影破阵',
    });

    const form = f.service.prepare(
      {
        key: 'bound-shot-video',
        label: '绑定完整的镜头视频',
        kind: 'video',
        shotId: shot.id,
        prompt: '图1顾清影在雨中破阵，图2为雨坪，图3为斗笠',
      },
      f.owner,
    );

    expect(form.draft.inputReferences).toEqual([
      { assetId: 'bound-character' },
      { assetId: 'bound-scene' },
      { assetId: 'bound-prop' },
    ]);
    expect(form.inputAssetIds).toEqual(['bound-character', 'bound-scene', 'bound-prop']);
    expect(f.media.selectionRequest).toHaveBeenCalledTimes(1);
  });
  it('blocks missing dependency results, resolves exact result index in order, and detects deleted media', async () => {
    const f = fixture();
    const image = f.service.prepare(f.image(), f.owner);
    const video = f.service.prepare(
      {
        key: 'video',
        label: '视频',
        kind: 'video',
        prompt: '图1角色与图2场景',
        inputReferences: [
          { reviewFormId: image.id, resultIndex: 1 },
          { reviewFormId: image.id, resultIndex: 0 },
        ],
      },
      f.owner,
    );
    await expect(
      f.service.submit({
        formId: video.id,
        expectedRowVersion: 0,
        reviewToken: f.service.get(video.id).reviewToken ?? 'blocked',
        selection,
      }),
    ).rejects.toThrow('等待参考图');
    await f.service.submit({
      formId: image.id,
      expectedRowVersion: 0,
      reviewToken: f.service.get(image.id).reviewToken ?? 'blocked',
      selection,
    });
    expect(f.service.get(video.id).blockers.join()).toContain('尚无第');
    f.addAsset('a');
    f.addAsset('b');
    f.results.set('job-1', ['a', 'b']);
    expect(f.service.get(video.id).inputAssetIds).toEqual(['b', 'a']);
    f.projects.access(true, (db) =>
      db.prepare("UPDATE assets SET deleted_at='2026-10-24' WHERE id='b'").run(),
    );
    expect(f.service.get(video.id).blockers.join()).toContain('deleted');
  });
  it('submits reviewed parameters through the sole paid boundary once, including concurrent and terminal replays', async () => {
    const f = fixture();
    const form = f.service.prepare(f.image(), f.owner);
    let finish!: (value: MediaSubmissionResult) => void;
    f.submission.confirmSubmission.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.service.submit({
      formId: form.id,
      expectedRowVersion: 0,
      reviewToken: f.service.get(form.id).reviewToken ?? 'blocked',
      selection,
    });
    const concurrent = await f.service.submit({
      formId: form.id,
      expectedRowVersion: 0,
      reviewToken: f.service.get(form.id).reviewToken ?? 'blocked',
      selection,
    });
    expect(concurrent.status).toBe('submitting');
    finish({ kind: 'image', job: { id: 'job-1' } } as MediaSubmissionResult);
    const saved = await first;
    expect(saved.status).toBe('submitted');
    expect(
      await f.service.submit({
        formId: form.id,
        expectedRowVersion: 0,
        reviewToken: f.service.get(form.id).reviewToken ?? 'blocked',
        selection,
      }),
    ).toMatchObject({ jobId: 'job-1' });
    expect(f.media.prepareSelected).toHaveBeenCalledTimes(1);
    expect(f.submission.confirmSubmission).toHaveBeenCalledExactlyOnceWith({
      jobId: 'job-1',
      confirmationToken: 'review-token',
      approved: true,
    });
    expect(f.media.prepareSelected).toHaveBeenCalledWith(
      expect.anything(),
      selection,
      expect.anything(),
    );
  });
  it('does not create a replacement job when a submission result is uncertain', async () => {
    const f = fixture();
    const form = f.service.prepare(f.image(), f.owner);
    f.submission.confirmSubmission.mockRejectedValueOnce(new Error('network timeout'));
    expect(
      await f.service.submit({
        formId: form.id,
        expectedRowVersion: 0,
        reviewToken: f.service.get(form.id).reviewToken ?? 'blocked',
        selection,
      }),
    ).toMatchObject({ status: 'submitted', jobId: 'job-1', error: 'network timeout' });
    await f.service.submit({
      formId: form.id,
      expectedRowVersion: 0,
      reviewToken: f.service.get(form.id).reviewToken ?? 'blocked',
      selection,
    });
    expect(f.media.prepareSelected).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale reviewed model context before creating or submitting a paid job', async () => {
    const f = fixture();
    const form = f.service.prepare(f.image(), f.owner);
    const shown = f.service.get(form.id);
    const previous = f.media.selectionContext;
    f.media.selectionContext = (...args) => ({
      ...previous(...args),
      arguments: { ...previous(...args).arguments, parameters: { revisedContract: true } },
    });
    await expect(
      f.service.submit({
        formId: form.id,
        expectedRowVersion: form.rowVersion,
        reviewToken: shown.reviewToken!,
        selection,
      }),
    ).rejects.toThrow('模型合同');
    expect(f.media.prepareSelected).not.toHaveBeenCalled();
    expect(f.submission.confirmSubmission).not.toHaveBeenCalled();
    expect(f.service.get(form.id).status).toBe('pending');
  });
  it('rejects wrong reference types, cross-conversation dependencies, cycles and stale form edits', () => {
    const f = fixture();
    const image = f.service.prepare(f.image(), f.owner);
    const other = f.content.createConversation({ scopeType: 'project' });
    expect(() =>
      f.service.prepare(
        { ...f.image('other'), inputReferences: [{ reviewFormId: image.id, resultIndex: 0 }] },
        { conversationId: other.id },
      ),
    ).toThrow('同会话');
    const second = f.service.prepare(
      { ...f.image('second'), inputReferences: [{ reviewFormId: image.id, resultIndex: 0 }] },
      f.owner,
    );
    expect(() =>
      f.service.prepare(
        {
          ...f.image(),
          expectedRowVersion: 0,
          inputReferences: [{ reviewFormId: second.id, resultIndex: 0 }],
        },
        f.owner,
      ),
    ).toThrow('循环');
    expect(() => f.service.prepare({ ...f.image(), prompt: '变更' }, f.owner)).toThrow('版本');
    expect(() =>
      f.service.prepare(
        { ...f.image('missing'), inputReferences: [{ assetId: 'missing' }] },
        f.owner,
      ),
    ).toThrow('不可用');
  });
  it('freezes source versions and validates character/scene/prop ownership instead of guessing names', () => {
    const f = fixture();
    const document = f.content.saveDocument({
      kind: 'character',
      title: '顾清影',
      contentMarkdown: '角色设定',
      scopeType: 'project',
    });
    const draft = { ...f.image(), assetKind: 'character', sourceDocumentId: document.id };
    const form = f.service.prepare(draft, f.owner);
    expect(form.draft.sourceVersionId).toBe(document.currentVersionId);
    expect(() => f.service.prepare({ ...draft, key: 'wrong', assetKind: 'prop' }, f.owner)).toThrow(
      '类型',
    );
    f.content.saveDocument({
      documentId: document.id,
      title: document.title,
      contentMarkdown: '更新角色设定',
    });
    expect(f.service.get(form.id).blockers.join()).toContain('已变化');
  });
  it('prepares audio locally and uses existing cue/save/take execution only after the reviewed submit', async () => {
    const f = fixture();
    const scene = f.content.saveScene({ title: '雨夜' });
    const audio = {
      sceneId: scene.id,
      speakerKind: 'narration' as const,
      text: '雨夜将至',
      position: 0,
      startMs: 0,
    };
    const form = f.service.prepare(
      { key: 'narration', label: '旁白', kind: 'audio', prompt: '冷静叙述', audio },
      f.owner,
    );
    expect(f.dubbing.saveCue).not.toHaveBeenCalled();
    await f.service.submit({
      formId: form.id,
      expectedRowVersion: 0,
      reviewToken: f.service.get(form.id).reviewToken ?? 'blocked',
      audio: { ...audio, text: '审核后的旁白', voiceProfileId: 'voice' },
    });
    expect(f.dubbing.saveCue).toHaveBeenCalledWith(
      expect.objectContaining({ text: '审核后的旁白' }),
    );
    expect(f.dubbing.generateTake).toHaveBeenCalledExactlyOnceWith({
      cueId: 'cue',
      expectedRowVersion: 0,
      costAcknowledged: true,
    });
    await f.service.submit({
      formId: form.id,
      expectedRowVersion: 0,
      reviewToken: f.service.get(form.id).reviewToken ?? 'blocked',
      audio,
    });
    expect(f.dubbing.generateTake).toHaveBeenCalledTimes(1);
  });
});
