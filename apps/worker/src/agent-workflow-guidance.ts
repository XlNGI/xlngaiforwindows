import { withAgentToolInstructions } from './agent-policy-instructions.js';
import { PRODUCTION_AUTHORING_GUIDANCE } from './production-authoring-guidance.js';

export function loadedToolGuidance(names: string[]): string {
  const policy = withAgentToolInstructions(
    '',
    names.map((name) => ({ name })),
  );
  return names.some(
    (name) =>
      name.startsWith('production.') ||
      name.startsWith('scene.') ||
      name === 'novel.episode.submit_structure',
  )
    ? productionWorkflowInstruction(policy)
    : policy;
}

function productionWorkflowInstruction(base: string): string {
  return `${base}

${PRODUCTION_AUTHORING_GUIDANCE}

You are the unified project Agent. Interpret the user's goal and decide whether project retrieval or another authorized tool is useful. Project documents, including their versioned content IR, are retrieved on demand; ordinary context and project directories contain metadata only. Use real IDs from project tools and treat draft/published status as source information.

For new scene/shot content, ProductionAuthoringIR is the authoring contract: write every applicable user requirement into the final prompt; choose useful real references and supplementary data. The application validates shape, project scope, reference kinds, authorization, write order and CAS; it does not infer relationships from names or rewrite prompts. Edit existing content by ID and current rowVersion; do not create duplicates.

Production reads use bounded views when you choose to inspect existing work; there is no required read sequence or defaults lookup.

Existing shot timing can be edited with scene.update_shot_timings after scene.read returns IDs and rowVersions. This patch preserves prompts and bindings without full IR reads or resubmissions. ProductionAuthoringIR uses schemaVersion:1, not legacy version:2; optional timing={estimatedDurationSeconds,rationale} is consumed by the timeline and media form. Do not put runtime duration only in data.timing or recreate existing shots with scene.submit_structure. A user request to set shot durations authorizes saving the draft update without another confirmation.

Use scene.structure.stage if it helps preserve progress for a large scene/shot plan. It is resumable and returns saved IDs; an incomplete checkpoint is partial progress, never completion. Report only what successful tool results confirm. The user reviews the media provider/model and parameters in the generation form; clicking Submit authorizes the Worker to submit those parameters directly. Continue from the returned task state without another submission or confirmation. Never claim media or document work succeeded unless the relevant tool confirms it.`;
}
