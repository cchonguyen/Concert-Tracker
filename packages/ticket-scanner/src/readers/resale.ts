import { labeledReader } from './labeled.ts';

// Tier 3: resale marketplaces. A sale ("Your tickets sold") marks tickets
// you will not use; a purchase is an order like any other. See labeled.ts
// for how much these layouts can be trusted.
export const RESALE = [
  labeledReader({ seller: 'StubHub', domains: ['stubhub.com'], order: [/^Your StubHub order for (.+)$/i, /^You got tickets to (.+)$/i], transferredAway: [/^Your tickets (?:to|for) (.+) sold!?$/i] }),
  labeledReader({ seller: 'SeatGeek', domains: ['seatgeek.com'], order: [/^Your SeatGeek order: (.+)$/i, /^You're going to (.+?)!?$/i], transferredAway: [/^Your tickets to (.+) sold$/i] }),
  labeledReader({ seller: 'Vivid Seats', domains: ['vividseats.com'], order: [/^Vivid Seats Order Confirmation\s*-\s*(.+)$/i, /^Your order for (.+)$/i] }),
  labeledReader({ seller: 'TickPick', domains: ['tickpick.com'], order: [/^TickPick Order Confirmation:\s*(.+)$/i, /^Your TickPick tickets for (.+)$/i] }),
  labeledReader({ seller: 'Cash or Trade', domains: ['cashortrade.org'], order: [/^Cash or Trade:\s*You got tickets to (.+)$/i, /^Your tickets for (.+)$/i], transferredAway: [/^Cash or Trade:\s*Your tickets to (.+) sold$/i] }),
];
