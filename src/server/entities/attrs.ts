import { EntityKind } from './types';

// The attributes each kind keeps in `attrs`, defined here so a new one needs
// no migration (Manage step 5). Every value is your own words; nothing here
// is looked up or filled in. A person's first and last name go through
// `updatePerson` (they rename the record), and a place's city, state and
// country are its name, so neither is listed.

export interface AttrField {
  key: string;
  label: string;
  max: number;
  multiline?: boolean;
  placeholder?: string;
}

const note: AttrField = { key: 'note', label: 'Note', max: 2000, multiline: true, placeholder: 'Anything you want to remember' };

export const ATTR_FIELDS: Partial<Record<EntityKind, AttrField[]>> = {
  artist: [note],
  venue: [
    { key: 'address', label: 'Address', max: 300, placeholder: 'Street address' },
    { key: 'type', label: 'Type', max: 80, placeholder: 'Club, arena, park… in your words' },
    { key: 'capacity', label: 'Capacity', max: 40, placeholder: 'In your words' },
    note,
  ],
  series: [note],
  organization: [note],
  // Labels in the same group (Indoor, Outdoor) are one choice on a record.
  label: [{ key: 'group', label: 'Group', max: 60, placeholder: 'Indoor/Outdoor' }, note],
};

export const attrFields = (kind: EntityKind): AttrField[] => ATTR_FIELDS[kind] ?? [];
