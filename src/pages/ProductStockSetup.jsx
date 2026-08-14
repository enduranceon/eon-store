import { Navigate, useParams } from 'react-router-dom';

export default function ProductStockSetup() {
  const { productId } = useParams();
  return <Navigate to={`/produtos/${productId}?aba=estoque`} replace />;
}
