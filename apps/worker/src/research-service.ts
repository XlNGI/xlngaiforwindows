import { createHash, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const DEFAULT_SEARCH_ENDPOINT = 'https://cn.bing.com/search';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SOURCE_HANDLE_TTL_MS = 10 * 60_000;
const MAX_QUERY_CHARACTERS = 200;
const MAX_EXTRACTED_CHARACTERS = 100_000;
const MAX_REDIRECTS = 4;
const PUBLIC_DNS_ENDPOINT = 'https://1.1.1.1/dns-query';
const PUBLIC_DNS_TIMEOUT_MS = 5_000;
const PUBLIC_DNS_RESPONSE_LIMIT = 32 * 1024;
const NATIVE_BRIDGE_REQUEST_LIMIT = 32 * 1024;

export const DEFAULT_RESEARCH_ADAPTER_ID = 'bing-html-public-v1';

export type ResearchErrorCode =
  | 'RESEARCH_SEARCH_FAILED'
  | 'RESEARCH_FETCH_BLOCKED'
  | 'RESEARCH_SOURCE_TOO_LARGE'
  | 'RESEARCH_CANCELLED';

export class ResearchError extends Error {
  constructor(
    readonly code: ResearchErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ResearchSourceSummary {
  adapterId: string;
  sourceHandle: string;
  title: string;
  site: string;
  canonicalUrl: string;
  snippet: string;
  retrievedAt: string;
  citationLabel?: string;
}

export interface ResearchSearchResult {
  status: 'searched';
  adapterId: string;
  queryHash: string;
  resultCount: number;
  sources: ResearchSourceSummary[];
}

export interface ResearchFetchResult extends ResearchSourceSummary {
  status: 'fetched';
  contentHash: string;
  content: string;
  characterCount: number;
  truncated: boolean;
  cacheRelativePath: string;
  untrusted: true;
}

interface SourceHandleRecord extends ResearchSourceSummary {
  taskId: string;
  attemptId: string;
  expiresAt: number;
}

type Lookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ResearchServiceOptions {
  fetch?: typeof fetch;
  lookup?: Lookup;
  publicLookup?: Lookup;
  searchEndpoint?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  adapterId?: string;
}

export class ResearchService {
  private readonly fetcher: typeof fetch;
  private readonly lookup: Lookup;
  private readonly publicLookup: Lookup;
  private readonly searchEndpoint: string;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly adapterId: string;
  private readonly sourceHandles = new Map<string, SourceHandleRecord>();

  constructor(options: ResearchServiceOptions = {}) {
    const nativeBridgeFetcher = options.fetch ? undefined : createNativeBridgeFetcher();
    this.fetcher = options.fetch ?? nativeBridgeFetcher ?? unavailableResearchFetcher;
    this.lookup = options.lookup ?? dnsLookup;
    this.publicLookup =
      options.publicLookup ?? (nativeBridgeFetcher ? unavailableLookup : publicDnsLookup);
    this.searchEndpoint = options.searchEndpoint ?? DEFAULT_SEARCH_ENDPOINT;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.adapterId = options.adapterId ?? DEFAULT_RESEARCH_ADAPTER_ID;
  }

  async search(params: {
    taskId: string;
    attemptId: string;
    query: string;
    language?: string;
    recencyDays?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ResearchSearchResult> {
    const query = normalizeQuery(params.query);
    const limit = boundedInteger(params.limit, 5, 1, 10);
    const endpoint = new URL(this.searchEndpoint);
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('count', String(limit));
    endpoint.searchParams.set('safeSearch', 'Strict');
    if (params.language) endpoint.searchParams.set('setlang', normalizeLanguage(params.language));
    if (params.recencyDays !== undefined) {
      endpoint.searchParams.set(
        'filters',
        params.recencyDays <= 1
          ? 'ex1:"ez1"'
          : params.recencyDays <= 7
            ? 'ex1:"ez2"'
            : params.recencyDays <= 31
              ? 'ex1:"ez3"'
              : 'ex1:"ez5_2000_2050"',
      );
    }

    let candidates: Array<{ url: string; title: string; snippet: string }>;
    try {
      const response = await this.request(endpoint, 'search', params.signal);
      candidates =
        response.contentType === 'application/json'
          ? flattenSearchResults(JSON.parse(response.body) as DuckDuckGoResponse)
          : parseBingSearchResults(response.body);
    } catch (error) {
      if (error instanceof ResearchError) throw error;
      throw new ResearchError('RESEARCH_SEARCH_FAILED', 'External search failed.', true);
    }

    const retrievedAt = new Date().toISOString();
    candidates = candidates.slice(0, limit * 3);
    const sources: ResearchSourceSummary[] = [];
    for (const candidate of candidates) {
      if (sources.length >= limit) break;
      try {
        const canonicalUrl = canonicalizeUrl(candidate.url);
        await this.assertPublicUrl(new URL(canonicalUrl));
        if (sources.some((source) => source.canonicalUrl === canonicalUrl)) continue;
        const sourceHandle = randomBytes(24).toString('base64url');
        const source: SourceHandleRecord = {
          adapterId: this.adapterId,
          sourceHandle,
          taskId: params.taskId,
          attemptId: params.attemptId,
          title: normalizeBoundedText(candidate.title || new URL(canonicalUrl).hostname, 300),
          site: new URL(canonicalUrl).hostname.toLowerCase(),
          canonicalUrl,
          snippet: normalizeBoundedText(candidate.snippet, 1_000),
          retrievedAt,
          expiresAt: Date.now() + SOURCE_HANDLE_TTL_MS,
        };
        this.sourceHandles.set(sourceHandle, source);
        sources.push(publicSource(source));
      } catch (error) {
        if (!(error instanceof ResearchError)) throw error;
      }
    }
    this.pruneExpiredHandles();
    return {
      status: 'searched',
      adapterId: this.adapterId,
      queryHash: sha256(query),
      resultCount: sources.length,
      sources,
    };
  }

  async fetchSource(params: {
    projectRoot: string;
    taskId: string;
    attemptId: string;
    sourceHandle: string;
    maxChars?: number;
    signal?: AbortSignal;
  }): Promise<ResearchFetchResult> {
    const source = this.sourceHandles.get(params.sourceHandle);
    if (
      !source ||
      source.taskId !== params.taskId ||
      source.attemptId !== params.attemptId ||
      source.expiresAt <= Date.now()
    ) {
      throw new ResearchError(
        'RESEARCH_FETCH_BLOCKED',
        'Research source handle is invalid or expired.',
        false,
      );
    }
    const maxChars = boundedInteger(params.maxChars, 50_000, 1, MAX_EXTRACTED_CHARACTERS);
    const response = await this.request(new URL(source.canonicalUrl), 'text', params.signal);
    if (params.signal?.aborted) {
      throw new ResearchError('RESEARCH_CANCELLED', 'External research was cancelled.', false);
    }
    const extracted = extractText(response.body, response.contentType);
    const truncated = extracted.length > maxChars;
    const content = extracted.slice(0, maxChars);
    if (!content.trim()) {
      throw new ResearchError(
        'RESEARCH_FETCH_BLOCKED',
        'The external source did not contain readable text.',
        false,
      );
    }
    const contentHash = sha256(content);
    const cacheRelativePath = `cache/research/${contentHash}.txt`;
    const cachePath = resolve(params.projectRoot, ...cacheRelativePath.split('/'));
    assertPathInside(params.projectRoot, cachePath);
    await mkdir(resolve(params.projectRoot, 'cache', 'research'), { recursive: true });
    if (params.signal?.aborted) {
      throw new ResearchError('RESEARCH_CANCELLED', 'External research was cancelled.', false);
    }
    await writeFile(cachePath, content, 'utf8');
    return {
      ...publicSource(source),
      status: 'fetched',
      contentHash,
      content,
      characterCount: content.length,
      truncated,
      cacheRelativePath,
      untrusted: true,
    };
  }

  private async request(
    initialUrl: URL,
    expected: 'search' | 'text',
    signal?: AbortSignal,
  ): Promise<{ body: string; contentType: string }> {
    let current = new URL(initialUrl);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await this.assertPublicUrl(current);
      const controller = new AbortController();
      if (signal?.aborted) {
        throw new ResearchError('RESEARCH_CANCELLED', 'External research was cancelled.', false);
      }
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(current, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            accept:
              expected === 'search'
                ? 'text/html,application/xhtml+xml,application/json;q=0.8'
                : 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.5',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 XLNGAI-Research/1.0',
          },
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) {
          throw new ResearchError('RESEARCH_CANCELLED', 'External research was cancelled.', false);
        }
        throw new ResearchError(
          expected === 'search' ? 'RESEARCH_SEARCH_FAILED' : 'RESEARCH_FETCH_BLOCKED',
          error instanceof Error && error.name === 'AbortError'
            ? 'External research request timed out.'
            : 'External research request failed.',
          true,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirect === MAX_REDIRECTS) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          throw new ResearchError(
            'RESEARCH_FETCH_BLOCKED',
            'External source redirect was invalid or exceeded the limit.',
            false,
          );
        }
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        throw new ResearchError(
          expected === 'search' ? 'RESEARCH_SEARCH_FAILED' : 'RESEARCH_FETCH_BLOCKED',
          `External research request returned HTTP ${response.status}.`,
          response.status === 429 || response.status >= 500,
        );
      }
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase();
      if (!isAllowedContentType(contentType, expected)) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        throw new ResearchError(
          'RESEARCH_FETCH_BLOCKED',
          'External source returned an unsupported content type.',
          false,
        );
      }
      try {
        return { body: await readBoundedBody(response, this.maxResponseBytes), contentType };
      } catch (error) {
        if (signal?.aborted) {
          throw new ResearchError('RESEARCH_CANCELLED', 'External research was cancelled.', false);
        }
        if (controller.signal.aborted && !(error instanceof ResearchError)) {
          throw new ResearchError(
            expected === 'search' ? 'RESEARCH_SEARCH_FAILED' : 'RESEARCH_FETCH_BLOCKED',
            'External research response timed out.',
            true,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw new ResearchError(
      'RESEARCH_FETCH_BLOCKED',
      'External source could not be fetched.',
      false,
    );
  }

  private async assertPublicUrl(url: URL): Promise<void> {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !url.hostname ||
      url.hostname.toLowerCase().endsWith('.local')
    ) {
      throw new ResearchError(
        'RESEARCH_FETCH_BLOCKED',
        'External source URL is outside the public HTTPS boundary.',
        false,
      );
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new ResearchError(
        'RESEARCH_FETCH_BLOCKED',
        'External source hostname could not be resolved safely.',
        true,
      );
    }
    if (!addresses.length) {
      throw new ResearchError(
        'RESEARCH_FETCH_BLOCKED',
        'External source hostname could not be resolved safely.',
        true,
      );
    }
    if (addresses.every((item) => isPublicAddress(item.address))) return;
    if (addresses.every((item) => isFakeIpAddress(item.address))) {
      try {
        const publicAddresses = await this.publicLookup(url.hostname, {
          all: true,
          verbatim: true,
        });
        if (
          publicAddresses.length > 0 &&
          publicAddresses.every((item) => isPublicAddress(item.address))
        ) {
          return;
        }
      } catch {
        // Fall through to the same fail-closed network boundary.
      }
    }
    throw new ResearchError(
      'RESEARCH_FETCH_BLOCKED',
      'External source resolved to a non-public network address.',
      false,
    );
  }

  private pruneExpiredHandles(): void {
    const now = Date.now();
    for (const [handle, source] of this.sourceHandles) {
      if (source.expiresAt <= now) this.sourceHandles.delete(handle);
    }
  }
}

function createNativeBridgeFetcher(): typeof fetch | undefined {
  const bridgeUrl = process.env.AI_VIDEO_RESEARCH_BRIDGE_URL;
  const token = process.env.AI_VIDEO_RESEARCH_BRIDGE_TOKEN;
  if (!bridgeUrl || !token) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(bridgeUrl);
  } catch {
    return undefined;
  }
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.pathname !== '/research' ||
    endpoint.username ||
    endpoint.password
  ) {
    return undefined;
  }
  const cancelEndpoint = new URL(endpoint);
  cancelEndpoint.pathname = '/research/cancel';
  return async (input, init) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method && init.method !== 'GET') {
      throw new Error('Native research bridge only supports GET requests.');
    }
    const accept = new Headers(init?.headers).get('accept');
    if (
      !accept ||
      Buffer.byteLength(target, 'utf8') + Buffer.byteLength(accept, 'utf8') >
        NATIVE_BRIDGE_REQUEST_LIMIT
    ) {
      throw new Error('Native research bridge request is invalid.');
    }
    const requestId = randomBytes(18).toString('base64url');
    const requestBody = JSON.stringify({ url: target, accept, requestId });
    if (Buffer.byteLength(requestBody, 'utf8') > NATIVE_BRIDGE_REQUEST_LIMIT) {
      throw new Error('Native research bridge request is invalid.');
    }
    const cancel = () => {
      void fetch(cancelEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ai-video-research-token': token,
        },
        body: JSON.stringify({ requestId }),
      }).catch(() => undefined);
    };
    init?.signal?.addEventListener('abort', cancel, { once: true });
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ai-video-research-token': token,
        },
        body: requestBody,
        signal: init?.signal,
      });
    } finally {
      init?.signal?.removeEventListener('abort', cancel);
    }
    const body = (await response.json()) as {
      status?: unknown;
      contentType?: unknown;
      location?: unknown;
      bodyBase64?: unknown;
      error?: unknown;
    };
    const status =
      typeof body.status === 'number' && Number.isInteger(body.status) ? body.status : undefined;
    if (
      !response.ok ||
      status === undefined ||
      typeof body.bodyBase64 !== 'string' ||
      (body.contentType !== undefined && typeof body.contentType !== 'string') ||
      (body.location !== undefined && typeof body.location !== 'string')
    ) {
      throw new Error(
        typeof body.error === 'string' ? body.error : 'Native research bridge failed.',
      );
    }
    const headers = new Headers();
    if (body.contentType) headers.set('content-type', body.contentType);
    if (body.location) headers.set('location', body.location);
    return new Response(Buffer.from(body.bodyBase64, 'base64url'), {
      status,
      headers,
    });
  };
}

