/** Record an explicit Agent checkpoint separately from task outcome semantics. */
export const MIGRATION_V59 = `
ALTER TABLE agent_tasks ADD COLUMN completion_state TEXT
  CHECK (completion_state IS NULL OR completion_state IN ('partial'));
`;
