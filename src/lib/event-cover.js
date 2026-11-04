// Capa da página de inscrição do evento: faixa 4:1 no topo, como no Google
// Forms. O arquivo fica no bucket público event-covers.

export const EVENT_COVER_WIDTH = 1600;
export const EVENT_COVER_HEIGHT = 400;
export const EVENT_COVER_MAX_BYTES = 5 * 1024 * 1024;
export const EVENT_COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function eventCoverUrl(path, supabaseUrl) {
  if (!path || !supabaseUrl) return '';
  return `${String(supabaseUrl).replace(/\/$/, '')}/storage/v1/object/public/event-covers/${path}`;
}

// Tamanho final do arquivo enviado: no máximo 1600 de largura, sem aumentar
// imagem pequena e mantendo a proporção.
export function coverUploadSize(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  const scale = Math.min(1, EVENT_COVER_WIDTH / w);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// Aviso quando a imagem foge muito da proporção 4:1 (as bordas são cortadas)
// ou é pequena demais (fica borrada em tela grande).
export function coverFitNotice(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return '';
  const ratio = w / h;
  if (ratio < 3 || ratio > 5) {
    return `A imagem tem ${w} × ${h} px. Na capa ela é cortada para 4:1 (1600 × 400), então parte de cima e de baixo (ou das laterais) some.`;
  }
  if (w < 1000) {
    return `A imagem tem só ${w} px de largura e pode ficar borrada. O ideal é 1600 × 400 px.`;
  }
  return '';
}
