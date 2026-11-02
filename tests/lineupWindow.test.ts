import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, lineupWindow } from '../src/server/lineup/text.ts';

test('htmlToText strips <nav>, <header>, <footer>, <dialog>, and <svg>', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Festival 2025</title>
        <style>.hidden { display: none; }</style>
        <script>console.log("analytics");</script>
      </head>
      <body>
        <header>
          <h1>Site Banner</h1>
          <a href="/lineup">Header Lineup Link</a>
        </header>
        <nav aria-label="Main Navigation">
          <ul>
            <li><a href="/">Home</a></li>
            <li><a href="/tickets">Tickets Menu</a></li>
            <li><a href="/lineup">Lineup Menu</a></li>
          </ul>
        </nav>
        <main>
          <h2>Official Lineup</h2>
          <svg width="100" height="100">
            <text x="0" y="15">SVG Graphic Text</text>
          </svg>
          <dialog open>
            <p>Cookie Consent Notice</p>
          </dialog>
          <div class="roster">
            <p>Above &amp; Beyond</p>
            <p>Eric Prydz</p>
            <p>Zedd</p>
          </div>
        </main>
        <footer>
          <p>&copy; 2025 Festival Productions. All rights reserved.</p>
          <p><a href="/terms">Terms of Service</a></p>
        </footer>
      </body>
    </html>
  `;

  const text = htmlToText(html);

  // Content from main roster should be present
  assert.match(text, /Official Lineup/);
  assert.match(text, /Above & Beyond/);
  assert.match(text, /Eric Prydz/);
  assert.match(text, /Zedd/);

  // Boilerplate navigation, headers, footers, svg, and dialog must be stripped
  assert.doesNotMatch(text, /Site Banner/);
  assert.doesNotMatch(text, /Header Lineup Link/);
  assert.doesNotMatch(text, /Main Navigation/);
  assert.doesNotMatch(text, /Tickets Menu/);
  assert.doesNotMatch(text, /Lineup Menu/);
  assert.doesNotMatch(text, /SVG Graphic Text/);
  assert.doesNotMatch(text, /Cookie Consent Notice/);
  assert.doesNotMatch(text, /Festival Productions/);
  assert.doesNotMatch(text, /Terms of Service/);
});

test('lineupWindow does not cut off artists at the end of the alphabet on pages with header links', () => {
  // Construct a document where:
  // 1. "Lineup" keyword appears in a navigation header at char 50.
  // 2. Hero copy, ticket tiers, and FAQs span up to char 20,000.
  // 3. A 100-act roster begins at char 20,000 and extends to char 70,000 (alphabetical: A -> Z).
  // 4. Trailing footer text spans from char 70,000 to char 75,000.

  // Exactly place "Lineup" starting at char 50:
  // "01234567890123456789012345678901234567890123456789" = 50 chars prefix
  const prefix = 'Welcome to the portal. Please explore our site... ';
  assert.equal(prefix.length, 50);

  let text = `${prefix}Lineup Navigation Link\n`;

  // Pad out hero copy, tickets, and FAQs until char 20,000
  const faqParagraph = 'General admission and VIP passes are currently available. Check parking rules and camping guidelines for the weekend festival.\n';
  while (text.length < 20000) {
    text += faqParagraph;
  }
  // Trim or adjust to exactly 20,000
  if (text.length > 20000) {
    text = `${text.slice(0, 19999)}\n`;
  }
  assert.equal(text.length, 20000);

  // 100 acts extending from 20,000 to 70,000 (~500 chars per act)
  const rosterStart = text.length;
  for (let i = 0; i < 100; i++) {
    let artistName: string;
    if (i === 0) {
      artistName = 'Above & Beyond';
    } else if (i === 99) {
      artistName = 'Zedd';
    } else {
      const letter = String.fromCharCode(65 + Math.floor((i / 100) * 25));
      artistName = `Artist ${letter}_${i}`;
    }

    // Artist name is a short line (2-40 chars), followed by details lines
    let entry = `${artistName}\nStage: Main Stage\nSet Time: 21:00\n`;
    while (entry.length < 500) {
      entry += 'Exclusive performance featuring live visuals and state of the art sound production.\n';
    }
    // Pad or trim entry to ~500 chars
    if (entry.length > 500) {
      entry = `${entry.slice(0, 499)}\n`;
    }
    text += entry;
  }

  const rosterEnd = text.length;
  assert.equal(rosterStart, 20000);
  assert.equal(rosterEnd, 70000);

  // Footer after char 70,000
  while (text.length < 75000) {
    text += 'Festival copyright and legal disclaimers. All rights reserved across all media platforms worldwide.\n';
  }

  // Verify the old behavior would cut off artists at the end of the alphabet:
  // Old logic anchored at char 50 and took text.slice(0, 55000) or text.slice(0, 60000).
  const oldNaiveWindow55k = text.slice(0, 55000);
  assert.equal(oldNaiveWindow55k.includes('Zedd'), false, 'old window cutting at 55k truncated Zedd');
  const oldNaiveWindow60k = text.slice(0, 60000);
  assert.equal(oldNaiveWindow60k.includes('Zedd'), false, 'old window cutting at 60k truncated Zedd');

  // Verify lineupWindow correctly identifies the dense roster block:
  const window55k = lineupWindow(text, 55000);
  assert.ok(window55k.includes('Zedd'), 'lineupWindow(55k) must not cut off Zedd at the end of the alphabet');
  assert.ok(window55k.includes('Above & Beyond'), 'lineupWindow(55k) must also retain Above & Beyond at the start');

  const window60k = lineupWindow(text, 60000);
  assert.ok(window60k.includes('Zedd'), 'lineupWindow(60k) must not cut off Zedd at the end of the alphabet');
  assert.ok(window60k.includes('Above & Beyond'), 'lineupWindow(60k) must also retain Above & Beyond at the start');
});

test('lineupWindow returns full text when within maxChars budget', () => {
  const shortText = 'Festival Lineup\nArtist A\nArtist B\nArtist C';
  assert.equal(lineupWindow(shortText, 1000), shortText);
});

test('lineupWindow falls back gracefully when no dense roster exists', () => {
  const text = 'Lineup: Special acoustic performance with Bon Iver at the Hollywood Bowl';
  const window = lineupWindow(text, 50);
  assert.match(window, /Lineup/);
  assert.equal(window.length, 50);
});
