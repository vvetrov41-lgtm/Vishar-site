// Central usability scope for artist-owned CRM records.
// RLS remains the security boundary; options come only from the database RPC.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { useSession } from './session';
import type { Artist } from './types';

export const ARTIST_SCOPE_STORAGE_KEY = 'vishar-crm-artist-scope';

interface ArtistScopeValue {
  artists: Artist[];
  selectedArtistId: string | null;
  loading: boolean;
  error: boolean;
  setSelectedArtistId: (artistId: string | null) => void;
}
const ArtistScopeContext = createContext<ArtistScopeValue | null>(null);

function readPersisted(): string | null {
  try { return window.localStorage.getItem(ARTIST_SCOPE_STORAGE_KEY); }
  catch { return null; }
}
function persist(value: string | null) {
  try {
    if (value) window.localStorage.setItem(ARTIST_SCOPE_STORAGE_KEY, value);
    else window.localStorage.removeItem(ARTIST_SCOPE_STORAGE_KEY);
  } catch { /* The in-memory selection still works. */ }
}

export function ArtistScopeProvider({children}:{children:ReactNode}) {
  const {state,api}=useSession();
  const [artists,setArtists]=useState<Artist[]>([]);
  const [selectedArtistId,setSelected]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(false);

  useEffect(()=>{
    let cancelled=false;
    if(state!=='active'||!api){
      setArtists([]);setSelected(null);setLoading(false);setError(false);
      return ()=>{cancelled=true;};
    }
    setLoading(true);setError(false);
    void api.listAccessibleArtists().then(accessible=>{
      if(cancelled)return;
      const active=accessible.filter(artist=>artist.is_active);
      setArtists(active);
      const persisted=readPersisted();
      if(persisted&&active.some(artist=>artist.id===persisted))setSelected(persisted);
      else { setSelected(null); persist(null); }
    }).catch(()=>{
      if(cancelled)return;
      setArtists([]);setSelected(null);persist(null);setError(true);
    }).finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[state,api]);

  const setSelectedArtistId=useCallback((artistId:string|null)=>{
    const valid=artistId===null||artists.some(artist=>artist.id===artistId);
    const next=valid?artistId:null;
    setSelected(next);persist(next);
  },[artists]);

  const value=useMemo(()=>({artists,selectedArtistId,loading,error,setSelectedArtistId}),
    [artists,selectedArtistId,loading,error,setSelectedArtistId]);
  return <ArtistScopeContext.Provider value={value}>{children}</ArtistScopeContext.Provider>;
}
export function useArtistScope(): ArtistScopeValue {
  const value=useContext(ArtistScopeContext);
  if(!value)throw new Error('useArtistScope must be used inside ArtistScopeProvider');
  return value;
}
