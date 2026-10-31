import { app, session } from 'electron';
import type { Logger } from './logger';

/**
 * InsomniaZ makes no network requests. Anything that tries is blocked, except
 * the local Vite dev server while developing. This is defense in depth on top
 * of the renderer CSP.
 */
export function installNetGuard(devUrl: string | null, log: Logger): void {
  const devOrigin = devUrl ? new URL(devUrl).origin : null;

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const url = details.url;
    if (
      url.startsWith('file://') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      url.startsWith('devtools://')
    ) {
      callback({ cancel: false });
      return;
    }
    if (devOrigin && url.startsWith(devOrigin)) {
      callback({ cancel: false });
      return;
    }
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = 'invalid';
    }
    log.warn('blocked external request', { host });
    callback({ cancel: true });
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
