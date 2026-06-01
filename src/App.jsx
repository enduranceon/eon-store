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
import Financial from '@/pages/Financial';
import Returns from '@/pages/Returns';
import Today from '@/pages/Today';
import Coupons from '@/pages/Coupons';
import CouponForm from '@/pages/CouponForm';
import RevenueCenters from '@/pages/RevenueCenters';
import PaymentMethodsConfig from '@/pages/PaymentMethodsConfig';
import StockOrderNewAdmin from '@/pages/StockOrderNewAdmin';
import PublicOrderTracking from '@/pages/PublicOrderTracking';

// Assessoria
import AssConfiguracoes from '@/pages/assessment/Configuracoes';
import AssPlanos from '@/pages/assessment/Planos';
import AssCoaches from '@/pages/assessment/Coaches';
import AssStudents from '@/pages/assessment/Students';
import AssStudentDetail from '@/pages/assessment/StudentDetail';
import AssContracts from '@/pages/assessment/Contracts';
import AssContractForm from '@/pages/assessment/ContractForm';
import AssContractDetail from '@/pages/assessment/ContractDetail';
import AssMonthlyClosing from '@/pages/assessment/MonthlyClosing';
import AssClosingDetail from '@/pages/assessment/ClosingDetail';
import AssPainel from '@/pages/assessment/Painel';
import AssRegua from '@/pages/assessment/Regua';
import AssRenewals from '@/pages/assessment/Renewals';

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
          <Route path="/p/:orderId" element={<PublicOrderTracking />} />

          {/* Admin */}
          <Route path="/login" element={<Login />} />
          <Route path="/migrar" element={<AdminLayout><Migrate /></AdminLayout>} />
          <Route path="/admin" element={<AdminLayout><Dashboard /></AdminLayout>} />
          <Route path="/hoje" element={<AdminLayout><Today /></AdminLayout>} />
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
          <Route path="/financeiro" element={<AdminLayout><Financial /></AdminLayout>} />
          <Route path="/devolucoes" element={<AdminLayout><Returns /></AdminLayout>} />
          <Route path="/cupons" element={<AdminLayout><Coupons /></AdminLayout>} />
          <Route path="/cupons/novo" element={<AdminLayout><CouponForm /></AdminLayout>} />
          <Route path="/cupons/:id" element={<AdminLayout><CouponForm /></AdminLayout>} />
          <Route path="/centros-receita" element={<AdminLayout><RevenueCenters /></AdminLayout>} />
          <Route path="/configuracoes/pagamento" element={<AdminLayout><PaymentMethodsConfig /></AdminLayout>} />

          {/* Assessoria */}
          <Route path="/assessoria"               element={<AdminLayout><AssPainel /></AdminLayout>} />
          <Route path="/assessoria/planos"        element={<AdminLayout><AssPlanos /></AdminLayout>} />
          <Route path="/assessoria/regua"         element={<AdminLayout><AssRegua /></AdminLayout>} />
          <Route path="/assessoria/configuracoes" element={<AdminLayout><AssConfiguracoes /></AdminLayout>} />
          <Route path="/assessoria/coaches"       element={<AdminLayout><AssCoaches /></AdminLayout>} />
          <Route path="/assessoria/alunos"        element={<AdminLayout><AssStudents /></AdminLayout>} />
          <Route path="/assessoria/alunos/:id"    element={<AdminLayout><AssStudentDetail /></AdminLayout>} />
          <Route path="/assessoria/contratos"     element={<AdminLayout><AssContracts /></AdminLayout>} />
          <Route path="/assessoria/contratos/novo" element={<AdminLayout><AssContractForm /></AdminLayout>} />
          <Route path="/assessoria/contratos/:id" element={<AdminLayout><AssContractDetail /></AdminLayout>} />
          <Route path="/assessoria/renovacoes"    element={<AdminLayout><AssRenewals /></AdminLayout>} />
          <Route path="/assessoria/fechamento"     element={<AdminLayout><AssMonthlyClosing /></AdminLayout>} />
          <Route path="/assessoria/fechamento/:id" element={<AdminLayout><AssClosingDetail /></AdminLayout>} />
          <Route path="/estoque" element={<AdminLayout><StockProducts /></AdminLayout>} />
          <Route path="/estoque/novo" element={<AdminLayout><StockProductForm /></AdminLayout>} />
          <Route path="/estoque/pedidos" element={<AdminLayout><StockOrders /></AdminLayout>} />
          <Route path="/estoque/pedidos/novo" element={<AdminLayout><StockOrderNewAdmin /></AdminLayout>} />
          <Route path="/estoque/pedidos/:id" element={<AdminLayout><StockOrderDetail /></AdminLayout>} />
          <Route path="/estoque/:id" element={<AdminLayout><StockProductForm /></AdminLayout>} />
          <Route path="*" element={<Navigate to="/hoje" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
