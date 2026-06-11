import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/api/db';
import { AuthContext } from '@/contexts/AuthContext';
import { clearPageCache } from '@/lib/page-cache';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const verifiedRef = useRef(false);

  useEffect(() => {
    let active = true;

    const validateSession = async (session) => {
      if (!active) return;
      if (!session?.user) {
        clearPageCache();
        setUser(null);
        verifiedRef.current = false;
        setLoading(false);
        return;
      }

      // Só mostra spinner na primeira carga; re-validações (troca de aba,
      // token refresh) acontecem silenciosamente sem desmontar a página
      if (!verifiedRef.current) setLoading(true);

      const { data: isAdmin, error } = await supabase.rpc('is_app_admin');
      if (!active) return;

      if (error || !isAdmin) {
        setUser(null);
        verifiedRef.current = false;
        await supabase.auth.signOut();
      } else {
        setUser(session.user);
        verifiedRef.current = true;
      }
      if (active) setLoading(false);
    };

    supabase.auth.getSession().then(({ data: { session } }) => validateSession(session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => validateSession(session), 0);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = () => {
    clearPageCache();
    return supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