const unavailableResearchFetcher: typeof fetch = () =>
  Promise.reject(new Error('Native research network bridge is unavailable.'));

const unavailableLookup: Lookup = () => Promise.resolve([]);

interface DuckDuckGoTopic {
  FirstURL?: string;
  Text?: string;
  Name?: string;
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  AbstractURL?: string;
  AbstractText?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoTopic[];
  Results?: DuckDuckGoTopic[];
}

function flattenSearchResults(
  payload: DuckDuckGoResponse,
): Array<{ url: string; title: string; snippet: string }> {
  const results: Array<{ url: string; title: string; snippet: string }> = [];
  if (payload.AbstractURL) {
    results.push({
      url: payload.AbstractURL,
      title: payload.Heading ?? payload.AbstractURL,
      snippet: payload.AbstractText ?? '',
    });
  }
  const visit = (topics: DuckDuckGoTopic[] | undefined) => {
    for (const topic of topics ?? []) {
      if (topic.FirstURL) {
        const text = topic.Text ?? '';
        results.push({
          url: topic.FirstURL,
          title: normalizeBoundedText(text.split(' - ', 1)[0] || topic.Name || topic.FirstURL, 300),
          snippet: text,
        });
      }
      visit(topic.Topics);
    }
  };
  visit(payload.Results);
  visit(payload.RelatedTopics);
  return results;
}

