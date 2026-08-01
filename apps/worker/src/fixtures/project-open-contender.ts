import { existsSync, writeFileSync } from 'node:fs';
import { ProjectService } from '../project-service.js';

const [rootPath, recentProjectsPath, readyPath, startPath, resultPath, releasePath] =
  process.argv.slice(2);

if (!rootPath || !recentProjectsPath || !readyPath || !startPath || !resultPath || !releasePath) {
  throw new Error('Missing project lock contender argument.');
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const waitForFile = async (path: string) => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await delay(5);
  }
};

const projects = new ProjectService({ recentProjectsPath });
writeFileSync(readyPath, 'ready', 'utf8');
await waitForFile(startPath);
try {
  const project = projects.open(rootPath);
  writeFileSync(resultPath, JSON.stringify({ mode: project.mode }), 'utf8');
  await waitForFile(releasePath);
} catch (error) {
  writeFileSync(
    resultPath,
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    'utf8',
  );
} finally {
  projects.close();
}
