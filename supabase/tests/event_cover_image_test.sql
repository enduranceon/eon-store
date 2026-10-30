BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(9);

-- Evento fictício aberto, com uma inscrição ativa.
INSERT INTO public.events (id, name, slug, status, event_date)
VALUES ('96000000-0000-4000-a000-000000000001', 'Evento Capa Teste', 'evento-capa-teste', 'open', '2030-02-13');

SELECT is(
  (SELECT public FROM storage.buckets WHERE id = 'event-covers'),
  true, 'the cover bucket is public');

SELECT lives_ok(
  $$SELECT public.set_event_cover_image('96000000-0000-4000-a000-000000000001',
    '96000000-0000-4000-a000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg')$$,
  'a cover in the event folder is saved');
SELECT is(
  public.get_public_event('evento-capa-teste')->>'cover_image_path',
  '96000000-0000-4000-a000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
  'the public page receives the cover');

SELECT is(
  public.set_event_cover_image('96000000-0000-4000-a000-000000000001',
    '96000000-0000-4000-a000-000000000001/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png')->>'previous_path',
  '96000000-0000-4000-a000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
  'a new cover returns the previous file to delete');

SELECT throws_ok(
  $$SELECT public.set_event_cover_image('96000000-0000-4000-a000-000000000001',
    '96000000-0000-4000-a000-000000000099/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png')$$,
  '22023', 'Arquivo da capa inválido', 'a file from another event folder is refused');
SELECT throws_ok(
  $$SELECT public.set_event_cover_image('96000000-0000-4000-a000-000000000001',
    '96000000-0000-4000-a000-000000000001/../x.png')$$,
  '22023', 'Arquivo da capa inválido', 'a free file name is refused');
SELECT throws_ok(
  $$UPDATE public.events SET cover_image_path = 'qualquer/coisa.gif'
    WHERE id = '96000000-0000-4000-a000-000000000001'$$,
  '23514', NULL, 'the column only takes paths in the generated format');

SELECT is(
  public.set_event_cover_image('96000000-0000-4000-a000-000000000001', NULL)->>'cover_image_path',
  NULL, 'the cover can be removed');
SELECT throws_ok(
  $$SELECT public.set_event_cover_image('96000000-0000-4000-a000-000000000002', NULL)$$,
  'P0002', 'Evento não encontrado', 'a missing event is refused');

SELECT * FROM finish();
ROLLBACK;
