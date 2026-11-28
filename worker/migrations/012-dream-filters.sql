-- Seeds the Dream Panel's shared repo and label filters with the lists the page
-- used to hardcode. Runs once; after that the list is whatever admins set.
--
--   cd worker && npx wrangler d1 execute nh-dashboard --remote --file migrations/012-dream-filters.sql
--
-- Until it runs, every card starts with nothing hidden.
INSERT OR IGNORE INTO meta (key, value) VALUES ('dream_filters', '{"approvedUnmerged":{"repos":["Angelica","Galaxia","UtilitiesInExcess","Horizon-QA","lwjgl3ify","supernova"],"labels":["⚠️ AUTHOR MERGE ONLY"]},"changesRequested":{"repos":[],"labels":[]},"needsRelease":{"repos":["DreamAssemblerXXL","TC4Tweaks","GTNewHorizons.github.io","StargateNH","UtilitiesInExcess","MergeMasterXXL-TestRepo","GTNH-Web-Map","Ic2ExpReactorPlanner","Angelica","TaskNH","MergePreMaster","BugTorch","TinkersGregworks","GTNH-Translations","GTNHIssueHelper","CubicChunks1710","supernova"],"labels":[]},"byLabel":{"repos":[],"labels":[]},"updates":{"repos":[],"labels":[]}}');
