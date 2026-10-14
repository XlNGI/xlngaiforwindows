import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const resources = join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'ffmpeg');
const manifest = JSON.parse(readFileSync(join(resources, 'manifest.json'), 'utf8'));

async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function verify(directory) {
  for (const [name, expected] of Object.entries(manifest.files)) {
    if ((await hash(join(directory, name))) !== expected)
      throw new Error(`FFmpeg checksum mismatch: ${name}`);
  }
  for (const name of [
    'COPYING.LGPLv3.txt',
    'COPYING.GPLv3.txt',
    'OPENH264-LICENSE.txt',
    'NOTICE.txt',
  ]) {
    if ((await readFile(join(resources, name))).length === 0)
      throw new Error(`FFmpeg notice missing: ${name}`);
  }
  const executable = join(directory, 'ffmpeg.exe');
  const result = spawnSync(executable, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.error || result.status !== 0 || !result.stdout.includes(manifest.version)) {
    throw new Error('Bundled FFmpeg version probe failed.');
  }
  if (
    /--enable-(gpl|nonfree)\b/.test(result.stdout) ||
    !result.stdout.includes('--enable-libopenh264')
  ) {
    throw new Error('FFmpeg must be LGPL with the OpenH264 encoder.');
  }
  const probe = spawnSync(join(directory, 'ffprobe.exe'), ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (probe.error || probe.status !== 0 || !probe.stdout.includes(manifest.version))
    throw new Error('Bundled ffprobe probe failed.');
}

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('The pinned FFmpeg resource targets Windows x64.');
try {
  await verify(resources);
  console.log(`Bundled FFmpeg verified: ${manifest.version}`);
} catch (error) {
  if (process.argv.includes('--verify')) throw error;
  const temporary = await mkdtemp(join(tmpdir(), 'ai-video-ffmpeg-'));
  try {
    const argument = process.argv.indexOf('--archive');
    const localArchive = argument >= 0 ? process.argv[argument + 1] : undefined;
    if (argument >= 0 && !localArchive)
      throw new Error('--archive requires an existing pinned archive path.');
    const archive = localArchive ? resolve(localArchive) : join(temporary, manifest.archiveName);
    if (!localArchive) {
      console.log(`Downloading pinned LGPL FFmpeg: ${manifest.archiveName}`);
      const response = await fetch(manifest.archiveUrl, { signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body)
        throw new Error(`FFmpeg download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    }
    if ((await hash(archive)) !== manifest.archiveSha256)
      throw new Error('Pinned FFmpeg archive SHA256 mismatch.');
    const listing = spawnSync('tar.exe', ['-tf', archive], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    if (
      listing.error ||
      listing.status !== 0 ||
      listing.stdout
        .split(/\r?\n/)
        .some((path) => /(^|[/\\])\.\.([/\\]|$)|^[/\\]|^[a-z]:/i.test(path))
    ) {
      throw new Error('FFmpeg archive listing failed or contains an unsafe path.');
    }
    const extraction = spawnSync('tar.exe', ['-xf', archive, '-C', temporary], {
      windowsHide: true,
      timeout: 60000,
    });
    if (extraction.error || extraction.status !== 0)
      throw new Error('Pinned FFmpeg extraction failed.');
    const packageDirectory = join(temporary, manifest.archiveName.replace(/\.zip$/, ''));
    const binaries = join(packageDirectory, 'bin');
    await verify(binaries);
    await mkdir(resources, { recursive: true });
    for (const name of await readdir(binaries)) {
      if (name in manifest.files) await copyFile(join(binaries, name), join(resources, name));
    }
    await verify(resources);
    console.log(`Bundled FFmpeg prepared and verified: ${manifest.version}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
