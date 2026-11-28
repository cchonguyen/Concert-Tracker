# Philosophy and voice

What LiveArchive believes, how that shows in the interface, and how it talks. The ranked list is LiveArchive's own ([REQUIREMENTS.md](../../REQUIREMENTS.md) section 3); a new app should keep the order idea and rewrite the domain parts.

## Ranked principles

When two conflict, the earlier one wins.

| # | Principle | What it means in the UI |
| --- | --- | --- |
| 1 | Never guess | Missing data stays missing and is labelled: "Not known yet", "No date yet", "No lineup found". No default dates, places or ratings. An empty answer is valid. |
| 2 | Capture beats completeness | Saving never waits on a network call or research. A name alone is enough: "A name is enough. You can add the rest later." |
| 3 | Separate stages, triggered separately | Slow or costly work runs only when asked for, on something already saved. A failed later stage never undoes the first. |
| 4 | Every fact has a source | Each value can show where it came from (you, or a cited source with its quote): "No source stored for this act." |
| 5 | Your word wins | The app suggests, never overwrites. A suggestion applies only on a tap or when it exactly confirms what you typed. The worked-out choice is shown lit with a marker until you pick. |
| 6 | Simple in, structured out | One line of text in. New fields go on the detail view, never on the entry line. |
| 7 | The world and you are separate | Shared facts and your personal log are stored and shown apart. |
| 8 | Spend scarce capacity only where it pays | Costly calls run on an explicit press, and a quota limit parks the job instead of falling back. |
| 9 | No hardcoded knowledge | No lists of real-world names in code. |
| 10 | Delight from small, reliable moments | Understanding a sloppy sentence, a one-tap "Is it one of these?", a running count. Not more screens. |

## Interaction patterns that follow

- **One-tap offers.** Suggestions appear as chips or a short list ("Is it one of these?"). Nothing joins your data without a tap.
- **Missing shown as missing.** A gap is a visible state with a question that fills it ("When was it?", "Who did you see?"), and "All filled in" when there is none.
- **Your word wins.** A field you typed is never replaced. Cleared is a value too ("Not known (cleared)").
- **Reversible acts at once, with Undo.** Removing an act shows a toast "Removed {name}" with Undo. Only irreversible actions get a `Confirm` dialog, and its button names the action, never "OK".
- **Saves as you go.** Fields save 500 ms after the last key and on blur; the status reads "Saving…", "Saved · just now", or "Couldn't save · Try again".
- **State never by colour alone.** Pills, switches, steppers and segmented controls always carry a word, tick or icon.
- **Reduced motion is respected.** Celebrations (confetti, bursts) do not run at all when it is set; the message alone is enough.

## Voice

Warm and inviting, never obsequious or cloying. The app sounds like a friend who was at the show, not a concierge.

Rules:

1. **Talk to the person as "you", about their things as "your".** "Your archive has begun." "Your rating: not rated yet".
2. **Ask, don't instruct, when something is missing.** "What did you go to?", "Did you go?", "Which set was your favourite?".
3. **Plain and specific.** Say what happened and what to do next in one breath: "Add when it was (a year is enough), then look again." "Could not place {cities}. Writing the city as "City, ST" or "City, Country" helps."
4. **Honest about absence.** Say the thing is not there, without apology or blame: "No source listed a lineup. Add the acts you saw below." "Nothing here. Shows you delete appear here for 90 days."
5. **Celebrate earned moments, briefly.** Milestones may use an exclamation mark and a little personality, once: "10 shows in. The best is still ahead." "50 shows. That's a lot of nights out!" "100 artists seen! That's a lineup you built yourself."
6. **Errors say what failed and offer the retry.** "Couldn't save · Try again". "The request did not go through. Try again." No "Oops", no "Sorry", no "Something went wrong".
7. **Name actions by what they do.** "Delete show", "Request access", "Look again", "Add an act you saw". Never "OK" or "Submit".
8. **Short labels, sentence case.** Buttons and pills are a few words. Explanations sit in a `?` popover or a dismissible tip, not on the control.

Avoid: praise for ordinary actions ("Great job!"), exclamation marks outside milestones, apologies, filler ("Just", "Simply"), cute errors, and claims the app cannot back up ("We found everything").

## Direction (not built yet)

Noted for later, not part of the export's rules: remaining inline controls still move onto shared components as their pages are touched. Type roles (`--font-sans`, `--font-display`, `--font-mono`, `--font-poster`) and `--ease-pop` are defined; spacing, shadow, and z-index scales remain Tailwind defaults until a change needs named tokens.
