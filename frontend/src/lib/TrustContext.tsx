import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchState, type TrustState } from './trust';

interface TrustContextValue {
  mode: 'demo' | 'live'; setMode: (mode: 'demo' | 'live') => void;
  state: TrustState | null; loading: boolean; error: string | null;
  updated: string | null; refresh: () => void;
}
const TrustContext = createContext<TrustContextValue | null>(null);

export function TrustProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [state, setState] = useState<TrustState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const serial = useRef(0);
  const refresh = useCallback(() => setRevision(r => r + 1), []);

  useEffect(() => {
    const sequence = ++serial.current;
    setState(null); setUpdated(null); setError(null); setLoading(false);
    if (mode !== 'live') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController;
    async function poll() {
      request = new AbortController();
      setLoading(true);
      const timeout = setTimeout(() => request.abort(), 8000);
      try {
        const next = await fetchState(request.signal);
        if (!stopped && sequence === serial.current) { setState(next); setError(null); setUpdated(new Date().toLocaleTimeString()); }
      } catch (e) {
        if (!stopped && sequence === serial.current) {
          // Never retain an apparently live measurement after a failed refresh.
          setState(null);
          setError(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Trust-layer request timed out.');
        }
      } finally {
        clearTimeout(timeout);
        if (!stopped) { setLoading(false); timer = setTimeout(poll, 5000); }
      }
    }
    void poll();
    return () => { stopped = true; request?.abort(); clearTimeout(timer); };
  }, [mode, revision]);

  return <TrustContext.Provider value={{ mode, setMode, state, loading, error, updated, refresh }}>{children}</TrustContext.Provider>;
}
export function useTrust() {
  const value = useContext(TrustContext);
  if (!value) throw new Error('TrustProvider is required');
  return value;
}
