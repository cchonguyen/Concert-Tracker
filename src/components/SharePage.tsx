import React, { useState } from 'react';
import { Segmented } from './ui/Segmented';
import { SharePanel } from './SharePanel';
import { ShareCards } from './ShareCards';
import type { LoggedEvent } from '../server/events/types';

// Share is a Library page with two tabs: "Your link" (SharePanel) and "Event
// cards" (ShareCards, drawn in the browser and saved as a PNG).
//
// In sample mode (`sample` set) nothing reaches the server: every action calls
// `sample` instead, which opens the sample explainer.

type ShareTab = 'link' | 'cards';

export const SharePage: React.FC<{ events: LoggedEvent[]; today: string; sample?: () => void }> = ({ events, today, sample }) => {
  const [tab, setTab] = useState<ShareTab>('link');

  return (
    <div className="space-y-5">
      <Segmented<ShareTab>
        label="Share tabs"
        options={[
          { value: 'link', label: 'Your link' },
          { value: 'cards', label: 'Event cards' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'link' ? <SharePanel sample={sample} /> : <ShareCards events={events} today={today} sample={sample} />}
    </div>
  );
};
