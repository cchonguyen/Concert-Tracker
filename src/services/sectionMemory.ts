// Whether a collapsible section of the event detail is open, remembered per device. Every access is in try/catch,
// so a private window or blocked storage just means the section starts as it is by default.
const KEY = 'liveArchive.sectionOpen.';

export function sectionOpen(name: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(KEY + name);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export function rememberSection(name: string, open: boolean): void {
  try {
    window.localStorage.setItem(KEY + name, open ? '1' : '0');
  } catch {
    // Storage is blocked; the section simply opens as its default next time.
  }
}
