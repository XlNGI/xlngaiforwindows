import { createHash } from 'node:crypto';

/** Keep the first full result in history and shorten only later identical reads. */
export class RepeatedReadResults {
  private readonly firstCopies = new Map<string, string>();

  use(callId: string, output: string): string {
    if (output.length <= 2000) return output;
    const hash = createHash('sha256').update(output).digest('hex');
    const first = this.firstCopies.get(hash);
    if (first)
      return JSON.stringify({
        status: 'identical_result',
        fullResultCallId: first,
        contentHash: hash,
        instruction:
          'Reuse the exact full result at the earlier tool call. Its version and content are unchanged.',
      });
    if (this.firstCopies.size >= 64) this.firstCopies.delete(this.firstCopies.keys().next().value!);
    this.firstCopies.set(hash, callId);
    return output;
  }

  clear(): void {
    this.firstCopies.clear();
  }
}
