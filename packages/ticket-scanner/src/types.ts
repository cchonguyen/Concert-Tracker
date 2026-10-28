// Data contracts for the scanner. Every extracted field carries the quote it
// was read from, so a host can show the user exactly where a value came from.

export interface RawEmailMessage {
  id: string;
  threadId?: string;
  link: string; // e.g. "https://mail.google.com/mail/u/0/#inbox/<id>"
  from: string;
  to?: string;
  subject: string;
  sentAt: string; // ISO-8601 timestamp
  html?: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    dataBase64: string; // used only for .pkpass / .ics in-memory parsing
  }>;
}

export interface FieldEvidence {
  value: string;
  quote: string; // verbatim substring of the email lines or pass fields
  messageId: string;
  messageLink: string;
  readBy: 'layout' | 'schema_org' | 'pkpass' | 'ics' | 'verbatim_heuristic';
}

export interface EmailImportProposal {
  key: string; // "<name>|<startDate>" or "<seller>|<orderNumber>"
  status: 'new' | 'flag' | 'unreadable';
  seller: string;
  orderNumber?: string;
  name?: FieldEvidence;
  date?: FieldEvidence; // YYYY-MM-DD
  endDate?: FieldEvidence;
  venue?: FieldEvidence;
  city?: FieldEvidence;
  region?: FieldEvidence;
  country?: FieldEvidence;
  ticketPrice?: {
    amount: number; // per-ticket USD price (total / count)
    total: number;
    count: number;
    quote: string;
    messageLink: string;
  };
  flags: Array<{
    kind: 'refunded' | 'cancelled' | 'transferred';
    quote: string;
    messageLink: string;
    sentAt: string;
  }>;
  rawSubject?: string; // kept on 'unreadable' rows so the user can find the email
  messageLinks: string[];
}
