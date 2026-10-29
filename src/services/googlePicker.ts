// Google's file picker, for linking a sheet under the narrow drive.file scope:
// picking a file in it is what grants this app access to that one file. The
// script comes from Google; the token, key and app id come from the server
// (/api/sheets/picker). Nothing here is stored.

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

let loading: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const done = () => window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google picker did not load.')) });
    if (window.gapi) return done();
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = done;
    script.onerror = () => reject(new Error('Could not reach Google to open the picker.'));
    document.head.appendChild(script);
  });
  return loading.catch((err) => {
    loading = null;
    throw err;
  });
}

// Resolves with the picked sheet's id, or null when the picker is closed.
export async function pickSpreadsheet(info: { accessToken: string; apiKey: string; appId: string }): Promise<string | null> {
  await loadPicker();
  const g = window.google.picker;
  return new Promise((resolve) => {
    new g.PickerBuilder()
      .addView(new g.DocsView(g.ViewId.SPREADSHEETS).setSelectFolderEnabled(false))
      .setOAuthToken(info.accessToken)
      .setDeveloperKey(info.apiKey)
      .setAppId(info.appId)
      .setCallback((data: any) => {
        if (data[g.Response.ACTION] === g.Action.PICKED) resolve(String(data[g.Response.DOCUMENTS]?.[0]?.[g.Document.ID] ?? '') || null);
        else if (data[g.Response.ACTION] === g.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
