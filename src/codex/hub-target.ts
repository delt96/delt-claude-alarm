import { hubUrlHost } from '../shared/hub-url.js';
import type { AppConfig } from '../shared/types.js';

export interface AdapterHub {
  host: string;
  port: number;
  token?: string;
  fromEnv: { host: boolean; port: boolean; token: boolean };
}

export function resolveAdapterHub(config: AppConfig, env: NodeJS.ProcessEnv = process.env): AdapterHub {
  const envHost = env.CLAUDE_ALARM_HUB_HOST;
  const envPort = env.CLAUDE_ALARM_HUB_PORT;
  const envToken = env.CLAUDE_ALARM_HUB_TOKEN;
  return {
    host: hubUrlHost(envHost ?? config.hub.host),
    port: envPort ? parseInt(envPort, 10) : config.hub.port,
    token: envToken ?? config.hub.token,
    fromEnv: { host: envHost !== undefined, port: !!envPort, token: envToken !== undefined },
  };
}
