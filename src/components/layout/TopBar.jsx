import { Menu, Store } from 'lucide-react';
import { useLocation } from 'react-router-dom';

const titles = {
  '/': 'Dashboard',
  '/campanhas': 'Campanhas',
  '/produtos': 'Produtos',
  '/pedidos': 'Pedidos',
  '/clientes': 'Clientes',
  '/relatorios': 'Relatórios',
};

function getTitle(pathname) {
  if (pathname.startsWith('/campanhas/')) return 'Detalhe da Campanha';
  if (pathname.startsWith('/produtos/')) return 'Produto';
  if (pathname.startsWith('/pedidos/')) return 'Pedido';
  if (pathname.startsWith('/clientes/')) return 'Cliente';
  return titles[pathname] ?? 'EON Store';
}

export default function TopBar({ onMenuClick }) {
  const location = useLocation();
  const title = getTitle(location.pathname);

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-4 gap-4 sticky top-0 z-20">
      <button
        onClick={onMenuClick}
        className="lg:hidden p-2 rounded-md hover:bg-gray-100 text-gray-600"
      >
        <Menu className="w-5 h-5" />
      </button>
      <h1 className="text-base font-semibold text-gray-800">{title}</h1>
    </header>
  );
}
