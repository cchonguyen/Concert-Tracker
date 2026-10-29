// Moving between events in the detail: the neighbours of the open event in its list, the next one with a gap,
// and the `event` parameter in the address. Pure: the screen passes in the list's ids and which of them have a gap.

export interface Neighbours {
  prev: string | null;
  next: string | null;
}

// The events just above and below the open one. Nothing wraps around the ends of the list.
export function neighbours(ids: string[], current: string): Neighbours {
  const at = ids.indexOf(current);
  if (at < 0) return { prev: null, next: null };
  return {
    prev: at > 0 ? ids[at - 1] : null,
    next: at < ids.length - 1 ? ids[at + 1] : null,
  };
}

// The first event below the open one that is missing at least one thing. Nothing above it is looked at.
export function nextWithGap(ids: string[], current: string, hasGap: (id: string) => boolean): string | null {
  const at = ids.indexOf(current);
  if (at < 0) return null;
  return ids.slice(at + 1).find(hasGap) ?? null;
}

// The event id in an address, or null.
export function eventParam(search: string): string | null {
  return new URLSearchParams(search).get('event') || null;
}

// The address's query string with `event` set to the id, or removed when id is null. Other parameters stay as they are.
export function withEventParam(search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id) params.set('event', id);
  else params.delete('event');
  const query = params.toString();
  return query ? `?${query}` : '';
}
