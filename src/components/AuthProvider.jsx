import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/api/db';
import { AuthContext } from '@/contexts/AuthContext';
import { clearPageCache } from '@/lib/page-cache';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Guarda o id já verificado — evita revalidar RPC e re-setar `user`
  // (que dispararia re-render em cascata) quando Supabase re-emite SIGNED_IN
  // ao recuperar foco da aba ou refrescar token.
  const verifiedIdRef = useRef(null);

  useEffect(() => {
    let active = true;

    const validateSession = async (session) => {
      if (!active) return;

      const sessionUserId = session?.user?.id || null;

      if (!sessionUserId) {
        clearPageCache();
        verifiedIdRef.current = null;
        setUser(null);
        setLoading(false);
        return;
      }

      // Mesmo usuário já validado: não faz nada (evita re-render em cascata)
      if (verifiedIdRef.current === sessionUserId) {
        if (loading) setLoading(false);
        return;
      }

      // Usuário novo (ou primeira validação): faz checagem de admin
      const { data: isAdmin, error } = await supabase.rpc('is_app_admin');
      if (!active) return;

      if (error || !isAdmin) {
        verifiedIdRef.current = null;
        setUser(null);
        if (error) console.error('is_app_admin falhou:', error);
        else await supabase.auth.signOut();
      } else {
        verifiedIdRef.current = sessionUserId;
        setUser(session.user);
      }
      setLoading(false);
    };

    supabase.auth.getSession().then(({ data: { session } }) => validateSession(session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED é puramente um refresh de token; ignora
      if (event === 'TOKEN_REFRESHED') return;
      // INITIAL_SESSION é tratado pelo getSession() acima
      if (event === 'INITIAL_SESSION') return;
      setTimeout(() => validateSession(session), 0);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = useCallback(() => {
    clearPageCache();
    verifiedIdRef.current = null;
    return supabase.auth.signOut();
  }, []);

  const value = useMemo(() => ({ user, loading, signOut }), [user, loading, signOut]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
