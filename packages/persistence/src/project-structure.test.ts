import { describe, expect, it } from 'vitest';
import { parseProjectStructure } from './project-structure.js';

describe('project structure parser', () => {
  it('builds deterministic nested paths from Markdown headings', () => {
    const content = [
      '# 第一章 雨夜来客',
      '正文。',
      '## 场景一 旧码头',
      '潮声。',
      '### 镜头 1',
      '推近。',
      '## 场景二 灯塔',
      '雾散。',
    ].join('\n');

    const nodes = parseProjectStructure(content, '雾港纪事');

    expect(nodes.map((node) => [node.kind, node.path])).toEqual([
      ['document', ['雾港纪事']],
      ['chapter', ['雾港纪事', '第一章 雨夜来客']],
      ['scene', ['雾港纪事', '第一章 雨夜来客', '场景一 旧码头']],
      ['shot', ['雾港纪事', '第一章 雨夜来客', '场景一 旧码头', '镜头 1']],
      ['scene', ['雾港纪事', '第一章 雨夜来客', '场景二 灯塔']],
    ]);
    expect(nodes[2]?.startOffset).toBeLessThan(nodes[2]?.endOffset ?? 0);
    expect(nodes[2]?.contentHash).toHaveLength(64);
  });

  it('keeps a root node for unstructured documents', () => {
    const nodes = parseProjectStructure('只有正文，没有标题。', '备忘');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'document', path: ['备忘'], level: 0 });
  });

  it('does not treat fenced Markdown examples as project structure', () => {
    const content = ['```markdown', '# 示例标题', '```', '# 真正章节', '正文。'].join('\n');
    const nodes = parseProjectStructure(content, '文档');
    expect(nodes.map((node) => node.title)).toEqual(['文档', '真正章节']);
  });
});
