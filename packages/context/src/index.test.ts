import { describe, expect, it } from 'vitest';
import {
  compileProductionContext,
  ContextBudgetError,
  estimateTokenCount,
  extractiveSummary,
} from './index.js';

describe('compileProductionContext', () => {
  it('keeps extractive summaries within the requested character budget', () => {
    const content = 'a'.repeat(10_000);
    expect(extractiveSummary(content, 100)).toHaveLength(100);
    expect(extractiveSummary(content, 0)).toBe('');
  });

  it('estimates Chinese conservatively while retaining the English heuristic', () => {
    expect(estimateTokenCount('中'.repeat(100))).toBe(100);
    expect(estimateTokenCount('a'.repeat(100))).toBe(25);
    expect(estimateTokenCount('中'.repeat(100))).toBeGreaterThan(
      estimateTokenCount('a'.repeat(100)),
    );
  });

  it('uses the same token estimate for Chinese budget trimming', () => {
    const context = compileProductionContext({
      projectId: 'project',
      projectName: 'Drama',
      scope: { type: 'project', label: 'Project' },
      budgetTokens: 1_000,
      sources: [
        {
          id: 'chinese-document',
          type: 'document',
          scopeType: 'project',
          label: '中文剧本',
          content: '剧情发展与人物对白。'.repeat(500),
        },
      ],
    });

    expect(context.sources[0]?.truncated).toBe(true);
    expect(context.estimatedTokens).toBeLessThanOrEqual(context.budgetTokens);
    expect(context.estimatedTokens).toBeGreaterThan(900);
  });

  it('includes project and current shot sources without leaking another scene', () => {
    const context = compileProductionContext({
      projectId: 'project',
      projectName: 'Drama',
      scope: { type: 'shot', id: 'shot-1', sceneId: 'scene-1', label: 'Shot 1' },
      sources: [
        {
          id: 'outline',
          type: 'document',
          scopeType: 'project',
          label: '项目大纲',
          content: 'Outline',
        },
        {
          id: 'current',
          type: 'document',
          scopeType: 'scene',
          scopeId: 'scene-1',
          label: '场次一',
          content: 'Current',
        },
        {
          id: 'other',
          type: 'document',
          scopeType: 'scene',
          scopeId: 'scene-2',
          label: '场次二',
          content: 'Leak',
        },
        {
          id: 'constraint',
          type: 'constraint',
          scopeType: 'project',
          label: '生产约束',
          content: 'Locked',
        },
      ],
    });
    expect(context.rendered).toContain('Current');
    expect(context.rendered).toContain('Locked');
    expect(context.rendered).not.toContain('Leak');
  });

  it('rejects generation instead of silently dropping oversized constraints', () => {
    expect(() =>
      compileProductionContext({
        projectId: 'project',
        projectName: 'Drama',
        scope: { type: 'project', label: 'Project' },
        budgetTokens: 1_000,
        sources: [
          {
            id: 'constraint',
            type: 'constraint',
            scopeType: 'project',
            label: 'Locked constraints',
            content: 'x'.repeat(5_000),
          },
        ],
      }),
    ).toThrow(ContextBudgetError);
  });

  it('keeps every constraint intact before allocating remaining context', () => {
    const first = 'A'.repeat(1_200);
    const second = 'B'.repeat(1_200);
    const context = compileProductionContext({
      projectId: 'project',
      projectName: 'Drama',
      scope: { type: 'project', label: 'Project' },
      budgetTokens: 1_000,
      sources: [
        {
          id: 'document',
          type: 'document',
          scopeType: 'project',
          label: 'Long document',
          content: 'D'.repeat(5_000),
        },
        {
          id: 'constraint-a',
          type: 'constraint',
          scopeType: 'project',
          label: 'Constraint A',
          content: first,
        },
        {
          id: 'constraint-b',
          type: 'constraint',
          scopeType: 'project',
          label: 'Constraint B',
          content: second,
        },
      ],
    });

    expect(context.rendered).toContain(first);
    expect(context.rendered).toContain(second);
    expect(context.estimatedTokens).toBeLessThanOrEqual(context.budgetTokens);
  });
});
