import assert from 'node:assert/strict';
import test from 'node:test';

import { coverFitNotice, coverUploadSize, eventCoverUrl } from './event-cover.js';

test('the cover url points to the public bucket', () => {
  assert.equal(
    eventCoverUrl('11111111-1111-4111-8111-111111111111/a.jpg', 'https://x.supabase.co/'),
    'https://x.supabase.co/storage/v1/object/public/event-covers/11111111-1111-4111-8111-111111111111/a.jpg',
  );
  assert.equal(eventCoverUrl(null, 'https://x.supabase.co'), '');
  assert.equal(eventCoverUrl('a/b.jpg', ''), '');
});

test('big images shrink to 1600 wide and small ones are kept', () => {
  assert.deepEqual(coverUploadSize(4000, 1000), { width: 1600, height: 400 });
  assert.deepEqual(coverUploadSize(3000, 2000), { width: 1600, height: 1067 });
  assert.deepEqual(coverUploadSize(1200, 300), { width: 1200, height: 300 });
  assert.equal(coverUploadSize(0, 300), null);
});

test('the notice warns about cropping and blur, and stays quiet for a good cover', () => {
  assert.equal(coverFitNotice(1600, 400), '');
  assert.match(coverFitNotice(1080, 1080), /cortada para 4:1/);
  assert.match(coverFitNotice(800, 200), /borrada/);
});
