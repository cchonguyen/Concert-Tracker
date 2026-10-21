import React from 'react';
import type { LoggedEvent } from '../services/lineupApi';
import { eventTitleParts } from '../services/series';

// An event's title as the app shows it (eventTitle), with the event's name
// set a little softer than the acts in front of it: "Gryffin - Alive Tour".
export const EventTitle: React.FC<{ event: LoggedEvent }> = ({ event }) => {
  const { artists, name } = eventTitleParts(event);
  if (!artists) return <>{name}</>;
  return (
    <>
      {artists}
      <span className="font-normal opacity-60"> - {name}</span>
    </>
  );
};
