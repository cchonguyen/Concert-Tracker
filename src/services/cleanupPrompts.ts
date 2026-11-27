// Copy-pasteable AI agent prompts for preparing the Phase 1 artist entity cleanup CSV
// and the Phase 2 artist genres CSV.

export const ARTIST_CLEANUP_AI_PROMPT = `I am exporting an artist list CSV (\`artists-and-genres-*.csv\`) from LiveArchive with columns:
\`Artist,MusicBrainz ID,Source,Version (leave as it is)\` (ignore any genre columns).

Analyze every row and output a concentrated CSV containing **only** the rows that need entity cleanup (omit valid standalone artists). Use UTF-8 and CRLF line endings with these exact 15 columns:
\`Artist,MusicBrainz ID,Source,Version (leave as it is),Entity_Status,Invalid_Reason,Canonical_Artist,Canonical_Key,Set_Qualifier,Split_Artists,Split_Keys,Combo_Alias,Alter_Ego_Of,Alter_Ego_Of_Key,Cleanup_Notes\`

### Rules
1. **Preserve exact source identity:** Copy \`Artist\`, \`MusicBrainz ID\`, \`Source\`, and \`Version (leave as it is)\` verbatim (including non-breaking spaces \`\\xa0\`, punctuation, and casing).
2. **Pre-sorted execution order:** Sort output rows by \`Entity_Status\` in this exact order:
   1. \`invalid_non_artist\`
   2. \`merge_duplicate\`
   3. \`remap_set\`
   4. \`split_multi_artist\`
   5. \`rename\`
   6. \`link_alter_ego\`
3. **Key format (\`Canonical_Key\`, \`Split_Keys\`, \`Alter_Ego_Of_Key\`):**
   - \`mbid:<uuid>\` when the target artist has a \`MusicBrainz ID\` in the export.
   - \`artist:<Exact Original Artist>\` when the target exists in the export without an MBID (always reference the **pre-rename** \`Artist\` string if that target is also renamed in the same batch).
   - \`NEW\` when no standalone row exists in the export yet.
4. **Handlers by \`Entity_Status\`:**
   - \`invalid_non_artist\`: Non-music entries (silent disco channels, yoga/wellness, panels/talks, cooking demos, campground games, placeholders like "Secret Guest"/"TBA", truncated scrapes). Set \`Invalid_Reason\` (e.g. \`silent_disco_channel\`, \`panel_talk\`, \`campground_activity\`, \`yoga_wellness\`, \`placeholder\`, \`truncated_scrape\`, \`cooking_demo\`).
   - \`merge_duplicate\`: Typos, abbreviations, diacritic/punctuation variants, or duplicate rows of an existing artist. Set \`Canonical_Artist\` and \`Canonical_Key\`.
   - \`remap_set\`: Entries like \`Artist (DJ Set)\`, \`Artist (Live)\`, \`Artist presents Show\`, \`Artist w/ MC ...\`, \`Artist & Friends\`. Set \`Canonical_Artist\`, \`Canonical_Key\`, and \`Set_Qualifier\` (e.g. \`DJ Set\`, \`Live\`, \`HOLO\`, \`Redux\`, \`w/ MC Dino\`).
   - \`split_multi_artist\`: B2B / B3B / \`x\` / \`+\` / \`&\` / \`/\` multi-artist billings. Set \`Split_Artists\` (\`; \`-separated) and parallel \`Split_Keys\` (\`; \`-separated, matching position-for-position). If it has a recognized project/B2B moniker (e.g. \`Kx5\`, \`Worship\`, \`Dog Blood\`), put it in \`Combo_Alias\` (never delete standalone artists matching a \`Combo_Alias\`). Put any stripped set label in \`Set_Qualifier\`.
   - \`rename\`: Clean up formatting (e.g. Clashfinder brackets \`[Artist]\`, \`*[Artist]*\`) or fix a typo in place. Set \`Canonical_Artist\` and \`Canonical_Key\`. Optionally also set \`Set_Qualifier\` or \`Alter_Ego_Of\` + \`Alter_Ego_Of_Key\`.
   - \`link_alter_ego\`: Solo side-projects/aliases kept as distinct artists (e.g. \`TESTPILOT\` -> \`Deadmau5\`, \`Cirez D\` -> \`Eric Prydz\`). Set \`Alter_Ego_Of\` and \`Alter_Ego_Of_Key\`.`;

export const GENRES_CSV_AI_PROMPT = `I am uploading an \`artists-and-genres-*.csv\` file exported from LiveArchive with these exact 6 columns:
\`Artist,MusicBrainz ID,Current genres,Source,New genres,Version (leave as it is)\`

Update the CSV with genre tags in the \`New genres\` column and return the updated CSV (UTF-8, CRLF line endings).

### Rules
1. **Never modify** \`Artist\`, \`MusicBrainz ID\`, \`Current genres\`, \`Source\`, or \`Version (leave as it is)\`.
2. **Which rows to fill:** Only populate \`New genres\` for rows where \`Source\` is \`none\` (leave already-tagged rows blank in \`New genres\` so they are left untouched, unless I explicitly asked to overwrite them).
3. **Formatting for \`New genres\`:**
   - Separate multiple genres with \`; \` (semicolon + space), ordered most-primary genre first (e.g. \`Melodic Dubstep; Future Bass; Electronic\`).
   - Maximum **10** genres per artist; each genre at most **60** characters.
   - Use clean, canonical genre spellings (consistent casing and punctuation; avoid duplicates or redundant variations).
4. **Accuracy:** If you are not confident about an artist's genres (e.g. an obscure local opener or ambiguous name), leave \`New genres\` **blank**—never guess or invent genres.`;
