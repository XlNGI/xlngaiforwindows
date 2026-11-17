import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let ordinal = 0;
/** Explicit local diagnosis only. Native params contain no credentials or headers. */
export function captureTemplateRequest(label, params, expected) {
  const directory = process.env.P22_TEMPLATE_CAPTURE_DIR;
  if (!directory || !expected) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${label}-${++ordinal}.json`),
    JSON.stringify({ label, params, expected }, null, 2),
  );
}
