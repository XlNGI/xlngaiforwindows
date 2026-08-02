#!/usr/bin/env node
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import {
  authorizeDevHttpRequest,
  createDevHttpToken,
  DEV_HTTP_TOKEN_HEADER,
  publishDevHttpToken,
  removeDevHttpToken,
} from './dev-http-security.js';
import { handleRequest, parseRequest, recordWorkerError } from './handler.js';

let requestQueue = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(task, task);
  requestQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function writeResponse(response: unknown): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function startStdio(): void {
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', (line) => {
    void enqueue(async () => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        recordWorkerError('ipc.parse', error);
        writeResponse(parseRequest(null));
        return;
      }
      const parsed = parseRequest(value);
      writeResponse('ok' in parsed ? parsed : await handleRequest(parsed));
    }).catch((error) => {
      recordWorkerError('ipc.request', error);
      writeResponse(parseRequest(null));
    });
  });
}

function startHttp(port: number, secureDevelopmentMode: boolean): void {
  const developmentToken = secureDevelopmentMode ? createDevHttpToken() : undefined;
  let developmentTokenPath: string | undefined;
  const server = createServer((request, response) => {
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
      void enqueue(async () => {
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
        const result = 'ok' in parsed ? parsed : await handleRequest(parsed);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result));
      }).catch((error) => {
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
