# Lineup-poster name lists and see-through ticket notches

Charlie's requests, 2026-11-26:

- "In ticket stubs and anywhere else where a lineup/who you've seen set of artists show up, I think something other than a comma-separated list would be more interesting. Perhaps instead of a comma, we can have a different delimiter such as a diamond or dot, making it feel more like a lineup poster instead of a long list."
- Ticket stub cutouts (the notches) should be truly transparent instead of a solid fill, since the fill shows against coloured backgrounds.

Status: built in Slice 31.2.

## Name lists

- `NameList` and `NameSep` (`src/components/ui/NameList.tsx`) put a small accent diamond (◆) between names. The diamond is glued to the name before it with a word joiner and followed by a zero-width space, so a line can break after it but never starts with one. Screen readers skip the diamond and hear a comma.
- `joinNames` gives the same as plain text (`A ◆ B`) for title attributes and the share card canvas.
- Used wherever acts are listed: the ticket headline (after the "&" between the first two), the ticket's small line, Home's last show, Summary rows ("saw …"), the Table's acts column and its tooltip, Fill gaps' headliners and supports, and the year review's first-time acts.
- Lists of cities, stages, aliases and fields keep commas: they are not lineups. The "·" stays as the separator between different kinds of information (place · saw …).

## Notches

- `Ticket` and `StubHeader` paint their paper and border on a `::before` layer behind the content, and a CSS mask cuts circles out of it where the tear meets the edge. Whatever is behind the ticket shows through the hole.
- The positions come from the stub's measured place (`--notch-x`, `--notch-y` on the ticket; `--tear-y` on the stub header), kept current with a ResizeObserver. Content is not masked, so the stub can still tear away past the ticket's edge.
- The notch outlines are the stub's own half circles, now with no fill. The ticket's tear is drawn as painted dashes that stop short of the holes.
- `--ticket-ground` is no longer needed.
