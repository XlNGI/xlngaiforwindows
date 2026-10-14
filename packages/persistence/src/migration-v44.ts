/** Dedicated audio production store. Existing image/video asset contracts are unchanged. */
export const MIGRATION_V44 = `
CREATE TABLE IF NOT EXISTS character_voice_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_document_id TEXT,
  current_version_id TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, character_document_id)
);
CREATE TABLE IF NOT EXISTS character_voice_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES character_voice_profiles(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  provider_profile_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  contract_revision TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  region TEXT,
  reference_audio_id TEXT REFERENCES audio_files(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, revision)
);
CREATE TABLE IF NOT EXISTS audio_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('reference','imported-dialogue','generated-dialogue','scene-master')),
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL CHECK (
    relative_path LIKE 'assets/audio/%'
    AND instr(relative_path, '..') = 0 AND instr(relative_path, char(92)) = 0
    AND instr(relative_path, ':') = 0),
  mime TEXT NOT NULL CHECK (mime IN ('audio/wav','audio/mpeg')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0 AND duration_ms <= 600000),
  sample_rate INTEGER NOT NULL CHECK (sample_rate BETWEEN 8000 AND 192000),
  channels INTEGER NOT NULL CHECK (channels BETWEEN 1 AND 8),
  source_job_id TEXT REFERENCES dubbing_jobs(id) ON DELETE RESTRICT,
  deleted_at TEXT,
  trash_relative_path TEXT CHECK (trash_relative_path IS NULL OR (
    trash_relative_path LIKE 'assets/audio/.trash/%' AND instr(trash_relative_path, '..') = 0
    AND instr(trash_relative_path, char(92)) = 0 AND instr(trash_relative_path, ':') = 0)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, relative_path)
);
CREATE TABLE IF NOT EXISTS dubbing_cues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  shot_id TEXT REFERENCES shots(id) ON DELETE RESTRICT,
  speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('character','narration')),
  character_document_id TEXT,
  voice_profile_id TEXT REFERENCES character_voice_profiles(id) ON DELETE RESTRICT,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0 AND length(text) <= 4000),
  position INTEGER NOT NULL CHECK (position >= 0),
  start_ms INTEGER NOT NULL CHECK (start_ms BETWEEN 0 AND 600000),
  emotion TEXT,
  visible_speaker TEXT,
  lip_sync INTEGER NOT NULL DEFAULT 0 CHECK (lip_sync IN (0,1)),
  speaker_coordinates_json TEXT CHECK (speaker_coordinates_json IS NULL OR json_valid(speaker_coordinates_json)),
  trailing_pause_ms INTEGER NOT NULL DEFAULT 0 CHECK (trailing_pause_ms BETWEEN 0 AND 60000),
  selected_take_id TEXT REFERENCES dubbing_takes(id) ON DELETE RESTRICT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((speaker_kind='character' AND character_document_id IS NOT NULL)
    OR (speaker_kind='narration' AND character_document_id IS NULL AND voice_profile_id IS NOT NULL)),
  CHECK (speaker_kind <> 'narration' OR lip_sync = 0)
);
CREATE TABLE IF NOT EXISTS dubbing_takes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cue_id TEXT NOT NULL REFERENCES dubbing_cues(id) ON DELETE RESTRICT,
  cue_row_version INTEGER NOT NULL CHECK (cue_row_version > 0),
  text_hash TEXT NOT NULL CHECK (length(text_hash)=64),
  voice_version_id TEXT REFERENCES character_voice_profile_versions(id) ON DELETE RESTRICT,
  voice_snapshot_json TEXT CHECK (voice_snapshot_json IS NULL OR json_valid(voice_snapshot_json)),
  audio_id TEXT NOT NULL REFERENCES audio_files(id) ON DELETE RESTRICT,
  source_job_id TEXT REFERENCES dubbing_jobs(id) ON DELETE RESTRICT,
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dubbing_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  shot_id TEXT REFERENCES shots(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('speech','lipsync','compose')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','submission_unknown','interrupted','cancelling','cancelled','failed','complete')),
  plan_version INTEGER NOT NULL CHECK (plan_version > 0),
  input_hash TEXT NOT NULL CHECK (length(input_hash)=64),
  input_snapshot_json TEXT NOT NULL CHECK (json_valid(input_snapshot_json)),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  idempotency_key TEXT NOT NULL,
  source_video_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  provider_task_id TEXT,
  output_audio_id TEXT REFERENCES audio_files(id) ON DELETE RESTRICT,
  output_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  adopted_at TEXT,
  error TEXT,
  error_kind TEXT,
  deadline TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS dubbing_job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES dubbing_jobs(id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('speech','prepare','upload','lipsync','download','validate','compose','commit')),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','running','submission_unknown','interrupted','cancelling','cancelled','failed','complete')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 10),
  input_hash TEXT NOT NULL CHECK (length(input_hash)=64),
  idempotency_key TEXT NOT NULL,
  provider_task_id TEXT,
  provider_asset_id TEXT,
  provider_asset_expires_at TEXT,
  region TEXT,
  result_audio_id TEXT REFERENCES audio_files(id) ON DELETE RESTRICT,
  result_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  result_relative_path TEXT,
  result_content_hash TEXT CHECK (result_content_hash IS NULL OR length(result_content_hash)=64),
  deadline TEXT,
  error TEXT,
  error_kind TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, step_key, attempt)
);
CREATE TABLE IF NOT EXISTS dubbing_job_audio_references (
  job_id TEXT NOT NULL REFERENCES dubbing_jobs(id) ON DELETE RESTRICT,
  audio_id TEXT NOT NULL REFERENCES audio_files(id) ON DELETE RESTRICT,
  PRIMARY KEY(job_id, audio_id)
);
CREATE INDEX IF NOT EXISTS idx_dubbing_cues_scene ON dubbing_cues(project_id, scene_id, deleted_at, position, id);
CREATE INDEX IF NOT EXISTS idx_dubbing_jobs_state ON dubbing_jobs(project_id, status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_dubbing_takes_cue ON dubbing_takes(project_id, cue_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audio_files_project ON audio_files(project_id, deleted_at, created_at, id);

CREATE TRIGGER IF NOT EXISTS voice_character_valid BEFORE INSERT ON character_voice_profiles
WHEN NEW.character_document_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM documents WHERE id=NEW.character_document_id AND project_id=NEW.project_id AND kind='character')
BEGIN SELECT RAISE(ABORT, 'voice character must belong to project'); END;
CREATE TRIGGER IF NOT EXISTS voice_identity_immutable BEFORE UPDATE OF project_id, character_document_id ON character_voice_profiles
WHEN NEW.project_id<>OLD.project_id OR NEW.character_document_id IS NOT OLD.character_document_id
BEGIN SELECT RAISE(ABORT, 'voice identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS voice_version_valid BEFORE INSERT ON character_voice_profile_versions
WHEN NOT EXISTS (SELECT 1 FROM character_voice_profiles WHERE id=NEW.profile_id AND project_id=NEW.project_id)
  OR (NEW.reference_audio_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM audio_files WHERE id=NEW.reference_audio_id AND project_id=NEW.project_id AND deleted_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'voice version references another project'); END;
CREATE TRIGGER IF NOT EXISTS voice_version_immutable BEFORE UPDATE ON character_voice_profile_versions
BEGIN SELECT RAISE(ABORT, 'voice version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS voice_current_valid BEFORE UPDATE OF current_version_id ON character_voice_profiles
WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM character_voice_profile_versions WHERE id=NEW.current_version_id AND profile_id=NEW.id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'current voice version does not belong to profile'); END;
CREATE TRIGGER IF NOT EXISTS voice_character_deleted BEFORE DELETE ON documents
BEGIN UPDATE character_voice_profiles SET archived_at=COALESCE(archived_at,OLD.updated_at), row_version=row_version+1 WHERE character_document_id=OLD.id; END;

CREATE TRIGGER IF NOT EXISTS audio_identity_immutable BEFORE UPDATE OF project_id,kind,relative_path,mime,size_bytes,content_hash,duration_ms,sample_rate,channels,source_job_id,created_at ON audio_files
BEGIN SELECT RAISE(ABORT, 'audio file metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audio_source_valid BEFORE INSERT ON audio_files
WHEN NEW.source_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dubbing_jobs WHERE id=NEW.source_job_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'audio source job belongs to another project'); END;

CREATE TRIGGER IF NOT EXISTS cue_insert_valid BEFORE INSERT ON dubbing_cues
WHEN NOT EXISTS (SELECT 1 FROM scenes WHERE id=NEW.scene_id AND project_id=NEW.project_id)
  OR (NEW.shot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shots WHERE id=NEW.shot_id AND scene_id=NEW.scene_id))
  OR (NEW.character_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id=NEW.character_document_id AND project_id=NEW.project_id AND kind='character'))
  OR (NEW.voice_profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM character_voice_profiles WHERE id=NEW.voice_profile_id AND project_id=NEW.project_id AND archived_at IS NULL
    AND (NEW.speaker_kind='narration' OR character_document_id=NEW.character_document_id)))
  OR (NEW.selected_take_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dubbing_takes WHERE id=NEW.selected_take_id AND cue_id=NEW.id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'invalid cue project or speaker'); END;
CREATE TRIGGER IF NOT EXISTS cue_update_valid BEFORE UPDATE OF project_id,scene_id,shot_id,speaker_kind,character_document_id,voice_profile_id ON dubbing_cues
WHEN NEW.project_id<>OLD.project_id OR NEW.scene_id<>OLD.scene_id
  OR (NEW.shot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shots WHERE id=NEW.shot_id AND scene_id=NEW.scene_id))
  OR (NEW.character_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id=NEW.character_document_id AND project_id=NEW.project_id AND kind='character'))
  OR (NEW.voice_profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM character_voice_profiles WHERE id=NEW.voice_profile_id AND project_id=NEW.project_id AND archived_at IS NULL
    AND (NEW.speaker_kind='narration' OR character_document_id=NEW.character_document_id)))
BEGIN SELECT RAISE(ABORT, 'invalid cue project or speaker'); END;
CREATE TRIGGER IF NOT EXISTS cue_limit BEFORE INSERT ON dubbing_cues
WHEN (SELECT count(*) FROM dubbing_cues WHERE project_id=NEW.project_id AND scene_id=NEW.scene_id AND deleted_at IS NULL)>=60
BEGIN SELECT RAISE(ABORT, 'scene has too many dubbing cues'); END;
CREATE TRIGGER IF NOT EXISTS cue_selected_take_valid BEFORE UPDATE OF selected_take_id ON dubbing_cues
WHEN NEW.selected_take_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM dubbing_takes WHERE id=NEW.selected_take_id AND cue_id=NEW.id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'take belongs to another cue'); END;
CREATE TRIGGER IF NOT EXISTS take_valid BEFORE INSERT ON dubbing_takes
WHEN NOT EXISTS (SELECT 1 FROM dubbing_cues WHERE id=NEW.cue_id AND project_id=NEW.project_id)
  OR NOT EXISTS (SELECT 1 FROM audio_files WHERE id=NEW.audio_id AND project_id=NEW.project_id AND deleted_at IS NULL)
  OR (NEW.voice_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM character_voice_profile_versions WHERE id=NEW.voice_version_id AND project_id=NEW.project_id))
  OR (NEW.source_job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dubbing_jobs WHERE id=NEW.source_job_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'take references another project'); END;
CREATE TRIGGER IF NOT EXISTS take_immutable BEFORE UPDATE ON dubbing_takes
BEGIN SELECT RAISE(ABORT, 'dubbing take is immutable'); END;

CREATE TRIGGER IF NOT EXISTS dubbing_job_valid BEFORE INSERT ON dubbing_jobs
WHEN NOT EXISTS (SELECT 1 FROM scenes WHERE id=NEW.scene_id AND project_id=NEW.project_id)
  OR (NEW.shot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shots WHERE id=NEW.shot_id AND scene_id=NEW.scene_id))
  OR (NEW.source_video_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets WHERE id=NEW.source_video_asset_id AND project_id=NEW.project_id AND kind IN ('video','scene-video','generated-video','shot-video') AND deleted_at IS NULL))
  OR (NEW.output_audio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audio_files WHERE id=NEW.output_audio_id AND project_id=NEW.project_id))
  OR (NEW.output_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets WHERE id=NEW.output_asset_id AND project_id=NEW.project_id AND kind IN ('video','scene-video','generated-video','shot-video')))
BEGIN SELECT RAISE(ABORT, 'invalid dubbing source scene or video'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_job_input_immutable BEFORE UPDATE OF project_id,scene_id,shot_id,kind,plan_version,input_hash,input_snapshot_json,budget_json,idempotency_key,source_video_asset_id ON dubbing_jobs
BEGIN SELECT RAISE(ABORT, 'dubbing job input is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_job_result_valid BEFORE UPDATE OF output_audio_id,output_asset_id ON dubbing_jobs
WHEN (NEW.output_audio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audio_files WHERE id=NEW.output_audio_id AND project_id=NEW.project_id))
  OR (NEW.output_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets WHERE id=NEW.output_asset_id AND project_id=NEW.project_id AND kind IN ('video','scene-video','generated-video','shot-video')))
BEGIN SELECT RAISE(ABORT, 'dubbing output belongs to another project'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_job_complete_immutable BEFORE UPDATE OF status,output_audio_id,output_asset_id ON dubbing_jobs
WHEN OLD.status='complete' AND (NEW.status<>OLD.status OR NEW.output_audio_id IS NOT OLD.output_audio_id OR NEW.output_asset_id IS NOT OLD.output_asset_id)
BEGIN SELECT RAISE(ABORT, 'completed dubbing output is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_step_limit BEFORE INSERT ON dubbing_job_steps
WHEN (SELECT count(*) FROM dubbing_job_steps WHERE job_id=NEW.job_id)>=180
BEGIN SELECT RAISE(ABORT, 'dubbing job has too many steps'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_step_insert_valid BEFORE INSERT ON dubbing_job_steps
WHEN (NEW.result_audio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audio_files a JOIN dubbing_jobs j ON j.project_id=a.project_id WHERE a.id=NEW.result_audio_id AND j.id=NEW.job_id))
  OR (NEW.result_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets a JOIN dubbing_jobs j ON j.project_id=a.project_id WHERE a.id=NEW.result_asset_id AND j.id=NEW.job_id))
BEGIN SELECT RAISE(ABORT, 'step result belongs to another project'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_step_input_immutable BEFORE UPDATE OF job_id,step_key,kind,dependencies_json,attempt,input_hash,idempotency_key ON dubbing_job_steps
BEGIN SELECT RAISE(ABORT, 'dubbing step input is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_step_complete_immutable BEFORE UPDATE ON dubbing_job_steps
WHEN OLD.status='complete'
BEGIN SELECT RAISE(ABORT, 'completed dubbing step is immutable'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_step_result_valid BEFORE UPDATE OF result_audio_id,result_asset_id ON dubbing_job_steps
WHEN (NEW.result_audio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM audio_files a JOIN dubbing_jobs j ON j.project_id=a.project_id WHERE a.id=NEW.result_audio_id AND j.id=NEW.job_id))
  OR (NEW.result_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets a JOIN dubbing_jobs j ON j.project_id=a.project_id WHERE a.id=NEW.result_asset_id AND j.id=NEW.job_id))
BEGIN SELECT RAISE(ABORT, 'step result belongs to another project'); END;
CREATE TRIGGER IF NOT EXISTS dubbing_audio_reference_valid BEFORE INSERT ON dubbing_job_audio_references
WHEN NOT EXISTS (SELECT 1 FROM audio_files a JOIN dubbing_jobs j ON j.project_id=a.project_id WHERE a.id=NEW.audio_id AND j.id=NEW.job_id AND a.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'job audio belongs to another project'); END;
`;
