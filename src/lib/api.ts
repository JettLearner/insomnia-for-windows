import type { InsomniazApi, WindowName } from '../../shared/types';

/** The preload bridge exposed with contextIsolation. */
export function getApi(): InsomniazApi | null {
  return window.insomniaz ?? null;
}

export function requireApi(): InsomniazApi {
  const api = window.insomniaz;
  if (!api) throw new Error('InsomniaZ preload bridge is unavailable.');
  return api;
}

const WINDOWS: readonly WindowName[] = ['panel', 'settings', 'onboarding', 'autopilot'];

export function readWindowName(): WindowName {
  const raw = new URLSearchParams(window.location.search).get('window');
  return WINDOWS.includes(raw as WindowName) ? (raw as WindowName) : 'panel';
}

export function readSection(): string {
  return new URLSearchParams(window.location.search).get('section') ?? 'general';
}

/** Keeps the query string in sync without reloading the renderer. */
export function replaceSection(section: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('section', section);
  window.history.replaceState(null, '', url.toString());
}
