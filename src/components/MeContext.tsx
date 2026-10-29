import React, { createContext, useContext } from 'react';

// Who is signed in, from GET /api/me. Single-owner installs always answer
// "owner". Members do not see what the server would refuse them (Manage,
// Sheets, genres, server Gmail); see ARCHITECTURE.md ("Multi-user").
export interface Me {
  multiUser: boolean;
  role: 'owner' | 'member';
  email: string | null;
}

const MeContext = createContext<Me>({ multiUser: false, role: 'owner', email: null });

export const MeProvider: React.FC<{ me: Me; children: React.ReactNode }> = ({ me, children }) => <MeContext.Provider value={me}>{children}</MeContext.Provider>;
export const useMe = () => useContext(MeContext);
export const useIsOwner = () => useContext(MeContext).role === 'owner';
