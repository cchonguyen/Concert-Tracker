import React, { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { suggestionsFor } from '../services/format';

// A text input with suggestions listed under it while it has focus. Used in
// place of <datalist>, which phones (iOS Safari above all) barely show. A tap,
// or arrow keys then Enter, puts the suggestion in the input and leaves it, so
// the input's own blur handler saves it as if you had typed it.
export const SuggestInput: React.FC<
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value'> & {
    value: string;
    suggestions: string[];
    onPick: (value: string) => void;
  }
> = ({ value, suggestions, onPick, onFocus, onBlur, onKeyDown, onChange, ...rest }) => {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = open ? suggestionsFor(value, suggestions) : [];
  const pick = (s: string) => {
    flushSync(() => {
      onPick(s);
      setOpen(false);
      setActive(-1);
    });
    ref.current?.blur();
  };
  return (
    <div className="relative">
      <input
        {...rest}
        ref={ref}
        value={value}
        autoComplete="off"
        onFocus={(e) => {
          setOpen(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setOpen(false);
          setActive(-1);
          onBlur?.(e);
        }}
        onChange={(e) => {
          setOpen(true);
          setActive(-1);
          onChange?.(e);
        }}
        onKeyDown={(e) => {
          if (matches.length && e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % matches.length);
            return;
          }
          if (matches.length && e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
            return;
          }
          if (e.key === 'Enter' && matches[active]) {
            e.preventDefault();
            pick(matches[active]);
            return;
          }
          if (e.key === 'Escape' && matches.length) {
            setOpen(false);
            return;
          }
          onKeyDown?.(e);
        }}
      />
      {matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
        >
          {matches.map((s, i) => (
            <li key={s} role="option" aria-selected={i === active}>
              <button
                type="button"
                // Keep focus in the input, so its blur doesn't save the half-typed text first.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className={`block w-full truncate px-3 py-2 text-left text-sm ${
                  i === active ? 'bg-violet-600/30 text-violet-100' : 'text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
