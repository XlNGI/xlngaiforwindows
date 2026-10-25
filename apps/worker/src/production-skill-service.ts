import { PRODUCTION_SKILLS, type ProductionSkillId } from '@ai-video/contracts';

/** Declarative instructions only. All work stays in the existing Agent/tool runtime. */
export function readProductionSkill(args: Record<string, unknown>) {
  if (
    Object.keys(args).some((key) => key !== 'skillId') ||
    typeof args.skillId !== 'string' ||
    !Object.hasOwn(PRODUCTION_SKILLS, args.skillId)
  )
    throw new Error('Unknown production skill.');
  return {
    skillId: args.skillId,
    revision: 1,
    ...PRODUCTION_SKILLS[args.skillId as ProductionSkillId],
  };
}
