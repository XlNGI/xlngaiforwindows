const WAN_WORKSPACE_URL =
  /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cn-beijing\.maas\.aliyuncs\.com$/u;

export function wanVideoWorkspaceId(baseUrl: string): string | undefined {
  return WAN_WORKSPACE_URL.exec(baseUrl)?.[1];
}

export function isWanVideoBaseUrl(baseUrl: string): boolean {
  return baseUrl === 'https://dashscope.aliyuncs.com' || Boolean(wanVideoWorkspaceId(baseUrl));
}
