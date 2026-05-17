import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Package, ShoppingCart, Users, BarChart3,
  Megaphone, Store, X, Truck, Tag, UserCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const menu = [
  { label: 'Dashboard',    icon: LayoutDashboard, to: '/',             exact: true },
  { label: 'Campanhas',    icon: Megaphone,        to: '/campanhas' },
  { label: 'Produtos',     icon: Package,          to: '/produtos' },
  { label: 'Categorias',   icon: Tag,              to: '/categorias' },
  { label: 'Treinadores',  icon: UserCheck,        to: '/treinadores' },
  { label: 'Fornecedores', icon: Truck,            to: '/fornecedores' },
  { label: 'Pedidos',      icon: ShoppingCart,     to: '/pedidos' },
  { label: 'Clientes',     icon: Users,            to: '/clientes' },
  { label: 'Relatórios',   icon: BarChart3,        to: '/relatorios' },
];

export default function Sidebar({ open, onClose }) {
  const location = useLocation();

  const isActive = (to, exact) => {
    if (exact) return location.pathname === to;
    return location.pathname.startsWith(to);
  };

  return (
    <>
      {/* Overlay mobile */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'fixed left-0 top-0 z-40 h-full w-64 bg-slate-900 text-white flex flex-col transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
              <Store className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">EON Store</span>
          </div>
          <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {menu.map((item) => {
            const active = isActive(item.to, item.exact);
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onClose}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium mb-1 transition-colors',
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700">
          <p className="text-xs text-slate-500">EON Store v1.0</p>
          <p className="text-xs text-slate-600">Pré-venda & Controle financeiro</p>
        </div>
      </aside>
    </>
  );
}
