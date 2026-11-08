#!/usr/bin/env node
import { createReadStream, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import {
  IPC_PROTOCOL_VERSION,
  SIDECAR_ENVELOPE_MAX_BYTES,
  type AssetMediaSourceInfo,
  type WorkerRequest,
  type WorkerResponse,
} from '@ai-video/contracts';
import {
  authorizeDevHttpMediaRequest,
  authorizeDevHttpRequest,
  createDevHttpToken,
  DEV_HTTP_TOKEN_HEADER,
  publishDevHttpToken,
  removeDevHttpToken,
} from './dev-http-security.js';
import {
  configurePiConversationRuntime,
  bindWorkerRequest,
  handleRequest,
  parseRequest,
  recordQueueWait,
  recordWorkerError,
  beginWorkerShutdown,
  shutdownWorker,
} from './handler.js';
import { JsonLineWriter, NativeProviderBridge } from './native-provider-bridge.js';
import { RequestScheduler, WorkerStoppingError } from './request-scheduler.js';
import { writeWorkerResponse } from './worker-response-writer.js';

const requestScheduler = new RequestScheduler({
  onQueueWait: (method, waitMs) => recordQueueWait(method, waitMs),
});

async function dispatchRequest(parsed: WorkerRequest | WorkerResponse): Promise<WorkerResponse> {
  if ('ok' in parsed) return parsed;
  const bound = bindWorkerRequest(parsed);
  try {
    return await requestScheduler.run(parsed.method, bound.run, bound.queueKey);
  } catch (error) {
    if (!(error instanceof WorkerStoppingError)) throw error;
    return {
      id: parsed.id,
      protocolVersion: IPC_PROTOCOL_VERSION,
      ok: false,
      error: {
        code: 'INVALID_STATE',
        message: error.message,
        retryable: true,
        requestId: parsed.id,
        details: { reason: 'worker_stopping', executed: false },
      },
    };
  } finally {
    // Queued work may be rejected without invoking bound.run's own finally.
    bound.release();
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function streamMedia(
  response: ServerResponse,
  media: AssetMediaSourceInfo,
  rangeHeader: string | undefined,
): void {
  const size = statSync(media.path).size;
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    response.writeHead(200, {
      'accept-ranges': 'bytes',
      'content-length': size,
      'content-type': media.contentType,
    });
    createReadStream(media.path).pipe(response);
    return;
  }

  const requestedStart = match[1] ? Number(match[1]) : undefined;
  const requestedEnd = match[2] ? Number(match[2]) : undefined;
  const start = requestedStart ?? Math.max(size - (requestedEnd ?? 0), 0);
  const end =
    requestedStart === undefined ? size - 1 : Math.min(requestedEnd ?? size - 1, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  response.writeHead(206, {
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${size}`,
    'content-type': media.contentType,
  });
  createReadStream(media.path, { start, end }).pipe(response);
}

function startStdio(): void {
  const writer = new JsonLineWriter(process.stdout);
  const bridge = new NativeProviderBridge({ send: (envelope) => writer.write(envelope) });
  configurePiConversationRuntime(bridge);
  const writeResponse = (response: { id: string }): void => {
    void writeWorkerResponse(writer, response).catch((error) =>
      recordWorkerError('ipc.write', error),
    );
  };
  const input = createInterface({ input: process.stdin, terminal: false });
  let stopping: Promise<void> | undefined;
  const stop = (reason: 'host_shutdown' | 'host_disconnect', id?: string): Promise<void> => {
    if (stopping) return stopping;
    requestScheduler.closeAdmission();
    stopping = (async () => {
      beginWorkerShutdown(reason);
      bridge.close({
        code: 'INTERRUPTED',
        message: 'Worker is stopping for recovery.',
        retryable: true,
      });
      await requestScheduler.drain();
      await shutdownWorker(reason);
      if (id)
        await writer.write({
          id,
          protocolVersion: IPC_PROTOCOL_VERSION,
          ok: true,
          result: { stopped: true, reason },
        });
      input.close();
      process.exit(0);
    })().catch((error) => {
      recordWorkerError('worker.shutdown', error);
      process.exit(1);
    });
    return stopping;
  };
  input.once('close', () => void stop('host_disconnect'));
  process.once('SIGINT', () => void stop('host_shutdown'));
  process.once('SIGTERM', () => void stop('host_shutdown'));
  input.on('line', (line) => {
    void (async () => {
      if (Buffer.byteLength(line, 'utf8') > SIDECAR_ENVELOPE_MAX_BYTES) {
        recordWorkerError('ipc.size', new Error('Sidecar line exceeds the 2 MiB limit.'));
        bridge.interruptAll({
          code: 'MESSAGE_TOO_LARGE',
          message: 'Native host message exceeds the 2 MiB limit.',
          retryable: false,
        });
        writeResponse(parseRequest(null));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        recordWorkerError('ipc.parse', error);
        writeResponse(parseRequest(null));
        return;
      }
      try {
        if (
          value &&
          typeof value === 'object' &&
          'kind' in value &&
          value.kind === 'host.control'
        ) {
          const control = value as Record<string, unknown>;
          if (
            control.version === 1 &&
            control.method === 'worker.shutdown' &&
            control.reason === 'host_shutdown' &&
            typeof control.id === 'string'
          )
            await stop('host_shutdown', control.id);
          return;
        }
        // Host replies must remain routable while admitted operations drain.
        if (bridge.handleEnvelope(value)) return;
      } catch (error) {
        recordWorkerError('ipc.host-envelope', error);
        return;
      }
      const parsed = parseRequest(value);
      writeResponse(await dispatchRequest(parsed));
    })().catch((error) => {
      recordWorkerError('ipc.request', error);
      writeResponse(parseRequest(null));
    });
  });
}

function startHttp(port: number, secureDevelopmentMode: boolean): void {
  const developmentToken = secureDevelopmentMode ? createDevHttpToken() : undefined;
  let developmentTokenPath: string | undefined;
  const server = createServer((request, response) => {
    const mediaUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const mediaMatch = mediaUrl.pathname.match(/^\/media\/(audio\/)?([^/?#]+)$/);
    if (request.method === 'GET' && mediaMatch && developmentToken) {
      const authorization = authorizeDevHttpMediaRequest(
        {
          origin: singleHeader(request.headers.origin),
          token: singleHeader(request.headers[DEV_HTTP_TOKEN_HEADER]),
        },
        developmentToken,
      );
      if (!authorization.ok) {
        response.writeHead(authorization.status).end();
        return;
      }
      let assetId: string;
      try {
        assetId = decodeURIComponent(mediaMatch[2]!);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const mediaMethod = mediaMatch[1]
        ? 'audio.mediaSource'
        : mediaUrl.searchParams.get('thumbnail') === '1'
          ? 'asset.thumbnail'
          : 'asset.mediaSource';
      void requestScheduler
        .run(mediaMethod, async () => {
          const result = await handleRequest({
            id: `dev-media:${assetId}`,
            protocolVersion: IPC_PROTOCOL_VERSION,
            method: mediaMethod,
            params: mediaMatch[1] ? { audioId: assetId } : { assetId },
            ...(mediaUrl.searchParams.has('projectId') ||
            mediaUrl.searchParams.has('projectSessionId')
              ? {
                  scope: {
                    projectId: mediaUrl.searchParams.get('projectId') ?? '',
                    projectSessionId: mediaUrl.searchParams.get('projectSessionId') ?? '',
                  },
                }
              : {}),
          });
          if (!result.ok) {
            response.writeHead(404).end();
            return;
          }
          streamMedia(
            response,
            result.result as AssetMediaSourceInfo,
            singleHeader(request.headers.range),
          );
        })
        .catch((error) => {
          recordWorkerError('http.media', error);
          if (!response.headersSent) response.writeHead(404);
          response.end();
        });
      return;
    }

    if (request.method !== 'POST' || request.url !== '/rpc') {
      response.writeHead(404).end();
      return;
    }

    if (developmentToken) {
      const authorization = authorizeDevHttpRequest(
        {
          origin: singleHeader(request.headers.origin),
          contentType: singleHeader(request.headers['content-type']),
          token: singleHeader(request.headers[DEV_HTTP_TOKEN_HEADER]),
        },
        developmentToken,
      );
      if (!authorization.ok) {
        response.writeHead(authorization.status, {
          'content-type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify({ error: authorization.message }));
        return;
      }
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      void (async () => {
        let value: unknown;
        try {
          value = JSON.parse(body) as unknown;
        } catch (error) {
          recordWorkerError('http.parse', error);
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify(parseRequest(null)));
          return;
        }
        const parsed = parseRequest(value);
        const result = await dispatchRequest(parsed);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result));
      })().catch((error) => {
        recordWorkerError('http.request', error);
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(parseRequest(null)));
      });
    });
  });

  server.listen(port, '127.0.0.1', () => {
    if (developmentToken) {
      try {
        developmentTokenPath = publishDevHttpToken(port, developmentToken);
      } catch (error) {
        recordWorkerError('http.dev-token', error);
        server.close(() => process.exit(1));
        return;
      }
    }
    process.stderr.write(`AI Video Worker listening on http://127.0.0.1:${port}\n`);
  });

  const cleanupDevelopmentToken = (): void => {
    if (developmentToken && developmentTokenPath) {
      removeDevHttpToken(developmentTokenPath, developmentToken);
      developmentTokenPath = undefined;
    }
  };
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    cleanupDevelopmentToken();
    requestScheduler.closeAdmission();
    beginWorkerShutdown('host_shutdown');
    server.close();
    void requestScheduler
      .drain()
      .then(() => shutdownWorker('host_shutdown'))
      .then(
        () => process.exit(0),
        (error: unknown) => {
          recordWorkerError('worker.shutdown', error);
          process.exit(1);
        },
      );
  };
  process.once('exit', cleanupDevelopmentToken);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

const httpFlagIndex = process.argv.indexOf('--http');
if (httpFlagIndex >= 0) {
  const port = Number(process.argv[httpFlagIndex + 1] ?? 43120);
  startHttp(port, process.argv.includes('--dev-http'));
} else {
  startStdio();
}
