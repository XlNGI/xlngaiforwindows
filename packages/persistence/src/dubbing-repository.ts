import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  DUBBING_CONTRACT_REVISION,
  DUBBING_LIMITS,
  type AudioFileInfo,
  type AudioListParams,
  type CharacterVoiceSaveParams,
  type DubbingCueInfo,
  type DubbingCueSaveParams,
  type DubbingJobInfo,
  type DubbingJobStepInfo,
  type DubbingTakeInfo,
  type VoiceProfileInfo,
  type VoiceSettings,
} from '@ai-video/contracts';

type Row = Record<string, string | number | null>;
export class DubbingConflictError extends Error {
  constructor() {
    super('Dubbing data changed. Reload before saving.');
    this.name = 'DubbingConflictError';
  }
}
export class DubbingReferenceError extends Error {
  constructor() {
    super('This media is referenced by saved dubbing history or an active task.');
    this.name = 'DubbingReferenceError';
  }
}
export type DubbingJobPatch = Partial<
  Pick<
    DubbingJobInfo,
    | 'status'
    | 'providerTaskId'
    | 'outputAudioId'
    | 'outputAssetId'
    | 'adoptedAt'
    | 'error'
    | 'errorKind'
    | 'deadline'
  >
>;
export type DubbingStepPatch = Partial<
  Pick<
    DubbingJobStepInfo,
    | 'status'
    | 'providerTaskId'
    | 'providerAssetId'
    | 'providerAssetExpiresAt'
    | 'region'
    | 'resultAudioId'
    | 'resultAssetId'
    | 'resultRelativePath'
    | 'resultContentHash'
    | 'deadline'
    | 'error'
    | 'errorKind'
  >
>;

/** All queries are bound to the owning project, including CAS and history reads. */
export class DubbingRepository {
  constructor(
    private readonly database: Database.Database,
    readonly projectId: string,
  ) {}

  private own(projectId: string): void {
    if (projectId !== this.projectId) throw new Error('Dubbing data belongs to another project.');
  }
  private row(sql: string, ...bindings: (string | number)[]): Row | undefined {
    return this.database.prepare(sql).get(...bindings) as Row | undefined;
  }
  private rows(sql: string, ...bindings: (string | number)[]): Row[] {
    return this.database.prepare(sql).all(...bindings) as Row[];
  }

