import packageJson from '../../package.json';
import type { RemoteBackendHealthResponse } from '../../shared/types';

export const PILOT_APP_VERSION = packageJson.version;

export interface RemoteBackendCompatibility {
  status: 'compatible' | 'incompatible';
  message: string;
}

export function getRemoteBackendCompatibility(details: RemoteBackendHealthResponse): RemoteBackendCompatibility {
  if (details.appVersion === PILOT_APP_VERSION) {
    return {
      status: 'compatible',
      message: `Compatible with AI-Pilot ${PILOT_APP_VERSION}`,
    };
  }

  return {
    status: 'incompatible',
    message: `Backend version ${details.appVersion} does not match this app (${PILOT_APP_VERSION})`,
  };
}
