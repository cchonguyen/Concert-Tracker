// One sentence on what a write button does in your own archive, with the way
// in. Used by the demo's buttons so nothing in the demo calls the server.
export const DEMO_ACTIONS: Record<string, string> = {
  add: "In your archive, typing 'Portola 2025' looks up the real dates, venue and lineup from real sources, and you tick the acts you saw.",
  import: 'In your archive, Import reads a list of past shows you kept elsewhere and lets you check each row before anything is saved.',
  email: 'In your archive, Check email looks through your Gmail for ticket mail from the sellers the app can read, and puts what it finds on a list for you to tick.',
  lookup: 'In your archive, Look up lineup asks the sources for the acts on this event and shows where each one came from.',
  share: 'In your archive, Share makes a read-only page of your history with a link you can switch off.',
  sheets: 'In your archive, Google Sheets keeps a one-way copy of your log in a sheet you choose.',
  manage: 'In your archive, Manage is where you rename, merge and tidy your artists, venues and series.',
  edit: 'In your archive, you edit an event by changing its fields here; nothing you change is saved in the demo.',
};

export function DemoPrompt({ action, onBack }: { action: string; onBack: () => void }) {
  return (
    <div className="space-y-4 text-sm text-zinc-200">
      <p>{DEMO_ACTIONS[action] ?? 'In your archive, this button does something to your own log.'}</p>
      <div className="flex flex-wrap gap-2">
        <a href="/app" className="rounded-lg bg-violet-500 px-3 py-1.5 font-medium text-white">
          Log in (invite only)
        </a>
        <button type="button" onClick={onBack} className="rounded-lg border border-zinc-700 px-3 py-1.5">
          Back to demo
        </button>
      </div>
    </div>
  );
}
