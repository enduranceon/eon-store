# Capa da página de inscrição do evento

Desde 30/10/2026. A página pública de inscrição (`/inscricao/:slug`) pode ter
uma capa no topo, uma faixa larga como o cabeçalho do Google Forms.

## Como usar

- Na ficha do evento, cartão **Capa da página de inscrição**: "Enviar capa",
  "Trocar capa" ou "Remover".
- **Tamanho ideal: 1600 × 400 px (proporção 4:1)**, em JPG, PNG ou WEBP de até
  5 MB. No Canva, use um tamanho personalizado de 1600 × 400.
- A capa aparece sempre em 4:1, no celular e no computador. Uma imagem em outra
  proporção é cortada nas bordas, e a tela avisa quando isso acontece ou
  quando a imagem é pequena demais (menos de 1000 px de largura).
- Antes do envio, a tela reduz a imagem para no máximo 1600 px de largura e
  grava em JPEG, para a página carregar rápido.

## Onde fica

- **Arquivo:** bucket público `event-covers`, em `<id do evento>/<arquivo>`.
- **Banco:** `events.cover_image_path`, que só aceita esse formato de caminho.
  A página pública recebe o caminho por `get_public_event`.
- **API:**
  - `POST /events/:id/cover/upload-url` devolve a URL assinada de envio;
  - `PUT /events/:id/cover` com `{ "path": "..." | null }` grava ou remove a
    capa, confere se o arquivo chegou ao bucket e apaga a capa anterior.
- **Migração:** `20261030120000_event_cover_image.sql`.
