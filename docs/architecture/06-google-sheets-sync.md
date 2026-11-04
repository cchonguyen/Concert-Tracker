# Google Sheets sync

Part of [ARCHITECTURE.md](../../ARCHITECTURE.md).


A Google Sheet you link in the Table view ("Google Sheets", `src/components/SheetSync.tsx`) is a copy of your log, written one way: the app is the source of truth, and nothing typed in the sheet is read back into the app. To bring events from a sheet in, download it as CSV and use Import a list (above).

- **Sign-in.** The same Google client as Check email (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), asking for `spreadsheets` and your address, with its own refresh token in `app_settings` (`google_sheets`), separate from Gmail's. Google sends the sign-in back to `/api/gmail/callback`, the address already registered; `sheetsRouter` (`src/server/events/sheetRoutes.ts`, mounted before the imports router) takes it when the state starts with `sheets-` and passes anything else on. The Google Cloud project needs the Google Sheets API turned on.
- **Link.** Paste a sheet's link (the tab open in it, from `#gid=`, is the one written; otherwise the first tab), or make a new sheet with an `Events` tab. Only that tab is read or written (`src/server/events/sheets.ts`).
- **Update the sheet.** The tab is rewritten from your whole log (`eventRows`, the CSV's columns), and the rows written are kept in `app_settings` (`google_sheets_base`). Before writing, the tab is read (unformatted; `sheetTable` turns date serials back into `YYYY-MM-DD`) only to compare it with that base: `outsideEdits` counts rows edited, added or removed in the sheet since the app wrote it (every row with data, for a tab the app never wrote). When there are any, or columns of your own that the rewrite would remove, you're told and asked to confirm; otherwise the tab is written straight away.
- **Nothing lost by surprise.** The write is refused (409) when the tab changed since it was read (`sheetVersion`). A tab with data but no `Event` or `Name` column is never overwritten.
