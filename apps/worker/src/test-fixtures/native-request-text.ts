import type { NativeProviderStreamStartParams } from '@ai-video/contracts';

/** User text in wire order, including the latest dynamic state after tool history. */
export function nativeRequestUserText(request: NativeProviderStreamStartParams): string {
  return [
    request.prompt,
    ...(request.contextTurns ?? []).flatMap((turn) => turn.userMessages ?? []),
  ].join('\n');
}
