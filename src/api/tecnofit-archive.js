import { supabase } from '@/api/db';
import { fetchAllPages } from '@/lib/fetch-all-pages';

// Arquivo do Tecnofit: leitura direta, protegida por RLS (só administradores).

export async function listTecnofitArchivePeople() {
  const { data, error } = await fetchAllPages(() => supabase
    .from('tecnofit_archive_people')
    .select('*')
    .order('full_name', { ascending: true })
    .order('tecnofit_code', { ascending: true }));
  if (error) throw error;
  return data;
}

export async function listTecnofitArchiveReceipts(tecnofitCode) {
  const { data, error } = await fetchAllPages(() => supabase
    .from('tecnofit_archive_receipts')
    .select('receipt_number, kind, item_name, period_start, period_end, amount, payment_method, issued_at, origin, consultant, responsible, source_report')
    .eq('tecnofit_code', tecnofitCode)
    .order('issued_at', { ascending: true })
    .order('receipt_number', { ascending: true }));
  if (error) throw error;
  return data;
}
