export default function RouteFallback() {
  return (
    <div
      className="min-h-[12rem] flex items-center justify-center"
      role="status"
      aria-label="Carregando conteúdo"
    >
      <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
