// What to do when something on the DelPro screen goes wrong — written for the farm's
// own staff, so they can fix things without calling anyone. One entry per situation:
// what you see, why it happens, what to do. The queue shows the `short` line next to
// a problem; the help panel ("Jei kas nors neveikia") shows everything.
// Match a problem by its database code (`codes`) or by its message text (`match`).

export type HelpEntry = {
  id: string;
  group: HelpGroup;
  /** The heading — usually the text the person sees on screen. */
  title: string;
  /** Problem codes from fn_delpro_treatment_plan / fn_delpro_transfer_problems. */
  codes?: string[];
  /** Message fragments (lower case) that identify it in an error text. */
  match?: string[];
  /** Why it happens, in plain words. */
  why: string;
  /** Steps, in order. */
  steps: string[];
  /** One line for the queue, next to the problem. */
  short: string;
};

export type HelpGroup = "gydymai" | "kompiuteris" | "katalogas" | "ataskaitos" | "gyvuliai";

export const HELP_GROUP_LABEL: Record<HelpGroup, string> = {
  gydymai: "Gydymų siuntimas į DelPro",
  kompiuteris: "Ūkio kompiuteris",
  katalogas: "Vaistai ir ligos",
  ataskaitos: "Dienos ataskaitos (Excel)",
  gyvuliai: "Gyvuliai",
};