function parseBingSearchResults(
  body: string,
): Array<{ url: string; title: string; snippet: string }> {
  const results: Array<{ url: string; title: string; snippet: string }> = [];
  for (const match of body.matchAll(
    /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>[\s\S]*?<\/li>/gi,
  )) {
    const item = match[0];
    const anchor = item.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor?.[1]) continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(decodeHtmlEntities(anchor[1]));
    } catch {
      continue;
    }
    const paragraph = item.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '';
    results.push({
      url: parsedUrl.toString(),
      title: normalizeBoundedText(stripTags(anchor[2] ?? ''), 300),
      snippet: normalizeBoundedText(stripTags(paragraph), 1_000),
    });
  }
  return results;
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '));
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResearchError(
        'RESEARCH_SOURCE_TOO_LARGE',
        'External source exceeded the response size limit.',
        false,
      );
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function extractText(body: string, contentType: string): string {
  if (contentType === 'application/json') {
    return normalizeExtractedText(body);
  }
  const withoutUnsafeBlocks = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|object|embed|form)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeExtractedText(decodeHtmlEntities(withoutUnsafeBlocks));
}

function normalizeExtractedText(value: string): string {
  return stripUnsafeControlCharacters(value)
    .normalize('NFC')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripUnsafeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code === 0 ||
      (code >= 1 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
      ? ' '
      : character;
  }).join('');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => safeCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) =>
      safeCodePoint(Number.parseInt(digits, 16)),
    );
}

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : ' ';
}

