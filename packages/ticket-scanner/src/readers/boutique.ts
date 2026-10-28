import { labeledReader } from './labeled.ts';

// Tier 2: boutique and independent sellers. See labeled.ts for how much
// these layouts can be trusted.
export const BOUTIQUE = [
  labeledReader({ seller: 'See Tickets', domains: ['seetickets.us', 'seetickets.com'], order: [/^Your See Tickets order for (.+)$/i, /^Your tickets for (.+)$/i], refund: [/^Refund (?:processed|confirmation) for (.+)$/i] }),
  labeledReader({ seller: 'Shotgun', domains: ['shotgun.live'], order: [/^Your tickets? for (.+)$/i, /^You're going to (.+)$/i], refund: [/^Refund for (.+)$/i] }),
  labeledReader({ seller: 'Posh', domains: ['posh.vip'], order: [/^Your order for (.+)$/i, /^You're going to (.+?)!?$/i] }),
  labeledReader({ seller: 'Etix', domains: ['etix.com'], order: [/^Etix Order Confirmation\s*-\s*(.+)$/i, /^Your Etix tickets for (.+)$/i], refund: [/^Etix Refund\s*-\s*(.+)$/i] }),
  labeledReader({ seller: 'Universe', domains: ['universe.com'], order: [/^Your tickets for (.+)$/i, /^Order confirmed: (.+)$/i] }),
  labeledReader({ seller: 'ShowClix', domains: ['showclix.com'], order: [/^ShowClix Order Confirmation:\s*(.+)$/i, /^Your tickets for (.+)$/i] }),
  labeledReader({ seller: 'Prekindle', domains: ['prekindle.com'], order: [/^Prekindle Order Confirmation\s*-\s*(.+)$/i, /^Your Prekindle tickets for (.+)$/i] }),
  labeledReader({ seller: 'VenuePilot', domains: ['venuepilot.com', 'venuepilot.co'], order: [/^Your tickets for (.+)$/i, /^Order confirmation:\s*(.+)$/i] }),
  labeledReader({ seller: 'Seated', domains: ['seated.com'], order: [/^You're going to (.+?)!?$/i, /^Your tickets for (.+)$/i] }),
  labeledReader({ seller: 'Fever', domains: ['feverup.com'], order: [/^Your tickets for (.+) are ready$/i, /^Booking confirmed:\s*(.+)$/i], cancelled: [/^Your booking for (.+) has been cancelled$/i] }),
];
