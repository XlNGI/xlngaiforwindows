import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContextStore } from '@ai-video/persistence';
import type { ProductionBundlePart } from '@ai-video/contracts';
import { ProjectService } from '../project-service.js';
import { ContentService } from '../content-service.js';
import { ContextService } from '../context-service.js';
import { GenerationService } from '../generation-service.js';
import { DocumentWorkflowService } from '../document-workflow-service.js';
import { AgentProviderLoopService } from '../agent-provider-loop-service.js';
import {
  AgentSystemToolService,
  type AgentAssetToolService,
} from '../agent-system-tool-service.js';
import { stageBundle } from '../production-bundle-state.js';
export async function productionBundleFixture(
  protocol: 'openai-responses' | 'openai-chat-completions' = 'openai-responses',
) {
  const root = await mkdtemp(join(tmpdir(), 'production-bundle-'));
  const project = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  project.create(join(root, 'project'), 'Bundle');
  const content = new ContentService(project),
    workflow = new DocumentWorkflowService(project);
  const source = content.saveDocument({
    kind: 'plan',
    title: '剧本',
    contentMarkdown: '主角接听画外客服的电话。客服说“订单正常”。主角说“谢谢”。',
  });
  const conversation = content.createConversation({ scopeType: 'project' });
  const generations = new GenerationService(
    project,
    content,
    new ContextService(project),
    {
      status: () => ({ key: 'mock', name: 'Mock', model: 'mock', configured: false }),
      stream: () => Promise.reject(new Error('No real provider permitted')),
    },
    {
      selectionResolver: {
        resolveLlmSelection: () => ({
          providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
          providerName: 'Mock',
          modelId: '123e4567-e89b-42d3-a456-426614174001',
          modelName: 'Mock',
          remoteModelId: 'mock',
          protocol,
          baseUrl: 'https://mock.invalid/v1',
        }),
      },
    },
  );
  const prepared = generations.prepare({
    conversationId: conversation.id,
    prompt: '保存完整提示词和声音绑定。',
    providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
    modelId: '123e4567-e89b-42d3-a456-426614174001',
  });
  const system = new AgentSystemToolService(
    project,
    content,
    {} as AgentAssetToolService,
    { listProfiles: () => [], listModels: () => [] },
    undefined,
    workflow,
  );
  const loop = new AgentProviderLoopService(
    project,
    workflow,
    undefined,
    undefined,
    undefined,
    undefined,
    system,
  );
  const task = loop.prepare(
    prepared.stream,
    '保存完整提示词和声音绑定。',
    undefined,
    { operation: 'document.list' },
    'project_only',
    undefined,
    undefined,
    undefined,
    undefined,
    'script-to-media',
    {
      version: 2,
      sources: [{ documentId: source.id, versionId: source.currentVersion!.id }],
      requestedAt: new Date(Date.now() - 5000).toISOString(),
    },
  );
  const identity = { ...prepared.stream, taskId: task.taskId, toolCallId: crypto.randomUUID() };
  project.access(true, (db, p) => {
    new AgentContextStore(db).saveTask(p.id, prepared.stream.generationId, conversation.id, {
      taskId: task.taskId,
      taskGoal: '保存完整提示词和声音绑定。',
      userRequirements: [
        { id: 'original', text: '保存完整提示词和声音绑定。', source: 'current-user-request' },
      ],
      projectConstraints: [],
      confirmedDecisions: [],
      currentStage: 'initial',
      completedSteps: [],
      pendingSteps: [],
      executionStatus: 'running',
      generatedArtifacts: [],
    });
  });
  const stage = (args: Record<string, unknown>) =>
    project.access(true, (db, p) =>
      db.transaction(() => stageBundle(db, p.id, task.taskId, args))(),
    );
  return {
    root,
    project,
    content,
    workflow,
    source,
    conversation,
    generations,
    prepared,
    loop,
    task,
    identity,
    stage,
  };
}
export function bundlePart(): ProductionBundlePart {
  return {
    documents: [
      {
        localKey: 'hero',
        kind: 'character',
        title: '主角',
        contentMarkdown: '主角的完整提示词。',
        bindings: { schemaVersion: 1, voiceDocumentId: { localKey: 'voice-hero' } },
      },
      {
        localKey: 'operator',
        kind: 'character',
        title: '画外客服',
        contentMarkdown: '客服的完整提示词。',
        bindings: { schemaVersion: 1, voiceDocumentId: { localKey: 'voice-operator' } },
      },
      { localKey: 'room', kind: 'scene', title: '房间', contentMarkdown: '房间的完整提示词。' },
      { localKey: 'phone', kind: 'prop', title: '手机', contentMarkdown: '手机的完整提示词。' },
      {
        localKey: 'voice-hero',
        kind: 'voice',
        title: '主角音色',
        contentMarkdown: '主角音色描述。',
        sampleText: '谢谢。',
      },
      {
        localKey: 'voice-operator',
        kind: 'voice',
        title: '客服音色',
        contentMarkdown: '客服音色描述。',
        sampleText: '您好，订单正在处理。',
      },
    ],
    scenes: [
      {
        localKey: 'scene-1',
        title: '接听电话',
        prompt: '主角拿起手机。画外客服说“订单正常”。主角说“谢谢”。',
      },
    ],
    shots: [
      {
        localKey: 'shot-1',
        sceneKey: 'scene-1',
        title: '接听',
        prompt: '主角拿起手机。画外客服说“订单正常”。主角说“谢谢”。',
        timing: { estimatedDurationSeconds: 15 },
        bindings: {
          schemaVersion: 1,
          characterDocumentIds: [{ localKey: 'hero' }],
          sceneDocumentIds: [{ localKey: 'room' }],
          propDocumentIds: [{ localKey: 'phone' }],
          voiceBindings: [
            {
              characterDocumentId: { localKey: 'operator' },
              voiceDocumentId: { localKey: 'voice-operator' },
            },
            {
              characterDocumentId: { localKey: 'hero' },
              voiceDocumentId: { localKey: 'voice-hero' },
            },
          ],
        },
      },
    ],
  };
}
export function bundleManifest(part = bundlePart()) {
  return {
    documentKeys: part.documents.map((d) => d.localKey),
    sceneKeys: part.scenes.map((s) => s.localKey),
    shotKeys: part.shots.map((s) => s.localKey),
  };
}
export function bundleSubmissionFixture() {
  const part = bundlePart();
  part.scenes[0]!.prompt = part.shots[0]!.prompt;
  const prompts = [
    ...part.documents.map(({ contentMarkdown, kind, ...document }) => ({
      ...document,
      kind: kind === 'scene' ? ('location' as const) : kind,
      prompt: contentMarkdown,
    })),
    ...part.scenes.map((scene) => ({
      ...scene,
      kind: 'scene' as const,
      prompt: scene.prompt!,
    })),
    ...part.shots.map((shot) => ({ ...shot, kind: 'shot' as const })),
  ];
  return { part, submission: { prompts } };
}
