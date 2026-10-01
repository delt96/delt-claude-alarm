export function permissionKey(sessionId: string, requestId: string): string {
  return `${sessionId}\n${requestId}`;
}
