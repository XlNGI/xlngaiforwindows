/** Worker-authored repair facts. They locate arguments; they never supply a semantic verdict. */
export type TaskRepairDiagnostic = {
  kind: 'plan' | 'review';
  code: string;
  field: string;
  index?: number;
  planKey?: string;
  targetId?: string;
  issueId?: string;
  requirementId?: string;
  reviewId?: string;
  expected?: unknown;
  received?: unknown;
  allowedValues?: string[];
  snapshotRead?: { operation: 'result'; resultId: string };
  instruction: string;
};

export class TaskRepairError extends Error {
  constructor(
    message: string,
    readonly repair: TaskRepairDiagnostic,
  ) {
    super(message);
    this.name = 'TaskRepairError';
  }
}