export const DELPRO_HELP: HelpEntry[] = [
  // ---------------------------------------------------------------- gydymai
  {
    id: "no-guid",
    group: "gydymai",
    title: "Nėra DelPro ObjectGuid",
    codes: ["no_animal_guid", "animal_guid"],
    match: ["objectguid"],
    why:
      "DelPro nežino šio gyvulio. GVET gydymą gali nusiųsti tik tam gyvuliui, kurį rado DelPro — tada gyvulys gauna DelPro ObjectGuid. " +
      "Dažniausiai taip būna su gyvuliu, kuris GVET buvo įvestas ranka (pvz. bandymui), arba kai GVET ausies numeris (ORN) parašytas kitaip nei DelPro.",
    steps: [
      "Atsidarykite gyvulio kortelę ir pažiūrėkite ausies numerį. Tikras numeris atrodo taip: LT000012345678.",
      "Jei tai bandomasis gyvulys (pvz. „lt 123“) — skiltyje „Paruošta siųsti“ arba „Nepavyko“ pažymėkite jo įrašus ir spauskite „Atmesti pažymėtus“. Gydymas GVET lieka, tik nebus siunčiamas į DelPro.",
      "Jei tai tikra karvė — pataisykite ausies numerį GVET, kad jis būtų lygiai toks pat kaip DelPro. Po kitos gyvulių sinchronizacijos (vyksta pati) gyvulys bus susietas.",
      "Kai gyvulys susietas, prie įrašo spauskite „Kartoti“ (jei jis skiltyje „Nepavyko“) arba „Siųsti į DelPro“.",
    ],
    short: "Gyvulys nesusietas su DelPro. Bandomąjį gyvulį — atmeskite; tikrą — pataisykite ausies numerį.",
  },
  {
    id: "no-diagnosis",
    group: "gydymai",
    title: "Liga nesusieta su DelPro diagnoze",
    codes: ["no_diagnosis_code", "diagnosis_link", "diagnosis_missing"],
    match: ["nesusieta su delpro diagnoze", "diagnozės susiejimo"],
    why: "DelPro įrašas visada turi diagnozę. Gydyme pasirinkta liga neturi poros DelPro sąraše, arba gydyme liga visai nepasirinkta.",
    steps: [
      "Atsidarykite skirtuką „Vaistai ir ligos“ → „Reikia sprendimo“. Jei ten yra ši liga su pasiūlymu — spauskite „Susieti“.",
      "Jei pasiūlymo nėra: „Rankinis susiejimas“ → pasirinkite „Liga“, DelPro įrašą ir GVET ligą → „Susieti“.",
      "Jei DelPro tokios ligos neturi — sukurkite ją DelPro tokiu pat pavadinimu ir spauskite „Sinchronizuoti dabar“. Susiejama pati.",
      "Jei gydyme liga nepasirinkta — atsidarykite gydymą ir pasirinkite ligą.",
      "Tada prie įrašo spauskite „Kartoti (nauji duomenys)“.",
    ],
    short: "Susiekite ligą: Vaistai ir ligos → Reikia sprendimo arba Rankinis susiejimas.",
  },
  {
    id: "no-drug",
    group: "gydymai",
    title: "„Vaistas“ nesusietas su DelPro vaistu",
    codes: ["medicine_not_linked"],
    match: ["nesusietas su delpro vaistu"],
    why:
      "Gydyme yra vaistas, kuriam DelPro sąraše nerasta poros. Gydymo medžiagos (geliai, tvarsčiai, švirkštai) į DelPro nesiunčiamos ir šios klaidos nesukelia — tai tik vaistai, vakcinos, profilaktikos priemonės ir boliusai.",
    steps: [
      "Patikrinkite, ar vaistas tikrai yra DelPro. Jei nėra — sukurkite jį DelPro lygiai tokiu pat pavadinimu kaip GVET.",
      "Spauskite „Sinchronizuoti dabar“ (skirtukas „Vaistai ir ligos“) ir palaukite kelias minutes — vaistas susies pats.",
      "Jei pavadinimai skiriasi: „Rankinis susiejimas“ → „Vaistas“ → pasirinkite abu → „Susieti“.",
      "Jei GVET turi du tokius pat vaistus — pirmiausia sujunkite juos skiltyje Produktai („Produktai tuo pačiu pavadinimu“).",
      "Jei tai ne vaistas, o priemonė — Produktuose pakeiskite jos tipą į „Gydymo medžiagos“.",
      "Tada prie įrašo spauskite „Kartoti (nauji duomenys)“.",
    ],
    short: "Susiekite vaistą: sukurkite jį DelPro tuo pačiu pavadinimu arba susiekite ranka.",
  },
  {
    id: "params",
    group: "gydymai",
    title: "DelPro vaisto parametrai (vienetas, karencija) negauti",
    codes: ["medicine_params_missing"],
    match: ["parametrai (vienetas, karencija) negauti"],
    why: "Vaistas susietas, bet ūkio kompiuteris dar neatsiuntė jo DelPro nustatymų (matavimo vieneto ir karencijos).",
    steps: [
      "Patikrinkite, ar viršuje „Ūkio kompiuteris“ rodo „Veikia“.",
      "Skirtuke „Vaistai ir ligos“ spauskite „Sinchronizuoti dabar“ ir palaukite, kol „Paskutinė sinchronizacija“ atsinaujins.",
      "DelPro patikrinkite, ar vaistas turi nurodytą vienetą ir karenciją.",
      "Tada prie įrašo spauskite „Kartoti (nauji duomenys)“.",
    ],
    short: "Paleiskite „Sinchronizuoti dabar“ ir pakartokite.",
  },
  {
    id: "params-lost",
    group: "gydymai",
    title: "DelPro neturi parametrų …",
    codes: ["params_not_in_delpro"],
    match: ["delpro neturi parametrų"],
    why:
      "Prieš įrašydamas ūkio kompiuteris patikrina DelPro. DelPro vaistas rodo į savo nustatymų įrašą (vienetas, karencija), bet DelPro to įrašo nerado. " +
      "Dažniausiai taip būna, kai vaisto nustatymai DelPro buvo ką tik pakeisti, o GVET dar turi senus duomenis, arba kai DelPro nustatymai buvo ištrinti.",
    steps: [
      "Prie įrašo spauskite „Greitas taisymas“ → „Pataisyti ir siųsti iš naujo“. GVET paprašys kompiuterio atnaujinti DelPro duomenis ir, kai šis baigs, išsiųs įrašą pats.",
      "Jei klaida grįžta su nurodymu „DelPro to įrašo nebėra“ — DelPro atsidarykite tą vaistą, patikrinkite vienetą ir karenciją ir spauskite „Išsaugoti“.",
      "Tada vėl „Greitas taisymas“.",
    ],
    short: "Spauskite „Greitas taisymas“ — GVET atnaujins DelPro duomenis ir išsiųs iš naujo.",
  },
  {
    id: "unit",
    group: "gydymai",
    title: "Vienetas: GVET … , DelPro …",
    codes: ["unit_mismatch"],
    match: ["vienetas: gvet"],
    why: "GVET ir DelPro tą patį vaistą skaičiuoja skirtingais vienetais (pvz. GVET ml, DelPro vnt). DelPro gautų neteisingą dozę, todėl siuntimas sustabdomas.",
    steps: [
      "Greičiausia: prie įrašo spauskite „Greitas taisymas“ ir įrašykite, kiek DelPro vienetų yra 1 GVET vienete (pvz. Metricure 1 vnt = 19 ml). GVET toliau siųs dozę DelPro vienetais, o atsargos ir aktai liks GVET vienetais.",
      "Arba nuspręskite, kuris vienetas teisingas.",
      "Jei teisingas GVET — pakeiskite vienetą DelPro vaisto nustatymuose ir spauskite „Sinchronizuoti dabar“.",
      "Dažniausiai paprasčiau pakeisti DelPro, kad sutaptų su GVET: GVET pagal šį vienetą skaičiuoja atsargas, sąskaitas ir nurašymo aktus.",
      "Tada prie įrašo spauskite „Kartoti (nauji duomenys)“.",
    ],
    short: "„Greitas taisymas“ → įrašykite, kiek DelPro vienetų yra 1 GVET vienete (pvz. 1 vnt = 19 ml).",
  },
  {
    id: "withdrawal",
    group: "gydymai",
    title: "Karencija: GVET pienas … / mėsa … d., DelPro … / … d.",
    codes: ["withdrawal_mismatch"],
    match: ["karencija: gvet"],
    why:
      "To paties vaisto karencija GVET ir DelPro skiriasi. Siųsti negalima, nes DelPro ir GVET rodytų skirtingą pieno ar mėsos karencijos pabaigą.",
    steps: [
      "Patikrinkite vaisto lapelį ir nuspręskite, kuri karencija teisinga.",
      "Pataisykite karenciją DelPro (taip rekomenduojama — DelPro yra pagrindinis). Po sinchronizacijos GVET pasiims tą pačią reikšmę ir perskaičiuos ir senų gydymų karencijos datas.",
      "Spauskite „Sinchronizuoti dabar“ ir palaukite, kol sinchronizacija baigsis.",
      "Tada prie įrašo spauskite „Kartoti (nauji duomenys)“.",
    ],
    short: "Pataisykite karenciją DelPro, sinchronizuokite, pakartokite.",
  },
  {
    id: "schedule",
    group: "gydymai",
    title: "Nenurodytas dažnumas arba gydymo trukmė",
    codes: ["frequency_missing", "course_days_missing"],
    match: ["nenurodytas dažnumas", "nenurodyta gydymo trukmė"],
    why: "DelPro kiekvienam vaistui reikia žinoti, kiek kartų per dieną ir kiek dienų jis duodamas. Senesni gydymai šių duomenų neturi.",
    steps: [
      "Tokio gydymo pataisyti negalima — DelPro įrašą reikės įvesti ranka arba atmesti.",
      "Jei įrašas DelPro nereikalingas — spauskite „Atmesti“.",
      "Nauji gydymai šių duomenų reikalauja, todėl ateityje ši klaida nebepasikartos.",
    ],
    short: "Senas gydymas be dažnumo — įveskite DelPro ranka arba atmeskite.",
  },
  {
    id: "no-medicine",
    group: "gydymai",
    title: "Gydyme nėra vaistų arba nėra dozės",
    codes: ["no_medicine", "missing_dose", "dose_missing"],
    match: ["gydyme nėra vaistų", "nėra dozės"],
    why: "Gydymas įrašytas be vaisto (arba vaisto kiekis 0). DelPro įrašui reikia bent vieno vaisto su doze.",
    steps: [
      "Jei vaistas tikrai buvo duotas — ištrinkite gydymą ir įveskite iš naujo su vaistu.",
      "Jei vaisto nebuvo — šio įrašo į DelPro siųsti nereikia, spauskite „Atmesti“.",
    ],
    short: "Gydymas be vaisto — atmeskite arba įveskite iš naujo.",
  },
  {
    id: "stale",
    group: "gydymai",
    title: "Duomenys pasikeitė",
    match: ["pasikeitė po patvirtinimo"],
    why: "Gydymas buvo patvirtintas siųsti, bet po to pasikeitė jo vaistai, karencija ar susiejimai. Senų duomenų GVET nesiųs.",
    steps: ["Peržiūrėkite įrašą.", "Spauskite „Patvirtinti iš naujo“ — bus siunčiami dabartiniai duomenys."],
    short: "Patvirtinkite iš naujo.",
  },
  {
    id: "verification",
    group: "gydymai",
    title: "Nepavyko patvirtinti įrašo",
    match: ["verification"],
    why:
      "Ūkio kompiuteris įrašė gydymą į DelPro, bet perskaitęs atgal rado kitus duomenis (pvz. kitą datą ar karenciją). Gali būti, kad DelPro įrašas jau yra, tik ne toks.",
    steps: [
      "Atsidarykite DelPro ir suraskite šio gyvulio gydymą tą dieną.",
      "Lentelėje prie įrašo palyginkite „Siųsta“ ir „DelPro įrašyta“.",
      "Jei DelPro įrašas neteisingas — pataisykite jį DelPro ranka.",
      "Jei DelPro įrašo visai nėra — spauskite „Kartoti“.",
      "Šių įrašų atmesti negalima, kol nepatikrinote DelPro — kitaip gali likti du įrašai.",
    ],
    short: "Patikrinkite įrašą DelPro; jei jo nėra — kartokite.",
  },
  {
    id: "waiting-admin",
    group: "gydymai",
    title: "Gydymas stovi „Paruošta siųsti“ ir niekur nejuda",
    why: "Šiuo metu kiekvieną gydymą į DelPro išleidžia administratorius. Kol niekas nepaspaudė „Siųsti“, gydymas laukia.",
    steps: [
      "Skirtuke „Gydymai → DelPro“ atsidarykite „Paruošta siųsti“.",
      "Pažymėkite įrašus be raudonų klaidų ir spauskite „Siųsti pažymėtus į DelPro“.",
      "Įrašai su raudona klaida nebus išsiųsti — pirmiausia pataisykite klaidą (žr. kitus punktus).",
    ],
    short: "Pažymėkite ir spauskite „Siųsti pažymėtus“.",
  },
  {
    id: "stuck-sending",
    group: "gydymai",
    title: "Gydymas ilgai stovi „Siunčiama“",
    why: "Gydymas išleistas, bet ūkio kompiuteris jo dar nepaėmė arba bando iš naujo po klaidos (kompiuteris kartoja pats, iki 8 kartų, vis rečiau).",
    steps: [
      "Viršuje pažiūrėkite „Ūkio kompiuteris“. Jei „Neatsako“ — žr. skyrių „Ūkio kompiuteris“.",
      "Jei kompiuteris veikia, palaukite 10–15 min. Jei įrašas po kelių bandymų nepavyks, jis atsiras skiltyje „Nepavyko“ su priežastimi.",
    ],
    short: "Patikrinkite, ar ūkio kompiuteris veikia.",
  },
  {
    id: "test-animal",
    group: "gydymai",
    title: "Sąraše daug bandomųjų įrašų",
    why: "Bandant sistemą buvo įvesti gydymai bandomiems gyvuliams. DelPro jų nežino, todėl jie niekada nebus išsiųsti.",
    steps: [
      "„Paruošta siųsti“ arba „Nepavyko“ skiltyje pažymėkite tuos įrašus (galima „Pažymėti visus“ ir nuimti tikrus).",
      "Spauskite „Atmesti pažymėtus“. Gydymai GVET lieka, atsargos nesikeičia.",
      "Jei norite, kad atsargos grįžtų — ištrinkite tuos gydymus skiltyje Gydymų istorija.",
    ],
    short: "Pažymėkite ir atmeskite.",
  },

  // ---------------------------------------------------------------- kompiuteris
  {
    id: "pc-offline",
    group: "kompiuteris",
    title: "Ūkio kompiuteris: „Neatsako“ arba „Neprisijungė“",
    why:
      "GVET su DelPro bendrauja per programą ūkio kompiuteryje (tame, kuriame veikia DelPro). Ji kas minutę praneša, kad veikia. Jei pranešimų nėra 15 min., rodoma „Neatsako“. " +
      "Kol kompiuteris neatsako, gydymai laukia eilėje — niekas neprarandama.",
    steps: [
      "Patikrinkite, ar ūkio kompiuteris įjungtas ir ar į jį prisijungta ūkio paskyra (programa paleidžiama prisijungus prie Windows).",
      "Patikrinkite internetą tame kompiuteryje (atsidarykite bet kurį tinklapį).",
      "Patikrinkite, ar veikia DelPro.",
      "Paprasčiausia — perkraukite kompiuterį ir prisijunkite. Po 1–2 min. GVET turėtų rodyti „Veikia“.",
      "Jei nepadeda: atsidarykite PowerShell kaip administratorius ir paleiskite: powershell -ExecutionPolicy Bypass -File C:\\GVET\\delpro-worker\\scripts\\gvet-worker.ps1 -Action restart",
      "Būseną ir paskutines klaidas parodo ta pati komanda su -Action status. Jei ir tada neveikia — nufotografuokite rezultatą ir perduokite prižiūrinčiam asmeniui.",
    ],
    short: "Įjunkite ūkio kompiuterį, prisijunkite, patikrinkite internetą.",
  },
  {
    id: "pc-no-model",
    group: "kompiuteris",
    title: "Gydymas išleistas, bet kompiuteris „negali įrašyti vaistų“",
    match: ["treatment_model", "negali įrašyti"],
    why: "Ūkio kompiuteryje nėra paruošto vaistų įrašymo nustatymo (failo treatment-model.json). Tai vienkartinis nustatymas, daromas diegiant.",
    steps: ["Patys šito nepataisysite — perduokite prižiūrinčiam asmeniui.", "Gydymai lauks eilėje ir bus išsiųsti, kai nustatymas bus įdiegtas."],
    short: "Reikia įdiegimo ūkio kompiuteryje — perduokite prižiūrinčiam asmeniui.",
  },

  // ---------------------------------------------------------------- katalogas
  {
    id: "cat-suggested",
    group: "katalogas",
    title: "Pasiūlomas susiejimas",
    why: "DelPro ir GVET turi įrašą tuo pačiu pavadinimu (vaistą ar ligą). GVET siūlo juos sujungti, bet pats to nedaro — tai patvirtinate jūs.",
    steps: [
      "Patikrinkite, ar tai tikrai tas pats vaistas / liga.",
      "Jei taip — spauskite „Susieti“ (arba viršuje „Patvirtinti pasiūlymus“, jei visi teisingi).",
      "Jei ne — spauskite „Atmesti“ ir susiekite ranka su teisingu įrašu.",
    ],
    short: "Patikrinkite ir spauskite „Susieti“.",
  },
  {
    id: "cat-ambiguous",
    group: "katalogas",
    title: "Neaiškus atitikmuo",
    why: "Tokiu pavadinimu yra keli įrašai (DelPro arba GVET), todėl GVET nežino, kurį susieti.",
    steps: [
      "Prie įrašo pasirinkite teisingą GVET įrašą mygtuku „Susieti su …“.",
      "Jei GVET turi du vienodus produktus — pirmiausia sujunkite juos Produktuose („Produktai tuo pačiu pavadinimu“).",
      "Jei DelPro turi du vienodus — nereikalingą DelPro padarykite neaktyviu.",
    ],
    short: "Pasirinkite, su kuriuo įrašu susieti.",
  },
  {
    id: "cat-difference",
    group: "katalogas",
    title: "Skiriasi reikšmės / Pakeista DelPro / Konfliktas",
    why:
      "Susieto vaisto ar ligos duomenys GVET ir DelPro nesutampa. „Pakeista DelPro“ — pakeitė DelPro; „Konfliktas“ — pakeista abiejose vietose skirtingai. " +
      "Lentelėje matote DelPro reikšmę, GVET reikšmę ir paskutinę suderintą.",
    steps: [
      "Pažiūrėkite lentelę ir nuspręskite, kuri reikšmė teisinga. Oranžinis taškas reiškia klinikinius duomenis (karenciją, vienetą) — juos tikrinkite ypač atidžiai.",
      "„Imti iš DelPro“ — GVET bus pakeistas pagal DelPro.",
      "„Palikti GVET“ — GVET reikšmė lieka; DelPro pataisykite patys arba „Siųsti į DelPro“, jei tai įjungta.",
    ],
    short: "Pasirinkite teisingą reikšmę.",
  },
  {
    id: "cat-removed",
    group: "katalogas",
    title: "Pašalinta iš DelPro",
    why: "Susietas vaistas ar liga DelPro nebėra (ištrintas). GVET savo įrašo netrina — istorija lieka.",
    steps: [
      "Jei DelPro ištrinta per klaidą — sukurkite iš naujo ir susiekite.",
      "Jei tikrai nebenaudojamas — spauskite „Atsieti“. GVET įrašas liks, bet nebus siunčiamas į DelPro.",
    ],
    short: "Sukurkite DelPro iš naujo arba atsiekite.",
  },
  {
    id: "cat-broken",
    group: "katalogas",
    title: "Trūksta susijusio įrašo",
    why: "DelPro įrašas rodo į kitą įrašą, kurio GVET negavo (pvz. gydymo šablonas rodo į vaistą, kurio sąraše nėra).",
    steps: ["Spauskite „Sinchronizuoti dabar“.", "Jei neišnyksta — patikrinkite DelPro, ar tas susijęs vaistas / šablonas yra aktyvus."],
    short: "Sinchronizuokite dar kartą.",
  },
  {
    id: "cat-clinical",
    group: "katalogas",
    title: "Patikrinkite karenciją",
    why: "Iš DelPro atkeltas naujas vaistas arba šablonas. Karencija ir dozės paimtos iš DelPro, bet jas turi patvirtinti žmogus.",
    steps: ["Palyginkite su vaisto lapeliu.", "Jei teisinga — „Patikrinta“.", "Jei ne — pataisykite DelPro, sinchronizuokite, tada „Patikrinta“."],
    short: "Palyginkite su lapeliu ir spauskite „Patikrinta“.",
  },
  {
    id: "cat-incomplete",
    group: "katalogas",
    title: "Gauta ne visa",
    match: ["gauta ne visa"],
    why: "DelPro atsakė ne visu sąrašu (pvz. per daug įrašų vienu kartu). Kad nieko neištrintų per klaidą, GVET tokiu atveju nieko nežymi kaip pašalinto.",
    steps: ["Spauskite „Sinchronizuoti dabar“ dar kartą.", "Jei kartojasi kiekvieną dieną — perduokite prižiūrinčiam asmeniui; darbas tęsiasi, tik be trynimų."],
    short: "Sinchronizuokite dar kartą.",
  },
  {
    id: "cat-new-drug",
    group: "katalogas",
    title: "Naujas vaistas DelPro, bet GVET jo nėra",
    why: "Vaistai ir ligos iš DelPro paimami kartą per dieną. Jei vaistas sukurtas šiandien, GVET jo dar nematė.",
    steps: [
      "Spauskite „Sinchronizuoti dabar“ ir palaukite, kol „Paskutinė sinchronizacija“ atsinaujins (kelios minutės).",
      "Vaistas atsiras Produktuose pats. Jei toks pavadinimas GVET jau yra — susies su esamu.",
      "Jei neatsirado — pažiūrėkite „Reikia sprendimo“ ir „Importas iš DelPro“.",
    ],
    short: "Spauskite „Sinchronizuoti dabar“.",
  },

  // ---------------------------------------------------------------- ataskaitos
  {
    id: "rep-missing",
    group: "ataskaitos",
    title: "Šiandienos ataskaitos nėra sąraše",
    why: "Ataskaitą (Excel) į GVET siunčia ūkio kompiuteris iš aplanko C:\\GVET\\Ataskaitos\\Dienine. Jei failo ten nėra arba kompiuteris išjungtas — GVET nieko negauna.",
    steps: [
      "Patikrinkite, ar DelPro tą dieną sukūrė failą tame aplanke.",
      "Patikrinkite, ar ūkio kompiuteris įjungtas ir prisijungęs prie interneto.",
      "Pažiūrėkite „Nepavykę įkėlimai“ — jei failas atėjo, bet jo nepavyko perskaityti, priežastis parašyta šalia.",
      "Jei įkėlimo programa ūkio kompiuteryje rašo apie „Authorization“ ar „raktą“ — skiltyje „Įkėlimas ir raktai“ sukurkite naują raktą ir įrašykite jį į įkėlimo programą. Senas raktas galėjo būti atšauktas.",
    ],
    short: "Patikrinkite aplanką ir ūkio kompiuterį.",
  },
  {
    id: "rep-few",
    group: "ataskaitos",
    title: "Ataskaitoje tik keli gyvuliai / duomenys neatsinaujino",
    why:
      "GVET įrašo tik tuos gyvulius, kurie yra faile. DelPro ataskaita dažnai rodo tik gyvulius su naujais sveikatos įvykiais, todėl kiti gyvuliai neatsinaujina — tai normalu.",
    steps: [
      "Lentelėje „Importuoti failai“ pažiūrėkite stulpelį „Eilutės“ — tiek gyvulių buvo faile.",
      "Jei turėjo būti daugiau — pakeiskite ataskaitos filtrą DelPro.",
      "Naujausius duomenis matysite gyvulio kortelėje, skiltyje „DelPro ataskaita“.",
    ],
    short: "Faile buvo tik tiek gyvulių — tai DelPro ataskaitos filtras.",
  },
  {
    id: "rep-columns",
    group: "ataskaitos",
    title: "DelPro ataskaitoje pridėjau naują stulpelį",
    why: "Nauji stulpeliai atpažįstami patys — nieko nustatinėti nereikia.",
    steps: [
      "Po kito įkėlimo stulpelis atsiras sąraše „Ataskaitos laukai“ ir gyvulio kortelėje (skiltyje „DelPro ataskaita“). Rodoma tik tų gyvulių, kurie buvo faile.",
      "Jei laukas nereikalingas — sąraše „Ataskaitos laukai“ spauskite „Slėpti“.",
    ],
    short: "Nauji stulpeliai atpažįstami patys.",
  },
  {
    id: "rep-review",
    group: "ataskaitos",
    title: "Konfliktai ir neatpažinti įrašai",
    why:
      "Eilutės, kurių GVET negali saugiai priskirti: ausies numeris netinkamas, tokiu numeriu yra keli gyvuliai, nesutampa gimimo data, arba tas pats numeris faile kelis kartus su skirtingais duomenimis.",
    steps: [
      "Perskaitykite priežastį prie eilutės.",
      "Pataisykite gyvulio duomenis GVET arba DelPro (pvz. gimimo datą).",
      "Jei eilutė nesvarbi — „Atmesti“. Kitą dieną atėjęs teisingas failas viską atnaujins.",
    ],
    short: "Pataisykite gyvulio duomenis arba atmeskite eilutę.",
  },

  // ---------------------------------------------------------------- gyvuliai
  {
    id: "animal-missing",
    group: "gyvuliai",
    title: "Gyvulio iš DelPro nėra GVET",
    why: "Gyvuliai atkeliami iš DelPro automatiškai. Jei gyvulio nėra — kompiuteris neveikia arba jo ausies numeris GVET jau priklauso kitam gyvuliui (tada jis praleidžiamas).",
    steps: [
      "Patikrinkite, ar „Ūkio kompiuteris“ rodo „Veikia“.",
      "Skirtuke „Gyvuliai“ pažiūrėkite stulpelį „Praleisti“. Jei skaičius ne 0 — kažkuris ausies numeris GVET priklauso kitam gyvuliui.",
      "Suraskite tą numerį GVET (Gyvūnai) ir pataisykite neteisingą gyvulį.",
    ],
    short: "Patikrinkite ausies numerius ir ūkio kompiuterį.",
  },
];

const norm = (s: string) => s.toLowerCase();

/** The help entry for a problem code, or for an error message (matched by text). */
export function findHelp(codeOrMessage: string | null | undefined): HelpEntry | null {
  if (!codeOrMessage) return null;
  const byCode = DELPRO_HELP.find((h) => h.codes?.includes(codeOrMessage));
  if (byCode) return byCode;
  const text = norm(codeOrMessage);
  return DELPRO_HELP.find((h) => h.match?.some((m) => text.includes(m))) ?? null;
}