function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function normalizeQuery(value: string): string {
  const query = value
    .normalize('NFC')
    .replace(/[\0\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query || query.length > MAX_QUERY_CHARACTERS) {
    throw new ResearchError('RESEARCH_SEARCH_FAILED', 'Research query is invalid.', false);
  }
  return query;
}

function normalizeLanguage(value: string): string {
  const language = value.trim().toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) {
    throw new ResearchError('RESEARCH_SEARCH_FAILED', 'Research language is invalid.', false);
  }
  return language;
}

function normalizeBoundedText(value: string, max: number): string {
  return value
    .normalize('NFC')
    .replace(/[\0\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function publicSource(source: SourceHandleRecord): ResearchSourceSummary {
  return {
    adapterId: source.adapterId,
    sourceHandle: source.sourceHandle,
    title: source.title,
    site: source.site,
    canonicalUrl: source.canonicalUrl,
    snippet: source.snippet,
    retrievedAt: source.retrievedAt,
  };
}

function isAllowedContentType(contentType: string, expected: 'search' | 'text'): boolean {
  if (expected === 'search') {
    return (
      contentType === 'text/html' ||
      contentType === 'application/xhtml+xml' ||
      contentType === 'application/json'
    );
  }
  return (
    contentType === 'text/html' ||
    contentType === 'application/xhtml+xml' ||
    contentType === 'text/plain' ||
    contentType === 'application/json'
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a! >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7));
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

function isFakeIpAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}

async function publicDnsLookup(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const responses = await Promise.all(
    [1, 28].map(async (type) => {
      const endpoint = new URL(PUBLIC_DNS_ENDPOINT);
      endpoint.searchParams.set('name', hostname);
      endpoint.searchParams.set('type', String(type));
      const response = await fetch(endpoint, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(PUBLIC_DNS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('Public DNS lookup failed.');
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > PUBLIC_DNS_RESPONSE_LIMIT) {
        throw new Error('Public DNS response exceeded the safe limit.');
      }
      const payload = JSON.parse(body) as {
        Status?: unknown;
        Answer?: Array<{ type?: unknown; data?: unknown }>;
      };
      if (payload.Status !== 0 || !Array.isArray(payload.Answer)) return [];
      return payload.Answer.flatMap((answer) => {
        if (
          (answer.type !== 1 && answer.type !== 28) ||
          typeof answer.data !== 'string' ||
          isIP(answer.data) === 0
        ) {
          return [];
        }
        return [{ address: answer.data, family: answer.type === 1 ? 4 : 6 }];
      });
    }),
  );
  return responses.flat();
}

function assertPathInside(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const child = relative(resolvedRoot, resolvedCandidate);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new ResearchError(
      'RESEARCH_FETCH_BLOCKED',
      'Research cache path escaped the project boundary.',
      false,
    );
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ResearchError('RESEARCH_FETCH_BLOCKED', 'Research limit is invalid.', false);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value && Number.isInteger(value) && value > 0 ? value : fallback;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
