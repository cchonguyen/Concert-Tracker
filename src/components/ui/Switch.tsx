// An on/off setting. The state is spelled out as well as shown by colour, so it reads without colour.
export function Switch({ checked, onChange, label, helper, disabled = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  helper?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="inline-flex min-h-11 w-full items-center justify-between gap-3 rounded-control px-1 text-left text-sm text-text hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-9"
      >
        <span>{label}</span>
        <span className="inline-flex items-center gap-2 text-xs text-text-muted">
          {checked ? 'On' : 'Off'}
          <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors motion-reduce:transition-none ${checked ? 'bg-accent-fill' : 'bg-line-strong'}`} aria-hidden="true">
            <span className={`absolute top-0.5 h-4 w-4 rounded-full transition-transform motion-reduce:transition-none ${checked ? 'left-[18px] bg-on-accent' : 'left-0.5 bg-text-muted'}`} />
          </span>
        </span>
      </button>
      {helper && <p className="px-1 text-xs text-text-muted">{helper}</p>}
    </div>
  );
}
