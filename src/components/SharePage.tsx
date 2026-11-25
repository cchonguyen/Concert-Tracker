import React, { useState } from 'react';
import { Segmented } from './ui/Segmented';
import { SharePanel } from './SharePanel';

// Share is a Library page with two tabs: "Your link" (SharePanel) and "Event
// cards", which is still to come.
//
// In sample mode (`sample` set) nothing reaches the server: every action calls
// `sample` instead, which opens the sample explainer.

type ShareTab = 'link' | 'cards';

export const SharePage: React.FC<{ sample?: () => void }> = ({ sample }) => {
  const [tab, setTab] = useState<ShareTab>('link');
  const cardsTab = (
    <div role="region" aria-label="Event cards">
      <p className="text-sm text-text-muted">Pick an event to make a card. Coming next.</p>
    </div>
  );

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
      {tab === 'link' ? <SharePanel sample={sample} /> : cardsTab}
    </div>
  );
};
