import {
  PRODUCTION_SKILLS,
  PRODUCTION_BUNDLE_SKILL_REVISION,
  type ProductionSkillId,
} from '@ai-video/contracts';
/** One current declaration, independent of historical task revisions. */
export function readProductionSkill(args: Record<string, unknown>) {
  if (
    Object.keys(args).some((k) => k !== 'skillId') ||
    typeof args.skillId !== 'string' ||
    !Object.hasOwn(PRODUCTION_SKILLS, args.skillId)
  )
    throw new Error('Unknown production skill.');
  return {
    skillId: args.skillId,
    revision: args.skillId === 'script-to-media' ? PRODUCTION_BUNDLE_SKILL_REVISION : 1,
    ...PRODUCTION_SKILLS[args.skillId as ProductionSkillId],
  };
}
