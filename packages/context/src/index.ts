import { createHash } from 'node:crypto';

export type ContextScopeType = 'project' | 'scene' | 'shot';
export type ContextSourceType = 'document' | 'memory' | 'constraint' | 'conversation' | 'catalog';

export interface ContextScope {
  type: ContextScopeType;
  id?: string;
  sceneId?: string;
  label: string;
}

export interface ContextSourceInput {
  id: string;
  type: ContextSourceType;
  scopeType: ContextScopeType;
  scopeId?: string;
  label: string;
  content: string;
  version?: number;
  versionId?: string;
  updatedAt?: string;
  priority?: number;
}

export interface ContextSourceReference extends ContextSourceInput {
  includedContent: string;
  originalCharacters: number;
  includedCharacters: number;
  truncated: boolean;
  summaryCacheKey?: string;
}

export interface LibraryCatalogEntry {
  id: string;
  sourceType: string;
  sourceId: string;
  versionId?: string;
  status: string;
  kind?: string;
  title: string;
  updatedAt: string;
}

export interface ProductionContext {
  version: 1;
  projectId: string;
  projectName: string;
  scope: ContextScope;
  systemInstruction: string;
  sources: ContextSourceReference[];
  catalog: LibraryCatalogEntry[];
  estimatedTokens: number;
  budgetTokens: number;
  rendered: string;
}

export interface ProductionContextManifest {
  version: 1;
  projectId: string;
  projectName: string;
  scope: ContextScope;
  estimatedTokens: number;
  budgetTokens: number;
  sources: Array<{
    id: string;
    type: ContextSourceReference['type'];
    scopeType: ContextSourceReference['scopeType'];
    scopeId?: string;
    label: string;
    version?: number;
    versionId?: string;
    originalCharacters: number;
    includedCharacters: number;
    truncated: boolean;
  }>;
}

export interface CompileContextInput {
  projectId: string;
  projectName: string;
  scope: ContextScope;
  sources: ContextSourceInput[];
  catalog?: LibraryCatalogEntry[];
  budgetTokens?: number;
  summaries?: Record<string, string>;
  systemInstruction?: string;
}

export class ContextBudgetError extends Error {}

const systemInstruction = `你是本软件的工作助理。你可以查询和操作当前项目中的资料、会话、任务、素材，以及部分系统设置。
项目内容不会自动全部进入上下文；需要时调用 library.search / library.read。
草稿和已发布文档是同一对象的不同状态。草稿代表用户当前想法，引用时必须保持草稿标记，不能当作已发布权威。
密钥、连接配置和高风险设置必须交给受保护界面，不能在对话中接收或回传。
不要替用户填写或提交生产 API 参数。`;

export function sourceSummaryKey(source: ContextSourceInput): string {
  return createHash('sha256')
    .update(`${source.id}\0${source.versionId ?? ''}\0${source.content}`)
    .digest('hex');
}

export function extractiveSummary(content: string, maxCharacters = 1800): string {
  if (maxCharacters <= 0) return '';
  if (content.length <= maxCharacters) return content;
  const marker = '\n\n[中间内容已按预算省略]\n\n';
  if (maxCharacters <= marker.length + 2) return content.slice(0, maxCharacters);
  const contentBudget = maxCharacters - marker.length;
  const head = Math.floor(contentBudget * 0.65);
  const tail = contentBudget - head;
  return `${content.slice(0, head).trimEnd()}${marker}${content.slice(-tail).trimStart()}`;
}

export function estimateTokenCount(content: string): number {
  return Math.ceil(tokenUnits(content) / 4);
}

export function extractiveSummaryByTokens(content: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokenCount(content) <= maxTokens) return content;
  const marker = '\n\n[中间内容已按预算省略]\n\n';
  const markerUnits = tokenUnits(marker);
  const availableUnits = maxTokens * 4;
  if (availableUnits <= markerUnits) return takePrefixByUnits(content, availableUnits);
  const contentUnits = availableUnits - markerUnits;
  const headUnits = Math.floor(contentUnits * 0.65);
  const tailUnits = contentUnits - headUnits;
  return `${takePrefixByUnits(content, headUnits).trimEnd()}${marker}${takeSuffixByUnits(
    content,
    tailUnits,
  ).trimStart()}`;
}

