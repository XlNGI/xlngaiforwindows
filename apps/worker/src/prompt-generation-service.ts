import { randomUUID } from 'node:crypto';
import {
  PROMPT_PURPOSES,
  PRODUCTION_BUNDLE_LIMITS,
  promptPurposeForKind,
} from '@ai-video/contracts';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';
import type { ProjectService } from './project-service.js';
import type { ContentService } from './content-service.js';
import type { DocumentWorkflowService } from './document-workflow-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import type { ContextRecoverySnapshot } from './agent-context-manager.js';
import { loadPromptGeneration, preparePromptGeneration } from './prompt-generation-state.js';
import { loadBundle, stageBundle } from './production-bundle-state.js';
import { submitBundle } from './production-bundle-submission.js';
import { ProductionBundleService } from './production-bundle-service.js';
import { MAX_BUNDLE_PROMPTS_PER_SUBMISSION } from './production-bundle-schema.js';

/** Both entry points share the existing bundle transaction, storage and independent readback. */
export class PromptGenerationService {
  constructor(
    private projects: ProjectService,
    private content: ContentService,
    private documents: DocumentWorkflowService,
    private serialize: (value: unknown) => string,
  ) {}
  execute(
    operation: 'request' | 'submit',
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    if (!identity.taskId || !identity.toolCallId)
      throw new Error('PROMPT_GENERATION_TASK_REQUIRED');
    return this.projects.access(true, (db, project) => {
      if (
        identity.projectId !== project.id ||
        identity.projectSessionId !== this.projects.currentSessionId()
      )
        throw new Error('PROMPT_GENERATION_PROJECT_SESSION_CONFLICT');
      const store = new AgentContextStore(db);
      const oldUpdatedAt = project.updatedAt;
      try {
        return db.transaction(() => {
          if (operation === 'request') {
            const runtime = store.loadRuntime<ContextRecoverySnapshot>(
              project.id,
              identity.taskId!,
            )?.runtime;
            if (!runtime) throw new Error('PROMPT_GENERATION_RUNTIME_REQUIRED');
            const prepared = preparePromptGeneration(
              db,
              project.id,
              identity.taskId!,
              args,
              runtime,
            );
            return {
              status: 'prompt_generation_prepared',
              requestHash: prepared.requestHash,
              purposes: prepared.purposes,
              businessSaved: false,
              instruction:
                'The Worker will provide complete frozen sources and scoped templates in the next request. Return all complete prompts and explicit bindings using prompt.generation.submit.',
            };
          }
          const input = loadPromptGeneration(db, project.id, identity.taskId!);
          if (!input || args.requestHash !== input.requestHash)
            throw new Error('PROMPT_GENERATION_REQUEST_CONFLICT');
          if (
            Object.keys(args).some((k) => !['requestHash', 'prompts'].includes(k)) ||
            !Array.isArray(args.prompts) ||
            !args.prompts.length ||
            args.prompts.length > PRODUCTION_BUNDLE_LIMITS.objects
          )
            throw new Error('PROMPT_GENERATION_INVALID: return a nonempty complete prompts list.');
          if (Buffer.byteLength(JSON.stringify(args)) > PRODUCTION_BUNDLE_LIMITS.bundleBytes)
            throw new Error('PROMPT_GENERATION_OUTPUT_TOO_LARGE');
          const requestHash = contextContentHash(JSON.stringify(args));
          const prior = store.resultForCall(
            project.id,
            identity.taskId!,
            'prompt-generation:receipt',
          );
          if (prior) {
            const saved = JSON.parse(prior.content) as {
              requestHash: string;
              result: Record<string, unknown>;
            };
            if (saved.requestHash !== requestHash)
              throw new Error(
                'PROMPT_GENERATION_ALREADY_SAVED: use an explicit CAS edit for subsequent changes.',
              );
            const readback = new ProductionBundleService(
              this.projects,
              this.content,
              this.documents,
              this.serialize,
            ).execute({ operation: 'readback' }, identity);
            return {
              ...saved.result,
              ...readback,
              readbackVerified: readback.verified === true,
              replayed: true,
            };
          }
          const prompts = args.prompts as Array<Record<string, unknown>>;
          const keys = new Set<string>();
          for (const prompt of prompts) {
            const purpose = promptPurposeForKind(String(prompt.kind));
            if (!purpose || !input.purposes.includes(purpose))
              throw new Error(
                `PROMPT_GENERATION_PURPOSE_INVALID: ${String(prompt.localKey)} kind=${String(prompt.kind)} is outside frozen purposes ${input.purposes.join(',')}. Return only authorized kinds; a new purpose requires a separate explicitly scoped task.`,
              );
            if (!prompt.bindings)
              throw new Error(
                `PROMPT_GENERATION_BINDINGS_REQUIRED: ${String(prompt.localKey)} must include explicit bindings with schemaVersion=1; relationship arrays may be empty only when absent.`,
              );
            const key = `${String(prompt.kind) === 'shot-image' ? 'image' : 'object'}:${String(prompt.localKey)}`;
            if (keys.has(key))
              throw new Error(`PROMPT_GENERATION_DUPLICATE_KEY: ${String(prompt.localKey)}`);
            keys.add(key);
          }
          // Revisions and purpose transitions are server-owned, never model work.
          const submissionId = randomUUID();
          let index = 0;
          for (const purpose of [
            ...PROMPT_PURPOSES.filter((p) => p !== 'shot-image'),
            'shot-image' as const,
          ]) {
            const selected = prompts.filter(
              (p) => promptPurposeForKind(String(p.kind)) === purpose,
            );
            if (!selected.length) continue;
            const state = loadBundle(db, project.id, identity.taskId!)!;
            stageBundle(db, project.id, identity.taskId!, {
              operation: 'purpose',
              purpose,
              expectedStageVersion: state.stage?.version ?? 0,
              stageKey: `${submissionId}:${purpose}`,
            });
            let chunk: Array<Record<string, unknown>> = [];
            const flush = () => {
              if (!chunk.length) return;
              submitBundle(db, project.id, identity.taskId!, {
                partKey: `${submissionId}:${index++}`,
                expectedRevision: loadBundle(db, project.id, identity.taskId!)!.revision,
                prompts: chunk,
              });
              chunk = [];
            };
            for (const prompt of selected) {
              if (
                chunk.length &&
                (chunk.length >= MAX_BUNDLE_PROMPTS_PER_SUBMISSION ||
                  Buffer.byteLength(JSON.stringify({ prompts: [...chunk, prompt] })) >
                    PRODUCTION_BUNDLE_LIMITS.partBytes - 1024)
              )
                flush();
              chunk.push(prompt);
            }
            flush();
          }
          const state = loadBundle(db, project.id, identity.taskId!)!;
          const keysFor = (kind: string) =>
            state.entries.filter((e) => e.kind === kind).map((e) => e.key);
          stageBundle(db, project.id, identity.taskId!, {
            operation: 'seal',
            expectedRevision: state.revision,
            manifest: {
              documentKeys: keysFor('document'),
              sceneKeys: keysFor('scene'),
              shotKeys: keysFor('shot'),
            },
          });
          const result = new ProductionBundleService(
            this.projects,
            this.content,
            this.documents,
            this.serialize,
          ).execute({ operation: 'check' }, identity);
          if (result.businessSaved !== true || result.readbackVerified !== true)
            throw new Error(`PROMPT_GENERATION_STRUCTURE_REQUIRED: ${JSON.stringify(result)}`);
          store.putResult(
            project.id,
            identity.taskId!,
            'prompt-generation:receipt',
            'prompt.generation.receipt',
            JSON.stringify({ requestHash, result }),
          );
          return result;
        })();
      } catch (error) {
        project.updatedAt = oldUpdatedAt;
        throw error;
      }
    });
  }
}
