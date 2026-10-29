// The app's written words in one place. Tooltips, notices and the About page read from here,
// so wording changes happen once and match everywhere. Add entries as the screens that use them are built.
export const appName = 'LiveArchive';

// Shown on the About page. Bump it with each release that changes what people see.
export const appVersion = '1.1.0';

export const copy = {
  appName,
  appVersion,
} as const;
