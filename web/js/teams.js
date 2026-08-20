/* ==========================================================================
   Org team membership
   --------------------------------------------------------------------------
   Hand-maintained for now. The dashboard isn't installed in the org yet, so
   the team API is out of reach and these rosters were typed in from the
   Teams page. When it is installed, the ingest should write the same shape
   into the data files and ROSTER becomes a fetch — everything below it,
   including the badge order, keeps working unchanged.

   TEAMS is in display order: badges appear in the order they're declared
   here, not in the order a person happens to have joined.
   ========================================================================== */

const TEAMS = [
  { id: "admin",       name: "GitHub Admin",     img: "assets/teams/admin.png" },
  { id: "contributor", name: "GTNH Contributor", img: "assets/teams/contributor.png" },
  { id: "developer",   name: "GTNH Developer",   img: "assets/teams/developer.png" },
  { id: "scala",       name: "Scala Developer",  img: "assets/teams/scala.png" },
  { id: "triage",      name: "Triage Team",      img: "assets/teams/triage.png" },
  { id: "balance",     name: "Balance Review",   img: "assets/teams/balance.png" },
];

const ROSTER = {
  admin: [
    "boubou19", "Connor-Colenso", "Dream-Master", "eigenraven", "Glease",
    "glowredman", "GregtechNewHorizons", "GTNH-Colen", "mitchej123",
    "UltraProdigy",
  ],
  contributor: [
    "bluhbipo", "boubou19", "leumasme", "SKProCH",
  ],
  developer: [
    "0hwx", "2ndDerivative", "AbdielKavash", "ABKQPO", "ah-OOG-ah", "Alexdoru",
    "Algent", "alppp", "AnsonYeung", "Auynonymous", "Azusfin", "BlueHero233",
    "BlueWeabo", "bombcar", "boubou19", "brandyyn", "BritishCynic", "C0bra5",
    "Caedis", "Cardinalstars", "chochem", "chrombread", "Cinobi", "Cleptomania",
    "combusterf", "Connor-Colenso", "CookieBrigade", "cubefury", "czqwq",
    "D-Cysteine", "danyadev", "DarkShadow44", "DeathFuel", "dibbydoda",
    "dipo33", "Discreater", "DreamYao520", "DrParadox7", "dvdmandt",
    "DylanTaylor1", "Dynamiczbee", "Eclipse-Sol", "eigenraven",
    "Eldrinn-Elantey", "Elisis", "EnderProyects", "Ethryan", "evgengoldwar",
    "fehling135", "felixfour", "firenoo", "FourIsTheNumber", "FrostyFire1",
    "Gamingb3ast", "GDCloudstrike", "ghostflyby", "GirixK", "Glease",
    "glektarssza", "GlodBlock", "glowredman", "greesyB", "GregtechNewHorizons",
    "GTNH-Colen", "guid118", "guneykabel", "Guvante", "ham-corp", "hinyb",
    "hiroscho", "HoleFish", "iouter", "JL2210", "jordanamr", "jss2a98aj",
    "jude123412", "june-dev-username", "KiloJoel", "Kiwi233", "Kogepan229",
    "koolkrafter5", "kuba6000", "kurrycat2004", "Kyium", "Kynake", "Laiff",
    "LazyFlesh", "lc-1337", "leagris", "LewisSaber", "loenaaaa",
    "Luca-Guettinger", "Lyfts", "lynxx131", "MalTeeez", "MassAnarchyy",
    "MCTBL", "Miklebe", "minecraft7771", "miozune", "mist475", "mitchej123",
    "MLGfruitshoot", "MuXiu1997", "Nana-Sakura", "NeOzay", "Nikolay-Sitnikov",
    "Nockyx", "NotAPenguin0", "NotUltraProdigy", "Nxer", "OneEyeMaker",
    "OrderedSet86", "OTPANNIEXD", "OvermindDL1", "Pelotrio", "Phineasor",
    "Pilzinsel64", "PLASMAchicken", "playfuldoggo", "POPlol333", "Pxx500",
    "Quarri6343", "Quetz4l", "Ranzuu", "RealSilverMoon", "RecursivePineapple",
    "ReignOfFROZE", "repo-alt", "Roadhog360", "Ruling-0", "S4mpsa",
    "Sanduhr32", "sbancuz", "ScriptedPiky", "serenibyss", "seventh-june",
    "SinTh0r4s", "sisyphussy", "SkorchedEU", "slprime", "spacebuilder2020",
    "Spaghetti-OberNub", "Spicierspace153", "StaffiX", "Steelux8",
    "StellaCaerulea", "SuperSoupr", "TechnicianLP", "TheElan",
    "TheEpicGamer274", "thehoblit", "TheYoingLad", "tiffit", "TimeConqueror",
    "TotallyNotOndre", "tth05", "UltraProdigy", "Vlamonster", "Volence",
    "VortexSo4", "Windorain", "wlhlm", "Worive", "YannickMG", "Yoshy2002",
    "YoungOnionMC", "YPXxiao", "ZaykieT",
  ],
  scala: [
    "boubou19", "guneykabel", "Guvante", "hinyb", "Luca-Guettinger",
    "OvermindDL1",
  ],
  triage: [
    "BegeistertsLab", "boubou19", "chochem", "GirixK", "miaowwwwww",
    "PLASMAchicken", "RAFAEL-SOSA-UH", "Ruling-0", "StaffiX", "UltraProdigy",
    "Yamnasm", "Yoshy2002",
  ],
  balance: [
    "boubou19", "Dream-Master",
  ],
};

// GitHub logins are case-insensitive and the rosters were typed by hand, so
// the index is folded rather than trusting the casing to match the store.
const BY_LOGIN = new Map();
for (const team of TEAMS) {
  for (const login of ROSTER[team.id] ?? []) {
    const key = login.toLowerCase();
    if (!BY_LOGIN.has(key)) BY_LOGIN.set(key, []);
    BY_LOGIN.get(key).push(team);
  }
}

/** The teams a login belongs to, in TEAMS order. Empty for anyone unlisted. */
const teamsOf = (login) => BY_LOGIN.get(String(login ?? "").toLowerCase()) ?? [];

export { TEAMS, teamsOf };