export function compileProductionContext(input: CompileContextInput): ProductionContext {
  const instruction = input.systemInstruction ?? systemInstruction;
  const budgetTokens = Math.min(Math.max(input.budgetTokens ?? 24_000, 1_000), 200_000);
  const relevant = input.sources
    .filter((source) => isRelevant(source, input.scope))
    .sort((left, right) => sourcePriority(left) - sourcePriority(right));
  const references: ContextSourceReference[] = [];
  let usedTokens = estimateTokenCount(instruction);

  const constraints = relevant.filter((source) => source.type === 'constraint');
  if (constraints.some((source) => !source.content.trim())) {
    throw new ContextBudgetError('Production constraints must not be empty.');
  }
  const renderedConstraints = constraints
    .map((source) => renderSource(source, source.content))
    .join('\n\n');
  const requiredConstraintTokens = estimateTokenCount(`${instruction}${renderedConstraints}`);
  if (requiredConstraintTokens > budgetTokens) {
    throw new ContextBudgetError(
      `Production constraints require approximately ${requiredConstraintTokens} tokens, exceeding the ${budgetTokens} token context budget.`,
    );
  }

  for (const source of relevant) {
    const cacheKey = sourceSummaryKey(source);
    const summary = input.summaries?.[cacheKey];
    const candidate =
      source.type !== 'constraint' && source.content.length > 8_000
        ? (summary ?? extractiveSummary(source.content))
        : source.content;
    const separator = references.length > 0 ? '\n\n' : '';
    const sourceOverhead = `${separator}${renderSource(source, '')}`;
    const available = Math.max(budgetTokens - usedTokens - estimateTokenCount(sourceOverhead), 0);
    const includedContent =
      source.type === 'constraint' ? candidate : extractiveSummaryByTokens(candidate, available);
    if (!includedContent) continue;
    references.push({
      ...source,
      includedContent,
      originalCharacters: source.content.length,
      includedCharacters: includedContent.length,
      truncated: includedContent.length < source.content.length,
      summaryCacheKey:
        source.type !== 'constraint' && source.content.length > 8_000 ? cacheKey : undefined,
    });
    usedTokens += estimateTokenCount(`${separator}${renderSource(source, includedContent)}`);
  }

  const rendered = references
    .map((source) => renderSource(source, source.includedContent))
    .join('\n\n');

  return {
    version: 1,
    projectId: input.projectId,
    projectName: input.projectName,
    scope: input.scope,
    systemInstruction: instruction,
    sources: references,
    catalog: input.catalog ?? [],
    estimatedTokens: estimateTokenCount(`${instruction}${rendered}`),
    budgetTokens,
    rendered,
  };
}

export function toContextManifest(context: ProductionContext): ProductionContextManifest {
  return {
    version: 1,
    projectId: context.projectId,
    projectName: context.projectName,
    scope: context.scope,
    estimatedTokens: context.estimatedTokens,
    budgetTokens: context.budgetTokens,
    sources: context.sources.map((source) => ({
      id: source.id,
      type: source.type,
      scopeType: source.scopeType,
      scopeId: source.scopeId,
      label: source.label,
      version: source.version,
      versionId: source.versionId,
      originalCharacters: source.originalCharacters,
      includedCharacters: source.includedCharacters,
      truncated: source.truncated,
    })),
  };
}

function tokenUnits(content: string): number {
  let units = 0;
  for (const character of content) units += character.codePointAt(0)! <= 0x7f ? 1 : 4;
  return units;
}

function takePrefixByUnits(content: string, maxUnits: number): string {
  let result = '';
  let used = 0;
  for (const character of content) {
    const units = character.codePointAt(0)! <= 0x7f ? 1 : 4;
    if (used + units > maxUnits) break;
    result += character;
    used += units;
  }
  return result;
}

function takeSuffixByUnits(content: string, maxUnits: number): string {
  const characters = Array.from(content);
  let start = characters.length;
  let used = 0;
  while (start > 0) {
    const character = characters[start - 1]!;
    const units = character.codePointAt(0)! <= 0x7f ? 1 : 4;
    if (used + units > maxUnits) break;
    start -= 1;
    used += units;
  }
  return characters.slice(start).join('');
}

function renderSource(source: ContextSourceInput, content: string): string {
  const version = source.version ? ` v${source.version}` : '';
  return `## ${source.label}${version}\n来源：${source.type} / ${source.scopeType}${source.scopeId ? `:${source.scopeId}` : ''}\n\n${content}`;
}

function isRelevant(source: ContextSourceInput, scope: ContextScope): boolean {
  // A project conversation is the project-wide Agent workspace. It must see
  // every published project/scene/shot source that belongs to this project;
  // scene and shot filtering is retained only for legacy scoped conversations.
  if (scope.type === 'project') return true;
  if (source.scopeType === 'project') return true;
  if (source.scopeType === 'scene')
    return source.scopeId === (scope.type === 'scene' ? scope.id : scope.sceneId);
  return scope.type === 'shot' && source.scopeId === scope.id;
}

function sourcePriority(source: ContextSourceInput): number {
  if (source.type === 'constraint') return 0;
  if (source.priority !== undefined) return source.priority;
  if (source.type === 'document') return 20;
  if (source.type === 'memory') return 30;
  return 40;
}
