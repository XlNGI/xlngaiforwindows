import { runPiRuntimeSpike } from './pi-runtime-spike.js';

void runPiRuntimeSpike()
  .then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  });
