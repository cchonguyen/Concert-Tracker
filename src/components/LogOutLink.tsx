import React from 'react';
import { LogOut } from 'lucide-react';

// Cloudflare Access clears its sign-in cookie for this site at this address.
export const LOGOUT_HREF = '/cdn-cgi/access/logout';

// The one log out button, used in the Menu and the account panel alike.
export const LogOutLink: React.FC<{ className: string }> = ({ className }) => (
  <a className={className} href={LOGOUT_HREF}>
    <LogOut className="h-3.5 w-3.5" /> Log out
  </a>
);
