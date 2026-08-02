import { statfsSync } from 'node:fs';

const MINIMUM_WRITE_RESERVE_BYTES = 16 * 1024 * 1024;

export interface StorageStats {
  bavail: number | bigint;
  bsize: number | bigint;
}

type StorageProbe = (path: string) => StorageStats;

export function assertStorageCapacity(
  directoryPath: string,
  requiredBytes: number,
  probe: StorageProbe = statfsSync,
): void {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
    throw new Error('Required storage size is invalid.');
  }
  const stats = probe(directoryPath);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error('Available disk space could not be determined safely.');
  }
  if (availableBytes < requiredBytes + MINIMUM_WRITE_RESERVE_BYTES) {
    throw new Error('Insufficient disk space for media output.');
  }
}
