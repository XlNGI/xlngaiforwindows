#!/usr/bin/env node
import { createReadStream, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { IPC_PROTOCOL_VERSION, type AssetMediaSourceInfo } from '@ai-video/contracts';
import {
  authorizeDevHttpMediaRequest,
  authorizeDevHttpRequest,
  createDevHttpToken,
  DEV_HTTP_TOKEN_HEADER,
  publishDevHttpToken,
  removeDevHttpToken,
} from './dev-http-security.js';
import { handleRequest, parseRequest, recordQueueWait, recordWorkerError } from './handler.js';
import { RequestScheduler } from './request-scheduler.js';

const requestScheduler = new RequestScheduler({
  onQueueWait: (method, waitMs) => recordQueueWait(method, waitMs),
});

function writeResponse(response: unknown): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
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
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', (line) => {
    void (async () => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        recordWorkerError('ipc.parse', error);
        writeResponse(parseRequest(null));
        return;
      }
      const parsed = parseRequest(value);
      writeResponse(
        'ok' in parsed
          ? parsed
          : await requestScheduler.run(parsed.method, () => handleRequest(parsed)),
      );
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
    const mediaMatch = request.url?.match(/^\/media\/([^/?#]+)$/);
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
        assetId = decodeURIComponent(mediaMatch[1]!);
      } catch {
        response.writeHead(400).end();
        return;
      }
      void requestScheduler
        .run('asset.mediaSource', async () => {
          const result = await handleRequest({
            id: `dev-media:${assetId}`,
            protocolVersion: IPC_PROTOCOL_VERSION,
            method: 'asset.mediaSource',
            params: { assetId },
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
        const result =
          'ok' in parsed
            ? parsed
            : await requestScheduler.run(parsed.method, () => handleRequest(parsed));
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
  const close = (): void => {
    cleanupDevelopmentToken();
    server.close(() => process.exit(0));
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