  getVoice(id: string): VoiceProfileInfo | undefined {
    const row = this.row(
      `SELECT p.*,v.id AS version_id,v.revision,v.provider_profile_id,v.model_id,
      v.voice_id,v.contract_revision,v.settings_json,v.region,v.reference_audio_id
      FROM character_voice_profiles p JOIN character_voice_profile_versions v ON v.id=p.current_version_id
      WHERE p.id=? AND p.project_id=?`,
      id,
      this.projectId,
    );
    return row ? mapVoice(row) : undefined;
  }
  getVoiceForCharacter(characterDocumentId: string): VoiceProfileInfo | undefined {
    const row = this.row(
      'SELECT id FROM character_voice_profiles WHERE project_id=? AND character_document_id=?',
      this.projectId,
      characterDocumentId,
    );
    return row ? this.getVoice(str(row, 'id')) : undefined;
  }
  getVoiceVersion(versionId: string): VoiceProfileInfo | undefined {
    const row = this.row(
      `SELECT p.*,v.id AS version_id,v.revision,v.provider_profile_id,v.model_id,
      v.voice_id,v.contract_revision,v.settings_json,v.region,v.reference_audio_id
      FROM character_voice_profile_versions v JOIN character_voice_profiles p ON p.id=v.profile_id
      WHERE v.id=? AND v.project_id=?`,
      versionId,
      this.projectId,
    );
    return row ? mapVoice(row) : undefined;
  }
  listVoices(includeArchived = false): VoiceProfileInfo[] {
    return this.rows(
      `SELECT id FROM character_voice_profiles WHERE project_id=?
      ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY created_at,id`,
      this.projectId,
    )
      .map((row) => this.getVoice(str(row, 'id')))
      .filter((voice): voice is VoiceProfileInfo => !!voice);
  }
  saveVoice(input: CharacterVoiceSaveParams, now = new Date().toISOString()): VoiceProfileInfo {
    if (!input.providerProfileId.trim() || !input.model.trim() || !input.voiceId.trim())
      throw new Error('A provider, model and fixed voice are required.');
    if (
      !Number.isFinite(input.speed) ||
      input.speed < 0.5 ||
      input.speed > 2 ||
      !Number.isInteger(input.pitch) ||
      input.pitch < -12 ||
      input.pitch > 12
    )
      throw new Error('Invalid voice speed or pitch.');
    return this.database.transaction(() => {
      const existing = input.id
        ? this.getVoice(input.id)
        : input.characterDocumentId
          ? this.getVoiceForCharacter(input.characterDocumentId)
          : undefined;
      if (input.id && !existing) throw new Error('Voice profile does not belong to this project.');
      if (existing && input.expectedRowVersion !== existing.rowVersion)
        throw new DubbingConflictError();
      if (!existing && input.expectedRowVersion !== undefined && input.expectedRowVersion !== 0)
        throw new DubbingConflictError();
      if (existing && input.characterDocumentId !== existing.characterDocumentId)
        throw new Error('A voice profile cannot move to a different character.');
      if (existing?.archivedAt) throw new Error('Archived voice profiles cannot be edited.');
      const id = existing?.id ?? randomUUID();
      const versionId = randomUUID();
      const revision = (existing?.revision ?? 0) + 1;
      if (!existing)
        this.database
          .prepare(
            `INSERT INTO character_voice_profiles
        (id,project_id,character_document_id,row_version,created_at,updated_at) VALUES (?,?,?,1,?,?)`,
          )
          .run(id, this.projectId, input.characterDocumentId ?? null, now, now);
      const settings: VoiceSettings = {
        speed: input.speed,
        pitch: input.pitch,
        languageBoost: input.languageBoost,
      };
      this.database
        .prepare(
          `INSERT INTO character_voice_profile_versions
        (id,profile_id,project_id,revision,provider_profile_id,model_id,contract_revision,voice_id,settings_json,region,reference_audio_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          versionId,
          id,
          this.projectId,
          revision,
          input.providerProfileId,
          input.model,
          DUBBING_CONTRACT_REVISION,
          input.voiceId,
          JSON.stringify(settings),
          input.region ?? null,
          input.referenceAudioId ?? null,
          now,
        );
      const result = this.database
        .prepare(
          `UPDATE character_voice_profiles SET current_version_id=?,updated_at=?,row_version=row_version+?
        WHERE id=? AND project_id=? AND row_version=?`,
        )
        .run(versionId, now, existing ? 1 : 0, id, this.projectId, existing?.rowVersion ?? 1);
      if (result.changes !== 1) throw new DubbingConflictError();
      return this.getVoice(id)!;
    })();
  }
  archiveVoice(
    id: string,
    expectedRowVersion: number,
    now = new Date().toISOString(),
  ): VoiceProfileInfo {
    if (
      this.database
        .prepare(
          `UPDATE character_voice_profiles SET archived_at=?,updated_at=?,row_version=row_version+1
      WHERE id=? AND project_id=? AND row_version=?`,
        )
        .run(now, now, id, this.projectId, expectedRowVersion).changes !== 1
    )
      throw new DubbingConflictError();
    return this.getVoice(id)!;
  }

  getCue(id: string): DubbingCueInfo | undefined {
    const row = this.row(
      'SELECT * FROM dubbing_cues WHERE id=? AND project_id=?',
      id,
      this.projectId,
    );
    return row ? { ...mapCue(row), takes: this.listTakes(id) } : undefined;
  }
  listCues(sceneId: string): DubbingCueInfo[] {
    return this.rows(
      'SELECT * FROM dubbing_cues WHERE project_id=? AND scene_id=? AND deleted_at IS NULL ORDER BY position,id',
      this.projectId,
      sceneId,
    ).map((row) => ({ ...mapCue(row), takes: this.listTakes(str(row, 'id')) }));
  }
  saveCue(input: DubbingCueSaveParams, now = new Date().toISOString()): DubbingCueInfo {
    if (!input.text.trim() || [...input.text].length > DUBBING_LIMITS.cueTextMaxCharacters)
      throw new Error('Dialogue must contain 1 to 4000 characters.');
    for (const value of [input.position, input.startMs, input.trailingPauseMs ?? 0]) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('Dialogue times and positions must be non-negative integers.');
    }
    if (
      input.startMs > DUBBING_LIMITS.sceneMaxDurationMs ||
      (input.trailingPauseMs ?? 0) > DUBBING_LIMITS.clipMaxDurationMs
    )
      throw new Error('Dialogue exceeds scene time limits.');
    if (
      input.speakerCoordinates &&
      (input.speakerCoordinates.length !== 2 ||
        input.speakerCoordinates.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
    )
      throw new Error('Speaker coordinates must be between zero and one.');
    return this.database.transaction(() => {
      const existing = input.id ? this.getCue(input.id) : undefined;
      if (input.id && !existing) throw new Error('Dialogue does not belong to this project.');
      if (existing && input.expectedRowVersion !== existing.rowVersion)
        throw new DubbingConflictError();
      if (existing?.deletedAt) throw new Error('Deleted dialogue cannot be edited.');
      const id = existing?.id ?? randomUUID();
      const args = [
        input.shotId ?? null,
        input.speakerKind,
        input.characterDocumentId ?? null,
        input.voiceProfileId ?? null,
        input.text,
        input.position,
        input.startMs,
        input.emotion ?? null,
        input.visibleSpeaker ?? null,
        input.lipSync ? 1 : 0,
        input.speakerCoordinates ? JSON.stringify(input.speakerCoordinates) : null,
        input.trailingPauseMs ?? 0,
      ];
      if (existing) {
        if (input.sceneId !== existing.sceneId)
          throw new Error('Dialogue cannot move to a different scene.');
        const changedVoice =
          input.text !== existing.text ||
          input.speakerKind !== existing.speakerKind ||
          input.characterDocumentId !== existing.characterDocumentId ||
          input.voiceProfileId !== existing.voiceProfileId ||
          input.emotion !== existing.emotion;
        // Timing/visual edits can reuse confirmed speech. Changed dialogue keeps old takes as history.
        const changed = this.database
          .prepare(
            `UPDATE dubbing_cues SET shot_id=?,speaker_kind=?,character_document_id=?,voice_profile_id=?,
          text=?,position=?,start_ms=?,emotion=?,visible_speaker=?,lip_sync=?,speaker_coordinates_json=?,trailing_pause_ms=?,
          selected_take_id=?,row_version=row_version+1,updated_at=? WHERE id=? AND project_id=? AND row_version=?`,
          )
          .run(
            ...args,
            changedVoice ? null : (existing.selectedTakeId ?? null),
            now,
            id,
            this.projectId,
            input.expectedRowVersion,
          );
        if (changed.changes !== 1) throw new DubbingConflictError();
      } else {
        this.database
          .prepare(
            `INSERT INTO dubbing_cues (id,project_id,scene_id,shot_id,speaker_kind,character_document_id,voice_profile_id,
          text,position,start_ms,emotion,visible_speaker,lip_sync,speaker_coordinates_json,trailing_pause_ms,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(id, this.projectId, input.sceneId, ...args, now, now);
      }
      if (
        input.speakerKind === 'character' &&
        input.characterDocumentId &&
        !this.database
          .prepare(
            'SELECT 1 FROM scene_character_bindings WHERE scene_id=? AND character_document_id=?',
          )
          .get(input.sceneId, input.characterDocumentId)
      ) {
        this.database
          .prepare(
            `INSERT INTO scene_character_bindings(scene_id,character_document_id,position)
          VALUES(?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM scene_character_bindings WHERE scene_id=?))`,
          )
          .run(input.sceneId, input.characterDocumentId, input.sceneId);
        this.database
          .prepare(
            'UPDATE scenes SET row_version=row_version+1,updated_at=? WHERE id=? AND project_id=?',
          )
          .run(now, input.sceneId, this.projectId);
      }
      return this.getCue(id)!;
    })();
  }
  deleteCue(id: string, expectedRowVersion: number, now = new Date().toISOString()): void {
    const result = this.database
      .prepare(
        `UPDATE dubbing_cues SET deleted_at=?,updated_at=?,row_version=row_version+1
      WHERE id=? AND project_id=? AND row_version=? AND deleted_at IS NULL`,
      )
      .run(now, now, id, this.projectId, expectedRowVersion);
    if (result.changes !== 1) throw new DubbingConflictError();
  }

  registerAudio(audio: AudioFileInfo): AudioFileInfo {
    this.own(audio.projectId);
    validateAudioPath(audio.relativePath);
    if (!/^[a-f0-9]{64}$/.test(audio.contentHash))
      throw new Error('Audio requires a SHA-256 content hash.');
    if (audio.kind !== 'scene-master' && audio.durationMs > DUBBING_LIMITS.clipMaxDurationMs)
      throw new Error('Audio clip exceeds 60 seconds.');
    this.database
      .prepare(
        `INSERT INTO audio_files (id,project_id,kind,name,relative_path,mime,size_bytes,content_hash,duration_ms,sample_rate,
      channels,source_job_id,deleted_at,trash_relative_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        audio.id,
        audio.projectId,
        audio.kind,
        audio.name,
        audio.relativePath,
        audio.mime,
        audio.sizeBytes,
        audio.contentHash,
        audio.durationMs,
        audio.sampleRate,
        audio.channels,
        audio.sourceJobId ?? null,
        audio.deletedAt ?? null,
        audio.trashRelativePath ?? null,
        audio.createdAt,
      );
    return this.getAudio(audio.id)!;
  }
  getAudio(id: string): AudioFileInfo | undefined {
    const row = this.row(
      'SELECT * FROM audio_files WHERE id=? AND project_id=?',
      id,
      this.projectId,
    );
    return row ? mapAudio(row) : undefined;
  }
  listAudio(options: AudioListParams = {}): AudioFileInfo[] {
    return this.rows(
      `SELECT * FROM audio_files WHERE project_id=? AND deleted_at IS ${options.deleted === 'trash' ? 'NOT ' : ''}NULL
      ${options.kind ? 'AND kind=?' : ''} ORDER BY created_at DESC,id`,
      this.projectId,
      ...(options.kind ? [options.kind] : []),
    ).map(mapAudio);
  }
  countAudioReferences(id: string): number {
    const row = this.row(
      `SELECT
      (SELECT count(*) FROM scenes WHERE project_id=? AND dialogue_audio_id=?) +
      (SELECT count(*) FROM character_voice_reference_versions WHERE project_id=? AND audio_id=?) +
      (SELECT count(*) FROM video_input_audio_references WHERE project_id=? AND audio_id=?) +
      (SELECT count(*) FROM dubbing_takes WHERE project_id=? AND audio_id=?) +
      (SELECT count(*) FROM character_voice_profile_versions WHERE project_id=? AND reference_audio_id=?) +
      (SELECT count(*) FROM dubbing_jobs WHERE project_id=? AND output_audio_id=?) +
      (SELECT count(*) FROM dubbing_job_audio_references r JOIN dubbing_jobs j ON j.id=r.job_id WHERE j.project_id=? AND r.audio_id=?) +
      (SELECT count(*) FROM dubbing_job_steps s JOIN dubbing_jobs j ON j.id=s.job_id WHERE j.project_id=? AND s.result_audio_id=?) AS count`,
      this.projectId,
      id,
      this.projectId,
      id,
      this.projectId,
      id,
      this.projectId,
      id,
      this.projectId,
      id,
      this.projectId,
      id,
      this.projectId,
      id,
      this.projectId,
      id,
    );
    return Number(row?.count ?? 0);
  }
  trashAudio(id: string, trashRelativePath: string, now = new Date().toISOString()): AudioFileInfo {
    const audio = this.getAudio(id);
    if (!audio) throw new Error('Audio does not belong to this project.');
    if (audio.deletedAt) return audio;
    if (this.countAudioReferences(id)) throw new DubbingReferenceError();
    validateAudioPath(trashRelativePath, true);
    this.database
      .prepare(
        'UPDATE audio_files SET deleted_at=?,trash_relative_path=? WHERE id=? AND project_id=?',
      )
      .run(now, trashRelativePath, id, this.projectId);
    return this.getAudio(id)!;
  }
  restoreAudio(id: string): AudioFileInfo {
    if (!this.getAudio(id)) throw new Error('Audio does not belong to this project.');
    this.database
      .prepare(
        'UPDATE audio_files SET deleted_at=NULL,trash_relative_path=NULL WHERE id=? AND project_id=?',
      )
      .run(id, this.projectId);
    return this.getAudio(id)!;
  }
  purgeAudio(id: string): void {
    const audio = this.getAudio(id);
    if (!audio?.deletedAt) throw new Error('Only trashed audio may be purged.');
    if (this.countAudioReferences(id)) throw new DubbingReferenceError();
    this.database
      .prepare('DELETE FROM audio_files WHERE id=? AND project_id=?')
      .run(id, this.projectId);
  }

  addTake(take: DubbingTakeInfo): DubbingTakeInfo {
    this.own(take.projectId);
    this.database
      .prepare(
        `INSERT INTO dubbing_takes (id,project_id,cue_id,cue_row_version,text_hash,voice_version_id,voice_snapshot_json,audio_id,
      source_job_id,parameters_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        take.id,
        this.projectId,
        take.cueId,
        take.cueRowVersion,
        take.textHash,
        take.voiceVersionId ?? null,
        take.voiceSnapshot ? JSON.stringify(take.voiceSnapshot) : null,
        take.audioId,
        take.sourceJobId ?? null,
        JSON.stringify(take.parameters),
        take.createdAt,
      );
    return this.getTake(take.id)!;
  }
  getTake(id: string): DubbingTakeInfo | undefined {
    const row = this.row(
      'SELECT * FROM dubbing_takes WHERE id=? AND project_id=?',
      id,
      this.projectId,
    );
    return row ? mapTake(row) : undefined;
  }
  listTakes(cueId: string): DubbingTakeInfo[] {
    return this.rows(
      'SELECT * FROM dubbing_takes WHERE project_id=? AND cue_id=? ORDER BY created_at DESC,id',
      this.projectId,
      cueId,
    ).map(mapTake);
  }
  adoptTake(
    cueId: string,
    takeId: string,
    expectedRowVersion: number,
    now = new Date().toISOString(),
  ): DubbingCueInfo {
    return this.database.transaction(() => {
      const cue = this.getCue(cueId);
      const take = this.getTake(takeId);
      if (!cue || cue.deletedAt || !take || take.cueId !== cueId)
        throw new Error('Take does not belong to this dialogue.');
      if (cue.rowVersion !== expectedRowVersion) throw new DubbingConflictError();
      if (take.textHash !== createHash('sha256').update(cue.text).digest('hex'))
        throw new Error('This take was made for different dialogue text.');
      if (this.getAudio(take.audioId)?.deletedAt)
        throw new Error('Selected audio is in the recycle bin.');
      const changed = this.database
        .prepare(
          `UPDATE dubbing_cues SET selected_take_id=?,row_version=row_version+1,updated_at=?
        WHERE id=? AND project_id=? AND row_version=?`,
        )
        .run(takeId, now, cueId, this.projectId, expectedRowVersion);
      if (changed.changes !== 1) throw new DubbingConflictError();
      return this.getCue(cueId)!;
    })();
  }

  addJob(job: DubbingJobInfo, audioIds: string[] = []): DubbingJobInfo {
    this.own(job.projectId);
    return this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO dubbing_jobs (id,project_id,scene_id,shot_id,kind,status,plan_version,input_hash,input_snapshot_json,
        budget_json,idempotency_key,source_video_asset_id,provider_task_id,output_audio_id,output_asset_id,adopted_at,error,error_kind,deadline,row_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          job.id,
          this.projectId,
          job.sceneId,
          job.shotId ?? null,
          job.kind,
          job.status,
          job.planVersion,
          job.inputHash,
          JSON.stringify(job.inputSnapshot),
          JSON.stringify(job.budget),
          job.idempotencyKey,
          job.sourceVideoAssetId ?? null,
          job.providerTaskId ?? null,
          job.outputAudioId ?? null,
          job.outputAssetId ?? null,
          job.adoptedAt ?? null,
          job.error ?? null,
          job.errorKind ?? null,
          job.deadline ?? null,
          job.rowVersion,
          job.createdAt,
          job.updatedAt,
        );
      for (const audioId of new Set(audioIds))
        this.database
          .prepare('INSERT INTO dubbing_job_audio_references (job_id,audio_id) VALUES (?,?)')
          .run(job.id, audioId);
      for (const step of job.steps ?? []) this.addStep(step);
      return this.getJob(job.id)!;
    })();
  }
  getJob(id: string): DubbingJobInfo | undefined {
    const row = this.row(
      'SELECT * FROM dubbing_jobs WHERE id=? AND project_id=?',
      id,
      this.projectId,
    );
    return row ? { ...mapJob(row), steps: this.listSteps(id) } : undefined;
  }
  listJobs(sceneId?: string): DubbingJobInfo[] {
    return this.rows(
      `SELECT * FROM dubbing_jobs WHERE project_id=? ${sceneId ? 'AND scene_id=?' : ''} ORDER BY created_at DESC,id`,
      this.projectId,
      ...(sceneId ? [sceneId] : []),
    ).map((row) => ({ ...mapJob(row), steps: this.listSteps(str(row, 'id')) }));
  }
  updateJob(
    id: string,
    patch: DubbingJobPatch,
    expectedRowVersion: number,
    now = new Date().toISOString(),
  ): DubbingJobInfo {
    const existing = this.getJob(id);
    if (!existing || existing.rowVersion !== expectedRowVersion) throw new DubbingConflictError();
    const merged = { ...existing, ...patch };
    const changed = this.database
      .prepare(
        `UPDATE dubbing_jobs SET status=?,provider_task_id=?,output_audio_id=?,output_asset_id=?,adopted_at=?,
      error=?,error_kind=?,deadline=?,row_version=row_version+1,updated_at=? WHERE id=? AND project_id=? AND row_version=?`,
      )
      .run(
        merged.status,
        merged.providerTaskId ?? null,
        merged.outputAudioId ?? null,
        merged.outputAssetId ?? null,
        merged.adoptedAt ?? null,
        merged.error ?? null,
        merged.errorKind ?? null,
        merged.deadline ?? null,
        now,
        id,
        this.projectId,
        expectedRowVersion,
      );
    if (changed.changes !== 1) throw new DubbingConflictError();
    return this.getJob(id)!;
  }
  countVideoReferences(id: string): number {
    const row = this.row(
      `SELECT (SELECT count(*) FROM dubbing_jobs WHERE project_id=? AND (source_video_asset_id=? OR output_asset_id=?)) +
      (SELECT count(*) FROM dubbing_job_steps s JOIN dubbing_jobs j ON j.id=s.job_id WHERE j.project_id=? AND s.result_asset_id=?) AS count`,
      this.projectId,
      id,
      id,
      this.projectId,
      id,
    );
    return Number(row?.count ?? 0);
  }
  addStep(step: DubbingJobStepInfo): DubbingJobStepInfo {
    if (!this.getJobWithoutSteps(step.jobId))
      throw new Error('Job does not belong to this project.');
    if (step.dependencies.length > DUBBING_LIMITS.jobMaxSteps)
      throw new Error('Too many step dependencies.');
    if (
      step.resultRelativePath &&
      !/^assets\/dubbing\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.mp4$/.test(step.resultRelativePath)
    )
      throw new Error('Invalid persistent dubbing result path.');
    this.database
      .prepare(
        `INSERT INTO dubbing_job_steps (id,job_id,step_key,kind,dependencies_json,status,attempt,input_hash,idempotency_key,
      provider_task_id,provider_asset_id,provider_asset_expires_at,region,result_audio_id,result_asset_id,result_relative_path,result_content_hash,deadline,error,error_kind,row_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        step.id,
        step.jobId,
        step.stepKey,
        step.kind,
        JSON.stringify(step.dependencies),
        step.status,
        step.attempt,
        step.inputHash,
        step.idempotencyKey,
        step.providerTaskId ?? null,
        step.providerAssetId ?? null,
        step.providerAssetExpiresAt ?? null,
        step.region ?? null,
        step.resultAudioId ?? null,
        step.resultAssetId ?? null,
        step.resultRelativePath ?? null,
        step.resultContentHash ?? null,
        step.deadline ?? null,
        step.error ?? null,
        step.errorKind ?? null,
        step.rowVersion,
        step.createdAt,
        step.updatedAt,
      );
    return this.getStep(step.id)!;
  }
  private getJobWithoutSteps(id: string): Row | undefined {
    return this.row('SELECT id FROM dubbing_jobs WHERE id=? AND project_id=?', id, this.projectId);
  }
  getStep(id: string): DubbingJobStepInfo | undefined {
    const row = this.row(
      'SELECT s.* FROM dubbing_job_steps s JOIN dubbing_jobs j ON j.id=s.job_id WHERE s.id=? AND j.project_id=?',
      id,
      this.projectId,
    );
    return row ? mapStep(row) : undefined;
  }
  listSteps(jobId: string): DubbingJobStepInfo[] {
    return this.rows(
      'SELECT s.* FROM dubbing_job_steps s JOIN dubbing_jobs j ON j.id=s.job_id WHERE s.job_id=? AND j.project_id=? ORDER BY s.created_at,s.step_key,s.attempt',
      jobId,
      this.projectId,
    ).map(mapStep);
  }
  updateStep(
    id: string,
    patch: DubbingStepPatch,
    expectedRowVersion: number,
    now = new Date().toISOString(),
  ): DubbingJobStepInfo {
    const existing = this.getStep(id);
    if (!existing || existing.rowVersion !== expectedRowVersion) throw new DubbingConflictError();
    const merged = { ...existing, ...patch };
    if (
      merged.resultRelativePath &&
      !/^assets\/dubbing\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.mp4$/.test(merged.resultRelativePath)
    )
      throw new Error('Invalid persistent dubbing result path.');
    const changed = this.database
      .prepare(
        `UPDATE dubbing_job_steps SET status=?,provider_task_id=?,provider_asset_id=?,provider_asset_expires_at=?,region=?,
      result_audio_id=?,result_asset_id=?,result_relative_path=?,result_content_hash=?,deadline=?,error=?,error_kind=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?`,
      )
      .run(
        merged.status,
        merged.providerTaskId ?? null,
        merged.providerAssetId ?? null,
        merged.providerAssetExpiresAt ?? null,
        merged.region ?? null,
        merged.resultAudioId ?? null,
        merged.resultAssetId ?? null,
        merged.resultRelativePath ?? null,
        merged.resultContentHash ?? null,
        merged.deadline ?? null,
        merged.error ?? null,
        merged.errorKind ?? null,
        now,
        id,
        expectedRowVersion,
      );
    if (changed.changes !== 1) throw new DubbingConflictError();
    return this.getStep(id)!;
  }
}

function str(row: Row, key: string): string {
  return String(row[key]);
}
function opt(row: Row, key: string): string | undefined {
  return row[key] == null ? undefined : String(row[key]);
}
function num(row: Row, key: string): number {
  return Number(row[key]);
}
function json<T>(row: Row, key: string): T {
  return JSON.parse(str(row, key)) as T;
}
function mapVoice(row: Row): VoiceProfileInfo {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    characterDocumentId: opt(row, 'character_document_id'),
    versionId: str(row, 'version_id'),
    revision: num(row, 'revision'),
    providerProfileId: str(row, 'provider_profile_id'),
    model: str(row, 'model_id'),
    voiceId: str(row, 'voice_id'),
    contractRevision: str(row, 'contract_revision'),
    ...json<VoiceSettings>(row, 'settings_json'),
    region: opt(row, 'region'),
    referenceAudioId: opt(row, 'reference_audio_id'),
    rowVersion: num(row, 'row_version'),
    archivedAt: opt(row, 'archived_at'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}
function mapCue(row: Row): DubbingCueInfo {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    sceneId: str(row, 'scene_id'),
    shotId: opt(row, 'shot_id'),
    speakerKind: str(row, 'speaker_kind') as DubbingCueInfo['speakerKind'],
    characterDocumentId: opt(row, 'character_document_id'),
    voiceProfileId: opt(row, 'voice_profile_id'),
    text: str(row, 'text'),
    position: num(row, 'position'),
    startMs: num(row, 'start_ms'),
    emotion: opt(row, 'emotion'),
    visibleSpeaker: opt(row, 'visible_speaker'),
    lipSync: !!num(row, 'lip_sync'),
    speakerCoordinates: row.speaker_coordinates_json
      ? json<[number, number]>(row, 'speaker_coordinates_json')
      : undefined,
    trailingPauseMs: num(row, 'trailing_pause_ms'),
    selectedTakeId: opt(row, 'selected_take_id'),
    rowVersion: num(row, 'row_version'),
    deletedAt: opt(row, 'deleted_at'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}
function mapAudio(row: Row): AudioFileInfo {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    kind: str(row, 'kind') as AudioFileInfo['kind'],
    name: str(row, 'name'),
    relativePath: str(row, 'relative_path'),
    mime: str(row, 'mime') as AudioFileInfo['mime'],
    sizeBytes: num(row, 'size_bytes'),
    contentHash: str(row, 'content_hash'),
    durationMs: num(row, 'duration_ms'),
    sampleRate: num(row, 'sample_rate'),
    channels: num(row, 'channels'),
    sourceJobId: opt(row, 'source_job_id'),
    deletedAt: opt(row, 'deleted_at'),
    trashRelativePath: opt(row, 'trash_relative_path'),
    createdAt: str(row, 'created_at'),
  };
}
function mapTake(row: Row): DubbingTakeInfo {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    cueId: str(row, 'cue_id'),
    cueRowVersion: num(row, 'cue_row_version'),
    textHash: str(row, 'text_hash'),
    voiceVersionId: opt(row, 'voice_version_id'),
    voiceSnapshot: row.voice_snapshot_json
      ? json<VoiceProfileInfo>(row, 'voice_snapshot_json')
      : undefined,
    audioId: str(row, 'audio_id'),
    sourceJobId: opt(row, 'source_job_id'),
    parameters: json<Record<string, unknown>>(row, 'parameters_json'),
    createdAt: str(row, 'created_at'),
  };
}
function mapJob(row: Row): DubbingJobInfo {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    sceneId: str(row, 'scene_id'),
    shotId: opt(row, 'shot_id'),
    kind: str(row, 'kind') as DubbingJobInfo['kind'],
    status: str(row, 'status') as DubbingJobInfo['status'],
    planVersion: num(row, 'plan_version'),
    inputHash: str(row, 'input_hash'),
    inputSnapshot: json<DubbingJobInfo['inputSnapshot']>(row, 'input_snapshot_json'),
    budget: json<DubbingJobInfo['budget']>(row, 'budget_json'),
    idempotencyKey: str(row, 'idempotency_key'),
    sourceVideoAssetId: opt(row, 'source_video_asset_id'),
    providerTaskId: opt(row, 'provider_task_id'),
    outputAudioId: opt(row, 'output_audio_id'),
    outputAssetId: opt(row, 'output_asset_id'),
    adoptedAt: opt(row, 'adopted_at'),
    error: opt(row, 'error'),
    errorKind: opt(row, 'error_kind'),
    deadline: opt(row, 'deadline'),
    rowVersion: num(row, 'row_version'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}
function mapStep(row: Row): DubbingJobStepInfo {
  return {
    id: str(row, 'id'),
    jobId: str(row, 'job_id'),
    stepKey: str(row, 'step_key'),
    kind: str(row, 'kind') as DubbingJobStepInfo['kind'],
    dependencies: json<string[]>(row, 'dependencies_json'),
    status: str(row, 'status') as DubbingJobStepInfo['status'],
    attempt: num(row, 'attempt'),
    inputHash: str(row, 'input_hash'),
    idempotencyKey: str(row, 'idempotency_key'),
    providerTaskId: opt(row, 'provider_task_id'),
    providerAssetId: opt(row, 'provider_asset_id'),
    providerAssetExpiresAt: opt(row, 'provider_asset_expires_at'),
    region: opt(row, 'region'),
    resultAudioId: opt(row, 'result_audio_id'),
    resultAssetId: opt(row, 'result_asset_id'),
    resultRelativePath: opt(row, 'result_relative_path'),
    resultContentHash: opt(row, 'result_content_hash'),
    deadline: opt(row, 'deadline'),
    error: opt(row, 'error'),
    errorKind: opt(row, 'error_kind'),
    rowVersion: num(row, 'row_version'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}
function validateAudioPath(path: string, trash = false): void {
  if (
    !/^assets\/audio\/(?:reference|dialogue|scene|\.trash)\/[a-zA-Z0-9_-]+\.(?:wav|mp3)$/.test(
      path,
    ) ||
    (trash && !path.startsWith('assets/audio/.trash/')) ||
    (!trash && path.startsWith('assets/audio/.trash/'))
  )
    throw new Error('Invalid project audio path.');
}
