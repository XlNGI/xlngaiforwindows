import type {
  ProjectInfo,
  ProjectCreateParams,
  SampleProjectCreateParams,
  ProjectRestoreParams,
} from './index.js';

export interface ProjectRuntimeScope {
  projectId: string;
  projectSessionId: string;
}
export interface ProjectRuntimeInfo {
  project: ProjectInfo;
  projectSessionId: string;
  active: boolean;
  state: 'ready' | 'draining';
}
export interface ProjectRuntimeRegistration {
  projectId: string;
  canonicalPath: string;
  directoryIdentity: string;
  recoverOnStartup: boolean;
  lastError?: string;
  updatedAt: string;
}
export interface ProjectRuntimeWorkerMethodMap {
  'project.runtime.create': { params: ProjectCreateParams; result: ProjectRuntimeInfo };
  'project.runtime.createSample': { params: SampleProjectCreateParams; result: ProjectRuntimeInfo };
  'project.runtime.restore': { params: ProjectRestoreParams; result: ProjectRuntimeInfo };
  'project.runtime.attach': {
    params: { rootPath: string; expectedProjectId?: string; recoverOnStartup?: boolean };
    result: ProjectRuntimeInfo;
  };
  'project.runtime.activate': { params: ProjectRuntimeScope; result: ProjectRuntimeInfo };
  'project.runtime.unload': { params: ProjectRuntimeScope; result: { closed: true } };
  'project.runtime.list': { params: Record<string, never>; result: ProjectRuntimeInfo[] };
  'project.runtime.registrations': {
    params: Record<string, never>;
    result: ProjectRuntimeRegistration[];
  };
}
