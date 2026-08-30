-- Repair repos whose pushed_at was written as a Unix epoch integer.
--
--   npx wrangler d1 execute nh-dashboard --remote \
--     --file migrations/003-repair-epoch-pushed-at.sql
--
-- `repository.pushed_at` is an ISO string on most webhook events and an epoch
-- integer on `push`. Stored raw in a TEXT column the integer becomes
-- '1756568400', and since every comparison here is a string comparison, '1'
-- sorts below '2' and the value lands beneath every ISO date. The repo then
-- fails `pushed_at >= <a year ago>`, reads as dormant, and vanishes from both
-- release panels — while being one of the most actively pushed repos in the
-- org, which is why it looked like data loss rather than a filter.
--
-- Fixed at the source in handlers.js. This repairs what the old code already
-- wrote: 27 repos at the time of writing, every one of them active.
--
-- Converted rather than nulled. SQLite can do the arithmetic, and the value is
-- not wrong — only its format is, so throwing it away would lose a real fact.
-- The CAST is safe because the WHERE clause has already established the value
-- is all digits.
UPDATE repos
   SET pushed_at = strftime('%Y-%m-%dT%H:%M:%SZ', CAST(pushed_at AS INTEGER), 'unixepoch')
 WHERE pushed_at IS NOT NULL
   AND pushed_at GLOB '[0-9]*'
   AND pushed_at NOT GLOB '*[^0-9]*';

UPDATE repos
   SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', CAST(updated_at AS INTEGER), 'unixepoch')
 WHERE updated_at IS NOT NULL
   AND updated_at GLOB '[0-9]*'
   AND updated_at NOT GLOB '*[^0-9]*';
