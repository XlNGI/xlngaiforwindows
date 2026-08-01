#!/usr/bin/env node
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { handleRequest, parseRequest } from './handler.js';

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

function startStdio(): void {
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', (line) => {
    void enqueue(async () => {
      const parsed = parseRequest(JSON.parse(line) as unknown);
      writeResponse('ok' in parsed ? parsed : await handleRequest(parsed));
    }).catch(() => writeResponse(parseRequest(null)));
  });
}

function startHttp(port: number): void {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      response.writeHead(404).end();
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      void enqueue(async () => {
        const parsed = parseRequest(JSON.parse(body) as unknown);
        const result = 'ok' in parsed ? parsed : await handleRequest(parsed);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(result));
      }).catch(() => {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(parseRequest(null)));
      });
    });
  });

  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`AI Video Worker listening on http://127.0.0.1:${port}\n`);
  });

  const close = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

const httpFlagIndex = process.argv.indexOf('--http');
if (httpFlagIndex >= 0) {
  const port = Number(process.argv[httpFlagIndex + 1] ?? 43120);
  startHttp(port);
} else {
  startStdio();
}
