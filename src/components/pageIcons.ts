import {
  BarChart3,
  CalendarDays,
  Compass,
  FolderCog,
  Grid3x3,
  House,
  Library,
  History,
  ListOrdered,
  LucideIcon,
  Map as MapIcon,
  Mic2,
  Share2,
  Table2,
  Ticket,
  Waves,
} from 'lucide-react';
import type { Page, Section } from '../services/nav';

// One icon per page and per section, used the same on Home cards, subtabs and
// the Menu, so a page looks the same wherever you meet it.
export const PAGE_ICON: Record<Page, LucideIcon> = {
  home: House,
  summary: Ticket,
  table: Table2,
  manage: FolderCog,
  log: History,
  share: Share2,
  agenda: ListOrdered,
  month: CalendarDays,
  heatmap: Grid3x3,
  river: Waves,
  map: MapIcon,
  stats: BarChart3,
  ranking: Mic2,
};

export const SECTION_ICON: Record<Section, LucideIcon> = { library: Library, explore: Compass };
