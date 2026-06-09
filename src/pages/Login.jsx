import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Store, Eye, EyeOff } from 'lucide-react';
import { supabase } from '@/api/db';
import { toast } from 'sonner';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return toast.error('Preencha e-mail e senha');

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      return toast.error('E-mail ou senha incorretos');
    }

    const { data: isAdmin, error: accessError } = await supabase.rpc('is_app_admin');
    if (accessError || !isAdmin) {
      await supabase.auth.signOut();
      setLoading(false);
      return toast.error('Esta conta não tem acesso ao painel');
    }

    setLoading(false);
    navigate('/hoje');
  };

  return (
    <div className="min-h-screen bg-[#1a1a2e] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-blue-500 rounded-xl flex items-center justify-center mx-auto mb-3">
            <Store className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">EON Store</h1>
          <p className="text-sm text-slate-400 mt-1">Painel administrativo</p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-xl">
          <h2 className="font-bold text-gray-900 text-lg mb-4">Entrar</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">E-mail</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="seu@email.com"
                className="mt-1.5 w-full h-11 rounded-xl border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Senha</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="mt-1.5 w-full h-11 rounded-xl border border-gray-200 px-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 translate-y-[-35%] text-gray-400 hover:text-gray-600"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl font-semibold text-sm transition-colors"
            >
              {loading ? 'Carregando...' : 'Entrar'}
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
