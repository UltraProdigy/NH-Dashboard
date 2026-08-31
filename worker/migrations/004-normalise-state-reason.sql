-- Repair issues whose state_reason was written in the payload's own casing.
--
--   npx wrangler d1 execute nh-dashboard --remote \
--     --file migrations/004-normalise-state-reason.sql
--
-- The seed came from the GraphQL walk, which returns the enum: NOT_PLANNED.
-- The webhook payload spells the same value not_planned, and the handler bound
-- it raw — one line below the `.toUpperCase()` it applies to `state`.
--
-- Every rule that reads this column is a case-sensitive string compare, so a
-- lowercase row fails `state_reason IN ('NOT_PLANNED', 'DUPLICATE')` and is
-- read as completed. An issue closed as "not planned" is therefore counted as
-- fixed, which is the flattering direction and the one this project keeps
-- finding. The only visible symptom was `unknownReason` moving off zero: 9
-- closed issues at the time of writing, growing with every webhook close.
--
-- Fixed at the source in handlers.js. UPPER() is a no-op on rows that are
-- already correct, so this is safe to re-run and safe to apply before or after
-- the deploy that fixes the writer.
UPDATE issues
   SET state_reason = UPPER(state_reason)
 WHERE state_reason IS NOT NULL
   AND state_reason <> UPPER(state_reason);
