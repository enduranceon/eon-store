import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import TopBar from '@/components/layout/TopBar';
import Dashboard from '@/pages/Dashboard';
import Campaigns from '@/pages/Campaigns';
import CampaignDetail from '@/pages/CampaignDetail';
import Products from '@/pages/Products';
import ProductForm from '@/pages/ProductForm';
import Orders from '@/pages/Orders';
import OrderDetail from '@/pages/OrderDetail';
import Customers from '@/pages/Customers';
import CustomerDetail from '@/pages/CustomerDetail';
import Reports from '@/pages/Reports';
import Suppliers from '@/pages/Suppliers';
import SupplierForm from '@/pages/SupplierForm';
import Categories from '@/pages/Categories';
import Trainers from '@/pages/Trainers';
import { seedTrainers } from '@/api/entities';
import PublicCheckout from '@/pages/PublicCheckout';
import PublicOrderConfirmation from '@/pages/PublicOrderConfirmation';
import PublicHome from '@/pages/PublicHome';
import Migrate from '@/pages/Migrate';
import CampaignReport from '@/pages/CampaignReport';
import Login from '@/pages/Login';
import StockProducts from '@/pages/StockProducts';
import StockProductForm from '@/pages/StockProductForm';
import StockOrders from '@/pages/StockOrders';
import StockOrderDetail from '@/pages/StockOrderDetail';
import PublicStore from '@/pages/PublicStore';
import PublicStoreConfirmation from '@/pages/PublicStoreConfirmation';

function AdminLayout({ children }) {
  const { user, loading, signOut } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} onSignOut={signOut} />
      <div className="flex-1 flex flex-col min-w-0 lg:ml-64">
        <TopBar onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  useEffect(() => { seedTrainers(); }, []);

  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" richColors />
        <Routes>
          {/* Públicas */}
          <Route path="/" element={<PublicHome />} />
          <Route path="/checkout/:campaignId" element={<PublicCheckout />} />
          <Route path="/confirmacao/:orderId" element={<PublicOrderConfirmation />} />
          <Route path="/loja" element={<PublicStore />} />
          <Route path="/loja/confirmacao/:orderId" element={<PublicStoreConfirmation />} />

          {/* Admin */}
          <Route path="/login" element={<Login />} />
          <Route path="/migrar" element={<AdminLayout><Migrate /></AdminLayout>} />
          <Route path="/admin" element={<AdminLayout><Dashboard /></AdminLayout>} />
          <Route path="/campanhas" element={<AdminLayout><Campaigns /></AdminLayout>} />
          <Route path="/campanhas/:id" element={<AdminLayout><CampaignDetail /></AdminLayout>} />
          <Route path="/campanhas/:id/relatorio" element={<AdminLayout><CampaignReport /></AdminLayout>} />
          <Route path="/produtos" element={<AdminLayout><Products /></AdminLayout>} />
          <Route path="/produtos/novo" element={<AdminLayout><ProductForm /></AdminLayout>} />
          <Route path="/produtos/:id" element={<AdminLayout><ProductForm /></AdminLayout>} />
          <Route path="/pedidos" element={<AdminLayout><Orders /></AdminLayout>} />
          <Route path="/pedidos/:id" element={<AdminLayout><OrderDetail /></AdminLayout>} />
          <Route path="/clientes" element={<AdminLayout><Customers /></AdminLayout>} />
          <Route path="/clientes/:id" element={<AdminLayout><CustomerDetail /></AdminLayout>} />
          <Route path="/categorias" element={<AdminLayout><Categories /></AdminLayout>} />
          <Route path="/treinadores" element={<AdminLayout><Trainers /></AdminLayout>} />
          <Route path="/fornecedores" element={<AdminLayout><Suppliers /></AdminLayout>} />
          <Route path="/fornecedores/novo" element={<AdminLayout><SupplierForm /></AdminLayout>} />
          <Route path="/fornecedores/:id" element={<AdminLayout><SupplierForm /></AdminLayout>} />
          <Route path="/relatorios" element={<AdminLayout><Reports /></AdminLayout>} />
          <Route path="/estoque" element={<AdminLayout><StockProducts /></AdminLayout>} />
          <Route path="/estoque/novo" element={<AdminLayout><StockProductForm /></AdminLayout>} />
          <Route path="/estoque/pedidos" element={<AdminLayout><StockOrders /></AdminLayout>} />
          <Route path="/estoque/pedidos/:id" element={<AdminLayout><StockOrderDetail /></AdminLayout>} />
          <Route path="/estoque/:id" element={<AdminLayout><StockProductForm /></AdminLayout>} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
