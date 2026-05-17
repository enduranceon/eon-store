import { useRef, useState } from 'react';
import { Upload, Star, X, ChevronLeft, ChevronRight, ImageIcon, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

const MAX_PHOTOS = 3;

/**
 * Galeria de até 3 fotos com:
 * - Preview quadrado (como aparece no site)
 * - Estrela na foto principal (primeira)
 * - Arrastar para reordenar via botões ‹ ›
 * - Remover foto individual
 *
 * Props:
 *   value: string[]  (array de base64)
 *   onChange: (string[]) => void
 */
export default function ImageUpload({ value = [], onChange }) {
  const inputRef = useRef(null);
  const [draggingOver, setDraggingOver] = useState(false);
  const [preview, setPreview] = useState(null); // índice em preview ampliado

  const images = Array.isArray(value) ? value : (value ? [value] : []);

  const addFile = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    if (images.length >= MAX_PHOTOS) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 800;
        let { width, height } = img;
        if (width > height) {
          if (width > MAX) { height = Math.round(height * MAX / width); width = MAX; }
        } else {
          if (height > MAX) { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', 0.75);
        onChange([...images, compressed]);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleInputChange = (e) => {
    Array.from(e.target.files).forEach(addFile);
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDraggingOver(false);
    Array.from(e.dataTransfer.files).forEach(addFile);
  };

  const remove = (i) => onChange(images.filter((_, idx) => idx !== i));

  // Move para a esquerda = sobe na ordem (fica mais principal)
  const moveLeft = (i) => {
    if (i === 0) return;
    const arr = [...images];
    [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    onChange(arr);
  };

  const moveRight = (i) => {
    if (i === images.length - 1) return;
    const arr = [...images];
    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    onChange(arr);
  };

  // Torna principal (move para índice 0)
  const makePrimary = (i) => {
    if (i === 0) return;
    const arr = [...images];
    const [item] = arr.splice(i, 1);
    arr.unshift(item);
    onChange(arr);
  };

  return (
    <div className="space-y-3">
      {/* Grade de fotos */}
      {images.length > 0 && (
        <div className="flex gap-3">
          {images.map((img, i) => (
            <div key={i} className="relative group flex-1">
              {/* Foto quadrada */}
              <div className="aspect-square rounded-xl overflow-hidden border-2 border-gray-200 bg-gray-100 relative">
                <img
                  src={img}
                  alt={`Foto ${i + 1}`}
                  className="w-full h-full object-cover cursor-pointer"
                  onClick={() => setPreview(i)}
                />

                {/* Estrela — foto principal */}
                {i === 0 && (
                  <div className="absolute top-2 left-2 bg-yellow-400 text-white rounded-full p-1 shadow-sm">
                    <Star className="w-3 h-3 fill-white" />
                  </div>
                )}

                {/* Overlay com ações */}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2">
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() => makePrimary(i)}
                      className="text-xs bg-yellow-400 text-white font-semibold px-2 py-1 rounded-full flex items-center gap-1"
                    >
                      <Star className="w-3 h-3 fill-white" /> Principal
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    className="text-xs bg-red-500 text-white font-semibold px-2 py-1 rounded-full flex items-center gap-1"
                  >
                    <X className="w-3 h-3" /> Remover
                  </button>
                </div>
              </div>

              {/* Botões de reordenação */}
              {images.length > 1 && (
                <div className="flex justify-center gap-1 mt-1.5">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => moveLeft(i)}
                    className="w-6 h-6 rounded-full border flex items-center justify-center text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-xs text-muted-foreground self-center">{i + 1}</span>
                  <button
                    type="button"
                    disabled={i === images.length - 1}
                    onClick={() => moveRight(i)}
                    className="w-6 h-6 rounded-full border flex items-center justify-center text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Label */}
              <p className="text-center text-xs text-muted-foreground mt-1">
                {i === 0 ? <span className="text-yellow-600 font-medium">★ Principal</span> : `Foto ${i + 1}`}
              </p>
            </div>
          ))}

          {/* Slot para adicionar mais */}
          {images.length < MAX_PHOTOS && (
            <div className="flex-1">
              <AddSlot
                onFile={addFile}
                onDrop={handleDrop}
                draggingOver={draggingOver}
                setDraggingOver={setDraggingOver}
                onClick={() => inputRef.current?.click()}
              />
              <p className="text-center text-xs text-muted-foreground mt-1">
                {MAX_PHOTOS - images.length} vaga{MAX_PHOTOS - images.length !== 1 ? 's' : ''}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Estado vazio */}
      {images.length === 0 && (
        <AddSlot
          empty
          onFile={addFile}
          onDrop={handleDrop}
          draggingOver={draggingOver}
          setDraggingOver={setDraggingOver}
          onClick={() => inputRef.current?.click()}
        />
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />

      {images.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A foto com ★ aparece como principal no checkout. Use ‹ › para reordenar ou clique na foto para ver maior.
        </p>
      )}

      {/* Preview ampliado (lightbox simples) */}
      {preview !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreview(null)}
        >
          <div className="relative max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <img
              src={images[preview]}
              alt="Preview"
              className="w-full rounded-xl object-contain max-h-[80vh]"
            />
            <button
              onClick={() => setPreview(null)}
              className="absolute top-2 right-2 bg-white/90 rounded-full p-1.5 text-gray-700 hover:bg-white"
            >
              <X className="w-4 h-4" />
            </button>
            {images.length > 1 && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                {images.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setPreview(i)}
                    className={cn(
                      'w-2 h-2 rounded-full transition-colors',
                      i === preview ? 'bg-white' : 'bg-white/40'
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AddSlot({ empty, onClick, onDrop, draggingOver, setDraggingOver, onFile }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
      onDragLeave={() => setDraggingOver(false)}
      onDrop={(e) => { e.preventDefault(); setDraggingOver(false); onDrop(e); }}
      className={cn(
        'w-full rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer',
        empty ? 'h-44' : 'aspect-square',
        draggingOver
          ? 'border-blue-400 bg-blue-50'
          : 'border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50'
      )}
    >
      {empty ? (
        <>
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
            <ImageIcon className="w-6 h-6 text-gray-400" />
          </div>
          <div className="text-center px-3">
            <p className="text-sm font-medium text-gray-600">Clique para adicionar fotos</p>
            <p className="text-xs text-muted-foreground mt-0.5">ou arraste aqui · até {MAX_PHOTOS} fotos · JPG, PNG, WEBP</p>
          </div>
        </>
      ) : (
        <Plus className="w-6 h-6 text-gray-400" />
      )}
    </button>
  );
}
