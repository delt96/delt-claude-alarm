import net from 'node:net';

export function hubUrlHost(host: string): string {
  if (host === '' || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return net.isIPv6(host) ? `[${host}]` : host;
}
