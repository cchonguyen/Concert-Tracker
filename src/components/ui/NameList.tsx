import { Fragment, type ReactNode } from 'react';

// Lineups and the acts you saw read like a lineup poster: names split by a small accent diamond instead of commas
// (Charlie, 2026-11-26). The diamond stays on the line of the name before it, so no line starts with one, and screen
// readers hear a comma instead of the shape.
export const NAME_DIAMOND = '◆';

// Plain text, for a title attribute or a canvas.
export const joinNames = (names: string[]): string => names.join(` ${NAME_DIAMOND} `);

export function NameSep() {
  return (
    <>
      <span aria-hidden="true" className="px-[0.35em] align-[0.12em] text-[0.6em] text-accent opacity-80">
        {'⁠'}
        {NAME_DIAMOND}
      </span>
      {/* The relative wrapper keeps the absolutely placed sr-only comma inside a truncated line, so it cannot widen the page. */}
      <span className="relative">
        <span className="sr-only">, </span>
      </span>
      {'​'}
    </>
  );
}

export function NameList({ names, render }: { names: string[]; render?: (name: string, i: number) => ReactNode }) {
  return (
    <>
      {names.map((name, i) => (
        <Fragment key={`${i}-${name}`}>
          {i > 0 && <NameSep />}
          {render ? render(name, i) : name}
        </Fragment>
      ))}
    </>
  );
}
