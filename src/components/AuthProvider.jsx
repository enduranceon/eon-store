import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/api/db';
import { getCoachMe, getCurrentAdmin } from '@/api/client';
import { AuthContext } from '@/contexts/AuthContext';
import { resolveAccountRole } from '@/lib/auth-role';
import { clearPageCache } from '@/lib/page-cache';

const SIGNED_OUT = { user: null, role: null, coach: null };

export function AuthProvider({ children }) {
  const [account, setAccount] = useState(SIGNED_OUT);
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
        setAccount(SIGNED_OUT);
        setLoading(false);
        return;
      }

      // Mesmo usuário já validado: não faz nada (evita re-render em cascata)
      if (verifiedIdRef.current === sessionUserId) {
        if (loading) setLoading(false);
        return;
      }

      // Usuário novo (ou primeira validação): a API valida o JWT e diz se a conta é de
      // administrador ou de coach. Conta sem nenhum dos dois papéis é desconectada.
      const accessToken = session.access_token;
      const result = await resolveAccountRole({
        checkAdmin: () => getCurrentAdmin({ accessToken }),
        checkCoach: () => getCoachMe({ accessToken }),
      });
      if (!active) return;

      if (!result.role) {
        verifiedIdRef.current = null;
        setAccount(SIGNED_OUT);
        if (result.error) console.error('Validação da sessão na API falhou:', result.error);
        await supabase.auth.signOut();
      } else {
        verifiedIdRef.current = sessionUserId;
        setAccount({ user: session.user, role: result.role, coach: result.coach });
      }
      setLoading(false);
    };

    supabase.auth.getSession().then(({ data: { session } }) => validateSession(session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED é puramente um refresh de token; ignora
      if (event === 'TOKEN_REFRESHED') return;
      // INITIAL_SESSION é tratado pelo getSession() acima
      if (event === 'INITIAL_SESSION') return;
      // Troca de senha/dados da própria conta: mesmo usuário, só atualiza o objeto
      // (o aviso de "trocar a senha" depende dos dados da conta).
      if (event === 'USER_UPDATED' && session?.user?.id && verifiedIdRef.current === session.user.id) {
        setAccount(current => (current.user ? { ...current, user: session.user } : current));
        return;
      }
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

  const value = useMemo(
    () => ({ user: account.user, role: account.role, coach: account.coach, loading, signOut }),
    [account, loading, signOut],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
