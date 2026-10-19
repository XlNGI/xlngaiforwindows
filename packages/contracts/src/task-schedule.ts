export interface VideoScheduleView {
  taskId: string;
  projectId: string;
  ownerJobId: string;
  scheduleState: string;
  waitReason?: string;
  domainState: string;
  revision: number;
}
export interface TaskScheduleEvent {
  sequence: number;
  kind: string;
  dispatchId: string | null;
  createdAt: string;
}
export interface TaskScheduleWorkerMethodMap {
  'task.schedule.list': { params: { projectId: string }; result: VideoScheduleView[] };
  'task.schedule.get': { params: { projectId: string; taskId: string }; result: VideoScheduleView };
  'task.schedule.events': {
    params: { projectId: string; taskId: string; afterSequence?: number };
    result: TaskScheduleEvent[];
  };
  'task.schedule.create': {
    params: {
      projectId: string;
      projectSessionId: string;
      jobId: string;
      upstreamTaskIds?: string[];
    };
    result: VideoScheduleView;
  };
  'task.schedule.cancel': {
    params: { projectId: string; projectSessionId: string; taskId: string };
    result: import('./index.js').MediaSubmissionResult;
  };
}
