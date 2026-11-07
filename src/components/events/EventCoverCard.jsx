import { useRef, useState } from 'react';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import ConfirmDialog from '@/components/ConfirmDialog';
import { removeEventCover, uploadEventCover } from '@/api/client';
import {
  EVENT_COVER_HEIGHT,
  EVENT_COVER_MAX_BYTES,
  EVENT_COVER_TYPES,
  EVENT_COVER_WIDTH,
  coverFitNotice,
  coverUploadSize,
  eventCoverUrl,
} from '@/lib/event-cover';

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível abrir a imagem')); };
    img.src = url;
  });
}

// Reduz para no máximo 1600 de largura e grava em JPEG, para a página pública
// carregar rápido mesmo quando a foto original é enorme.
async function prepareCover(file) {
  const img = await loadImage(file);
  const size = coverUploadSize(img.naturalWidth, img.naturalHeight);
  if (!size) throw new Error('Imagem inválida');
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(img, 0, 0, size.width, size.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new Error('Não foi possível preparar a imagem');
  return {
    file: new File([blob], 'capa.jpg', { type: 'image/jpeg' }),
    notice: coverFitNotice(img.naturalWidth, img.naturalHeight),
  };
}

export default function EventCoverCard({ event, onChanged }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const coverUrl = eventCoverUrl(event.cover_image_path, import.meta.env.VITE_SUPABASE_URL);

  const send = async (picked) => {
    if (!picked) return;
    if (!EVENT_COVER_TYPES.includes(picked.type)) {
      toast.error('Envie uma imagem JPG, PNG ou WEBP');
      return;
    }
    setBusy(true);
    try {
      const { file, notice } = await prepareCover(picked);
      if (file.size > EVENT_COVER_MAX_BYTES) throw new Error('A imagem passou de 5 MB mesmo depois de reduzida');
      await uploadEventCover(event.id, file);
      toast.success('Capa salva. Ela já aparece na página de inscrição.');
      if (notice) toast.warning(notice, { duration: 8000 });
      await onChanged?.();
    } catch (error) {
      toast.error(error.message || 'Não foi possível salvar a capa');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeEventCover(event.id);
      toast.success('Capa removida.');
      setRemoving(false);
      await onChanged?.();
    } catch (error) {
      toast.error(error.message || 'Não foi possível remover a capa');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold inline-flex items-center gap-1.5">
              <ImageIcon className="w-4 h-4" /> Capa da página de inscrição
            </p>
            <p className="text-xs text-muted-foreground">
              Tamanho ideal: <b>{EVENT_COVER_WIDTH} × {EVENT_COVER_HEIGHT} px</b> (proporção 4:1), JPG, PNG ou WEBP.
              Imagem em outra proporção é cortada nas bordas.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {coverUrl && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setRemoving(true)}>
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Remover
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Upload className="w-3.5 h-3.5 mr-1" /> {busy ? 'Enviando...' : coverUrl ? 'Trocar capa' : 'Enviar capa'}
            </Button>
          </div>
        </div>

        {coverUrl ? (
          <div className="aspect-[4/1] rounded-lg overflow-hidden border bg-gray-100">
            <img src={coverUrl} alt={`Capa de ${event.name}`} className="w-full h-full object-cover" />
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="w-full aspect-[4/1] rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50 transition-colors flex flex-col items-center justify-center gap-1 text-sm text-muted-foreground"
          >
            <ImageIcon className="w-6 h-6 text-gray-400" />
            Sem capa. Clique para enviar ({EVENT_COVER_WIDTH} × {EVENT_COVER_HEIGHT} px)
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={EVENT_COVER_TYPES.join(',')}
          className="hidden"
          onChange={e => { const [file] = e.target.files || []; e.target.value = ''; send(file); }}
        />
      </CardContent>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remover capa"
        icon={Trash2}
        iconClassName="text-red-600"
        confirmLabel="Remover"
        busy={busy}
        onConfirm={remove}
      >
        <p>A página de inscrição volta a abrir só com o nome do evento no topo.</p>
      </ConfirmDialog>
    </Card>
  );
}
