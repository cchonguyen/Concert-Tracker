import {
  BarChart3,
  Compass,
  FolderCog,
  GalleryHorizontalEnd,
  House,
  Library,
  LucideIcon,
  Map as MapIcon,
  Mic2,
  Table2,
  Ticket,
} from 'lucide-react';
import type { Page, Section } from '../services/nav';

// One icon per page and per section, used the same on Home cards, subtabs and
// the Menu, so a page looks the same wherever you meet it.
export const PAGE_ICON: Record<Page, LucideIcon> = {
  home: House,
  summary: Ticket,
  table: Table2,
  manage: FolderCog,
  timeline: GalleryHorizontalEnd,
  map: MapIcon,
  stats: BarChart3,
  artists: Mic2,
};

export const SECTION_ICON: Record<Section, LucideIcon> = { library: Library, explore: Compass };
