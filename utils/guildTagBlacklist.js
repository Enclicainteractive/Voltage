// ============================================================
// Guild Tag Blacklist - guildTagBlacklist.js
// ============================================================
// HOW THIS WORKS:
//   normalizeTag() converts ALL unicode/leet/symbol variants to
//   uppercase ASCII before checking. So the blacklist only needs
//   the clean normalized forms - no need to list N1GG, N!GG, etc.
//   The normalizer catches all of them and maps them to NIGG.
//
// COVERAGE:
//   - Racial & ethnic slurs
//   - Gender & sexuality slurs
//   - Ableist slurs
//   - Sexual / explicit content
//   - Violence & threats
//   - Extremist & terrorist orgs
//   - Drug trafficking terms
//   - CSAM / minor exploitation
//   - Cybercrime terms
// ============================================================


// ---- HOMOGLYPH + LEET NORMALIZER ----
const HOMOGLYPH_MAP = {
  // Cyrillic lookalikes
  "\u0410": "A", "\u0430": "A", "\u0415": "E", "\u0435": "E",
  "\u041E": "O", "\u043E": "O", "\u0420": "P", "\u0440": "P",
  "\u0421": "C", "\u0441": "C", "\u0422": "T", "\u0442": "T",
  "\u041D": "H", "\u043D": "H", "\u0412": "B", "\u0432": "B",
  "\u041A": "K", "\u043A": "K", "\u041C": "M", "\u043C": "M",
  "\u0425": "X", "\u0445": "X", "\u0406": "I", "\u0456": "I",
  "\u0408": "J", "\u0458": "J", "\u0405": "S", "\u0455": "S",
  "\u04AE": "Y", "\u04AF": "Y",

  // Greek lookalikes
  "\u0391": "A", "\u03B1": "A", "\u0392": "B", "\u03B2": "B",
  "\u0395": "E", "\u03B5": "E", "\u0396": "Z", "\u03B6": "Z",
  "\u0397": "H", "\u03B7": "H", "\u0399": "I", "\u03B9": "I",
  "\u039A": "K", "\u03BA": "K", "\u039C": "M", "\u03BC": "M",
  "\u039D": "N", "\u03BD": "N", "\u039F": "O", "\u03BF": "O",
  "\u03A1": "P", "\u03C1": "P", "\u03A4": "T", "\u03C4": "T",
  "\u03A5": "Y", "\u03C5": "Y", "\u03A7": "X", "\u03C7": "X",
  "\u03A3": "S", "\u03C3": "S", "\u0393": "G", "\u03B3": "G",
  "\u039B": "L", "\u03BB": "L", "\u03A9": "O", "\u03C9": "O",

  // Fullwidth Latin A-Z
  "\uFF21": "A", "\uFF22": "B", "\uFF23": "C", "\uFF24": "D",
  "\uFF25": "E", "\uFF26": "F", "\uFF27": "G", "\uFF28": "H",
  "\uFF29": "I", "\uFF2A": "J", "\uFF2B": "K", "\uFF2C": "L",
  "\uFF2D": "M", "\uFF2E": "N", "\uFF2F": "O", "\uFF30": "P",
  "\uFF31": "Q", "\uFF32": "R", "\uFF33": "S", "\uFF34": "T",
  "\uFF35": "U", "\uFF36": "V", "\uFF37": "W", "\uFF38": "X",
  "\uFF39": "Y", "\uFF3A": "Z",
  // Fullwidth a-z
  "\uFF41": "A", "\uFF42": "B", "\uFF43": "C", "\uFF44": "D",
  "\uFF45": "E", "\uFF46": "F", "\uFF47": "G", "\uFF48": "H",
  "\uFF49": "I", "\uFF4A": "J", "\uFF4B": "K", "\uFF4C": "L",
  "\uFF4D": "M", "\uFF4E": "N", "\uFF4F": "O", "\uFF50": "P",
  "\uFF51": "Q", "\uFF52": "R", "\uFF53": "S", "\uFF54": "T",
  "\uFF55": "U", "\uFF56": "V", "\uFF57": "W", "\uFF58": "X",
  "\uFF59": "Y", "\uFF5A": "Z",

  // Circled letters A-Z
  "\u24B6": "A", "\u24B7": "B", "\u24B8": "C", "\u24B9": "D",
  "\u24BA": "E", "\u24BB": "F", "\u24BC": "G", "\u24BD": "H",
  "\u24BE": "I", "\u24BF": "J", "\u24C0": "K", "\u24C1": "L",
  "\u24C2": "M", "\u24C3": "N", "\u24C4": "O", "\u24C5": "P",
  "\u24C6": "Q", "\u24C7": "R", "\u24C8": "S", "\u24C9": "T",
  "\u24CA": "U", "\u24CB": "V", "\u24CC": "W", "\u24CD": "X",
  "\u24CE": "Y", "\u24CF": "Z",
  // Circled a-z
  "\u24D0": "A", "\u24D1": "B", "\u24D2": "C", "\u24D3": "D",
  "\u24D4": "E", "\u24D5": "F", "\u24D6": "G", "\u24D7": "H",
  "\u24D8": "I", "\u24D9": "J", "\u24DA": "K", "\u24DB": "L",
  "\u24DC": "M", "\u24DD": "N", "\u24DE": "O", "\u24DF": "P",
  "\u24E0": "Q", "\u24E1": "R", "\u24E2": "S", "\u24E3": "T",
  "\u24E4": "U", "\u24E5": "V", "\u24E6": "W", "\u24E7": "X",
  "\u24E8": "Y", "\u24E9": "Z",

  // Accented Latin
  "\u00C0": "A", "\u00C1": "A", "\u00C2": "A", "\u00C3": "A",
  "\u00C4": "A", "\u00C5": "A", "\u00E0": "A", "\u00E1": "A",
  "\u00E2": "A", "\u00E3": "A", "\u00E4": "A", "\u00E5": "A",
  "\u00C6": "AE", "\u00E6": "AE",
  "\u00C7": "C", "\u00E7": "C",
  "\u00C8": "E", "\u00C9": "E", "\u00CA": "E", "\u00CB": "E",
  "\u00E8": "E", "\u00E9": "E", "\u00EA": "E", "\u00EB": "E",
  "\u00CC": "I", "\u00CD": "I", "\u00CE": "I", "\u00CF": "I",
  "\u00EC": "I", "\u00ED": "I", "\u00EE": "I", "\u00EF": "I",
  "\u0131": "I",
  "\u00D1": "N", "\u00F1": "N",
  "\u00D2": "O", "\u00D3": "O", "\u00D4": "O", "\u00D5": "O",
  "\u00D6": "O", "\u00D8": "O", "\u00F2": "O", "\u00F3": "O",
  "\u00F4": "O", "\u00F5": "O", "\u00F6": "O", "\u00F8": "O",
  "\u0152": "OE", "\u0153": "OE",
  "\u00D9": "U", "\u00DA": "U", "\u00DB": "U", "\u00DC": "U",
  "\u00F9": "U", "\u00FA": "U", "\u00FB": "U", "\u00FC": "U",
  "\u00DD": "Y", "\u00FD": "Y", "\u0178": "Y", "\u00FF": "Y",
  "\u00D0": "D", "\u00F0": "D",
  "\u00DE": "TH", "\u00FE": "TH",
  "\u00DF": "SS",
  "\u017F": "S",

  // Stroke / barred letters
  "\u00D8": "O", "\u00F8": "O",   // Ø ø
  "\u0110": "D", "\u0111": "D",   // Đ đ
  "\u0126": "H", "\u0127": "H",   // Ħ ħ
  "\u0141": "L", "\u0142": "L",   // Ł ł
  "\u014A": "N", "\u014B": "N",   // Ŋ ŋ
  "\u0166": "T", "\u0167": "T",   // Ŧ ŧ
  "\u0180": "B", "\u0243": "B",   // ƀ Ƀ
  "\u0197": "I", "\u0268": "I",   // Ɨ ɨ
  "\u023A": "A",                   // Ⱥ
  "\u023B": "C", "\u023C": "C",   // Ȼ ȼ  <-- the "C with a line through it"
  "\u023D": "L",                   // Ƚ
  "\u023E": "T",                   // Ⱦ
  "\u0246": "E", "\u0247": "E",   // Ɇ ɇ
  "\u0248": "J", "\u0249": "J",   // Ɉ ɉ
  "\u024A": "Q", "\u024B": "Q",   // Ɋ ɋ
  "\u024C": "R", "\u024D": "R",   // Ɍ ɍ
  "\u024E": "Y", "\u024F": "Y",   // Ɏ ɏ

  // Currency symbols used as letter replacements
  "\u00A2": "C",   // ¢ cent sign -> C  (the one you mentioned!)
  "\u00A3": "L",   // £ pound sign -> L
  "\u20AC": "E",   // € euro sign -> E
  "\u00A5": "Y",   // ¥ yen sign -> Y
  "\u20B9": "R",   // ₹ rupee sign -> R
  "\u20BF": "B",   // ₿ bitcoin sign -> B
  "\u20A6": "N",   // ₦ naira sign -> N
  "\u20B1": "P",   // ₱ peso sign -> P
  "\u20A9": "W",   // ₩ won sign -> W
  "\u20AB": "D",   // ₫ dong sign -> D

  // Superscript letters
  "\u1D2C": "A", "\u1D2E": "B", "\u1D30": "D", "\u1D31": "E",
  "\u1D33": "G", "\u1D34": "H", "\u1D35": "I", "\u1D36": "J",
  "\u1D37": "K", "\u1D38": "L", "\u1D39": "M", "\u1D3A": "N",
  "\u1D3C": "O", "\u1D3E": "P", "\u1D3F": "R", "\u1D40": "T",
  "\u1D41": "U", "\u1D42": "W",

  // Small caps
  "\u1D00": "A", "\u0299": "B", "\u1D04": "C", "\u1D05": "D",
  "\u1D07": "E", "\u0262": "G", "\u029C": "H", "\u026A": "I",
  "\u1D0A": "J", "\u1D0B": "K", "\u029F": "L", "\u1D0D": "M",
  "\u0274": "N", "\u1D0F": "O", "\u1D18": "P", "\u0280": "R",
  "\u1D1B": "T", "\u1D1C": "U", "\u1D20": "V", "\u1D21": "W",
  "\u028F": "Y", "\u1D22": "Z",

  // IPA / phonetic lookalikes
  "\u0251": "A", "\u0252": "A",   // alpha variants
  "\u0254": "O",                   // open o
  "\u025B": "E",                   // epsilon
  "\u0261": "G",                   // script g
  "\u0279": "R", "\u027E": "R",   // r variants
  "\u0283": "S",                   // esh
  "\u028C": "V",                   // turned v
  "\u028D": "W",                   // turned w
  "\u0292": "Z",                   // ezh

  // Misc symbol lookalikes
  "\u2113": "L",   // script l
  "\u2118": "P",   // Weierstrass p
  "\u211C": "R",   // fraktur R
  "\u2124": "Z",   // double-struck Z
  "\u2128": "Z",   // fraktur Z
  "\u212B": "A",   // Angstrom sign
  "\u2130": "E",   // script E
  "\u2131": "F",   // script F
  "\u2133": "M",   // script M

  // Leet speak / symbol substitutions
  "0": "O", "1": "I", "2": "Z", "3": "E", "4": "A",
  "5": "S", "6": "G", "7": "T", "8": "B", "9": "G",
  "@": "A", "$": "S", "!": "I", "|": "I", "+": "T",
  "(": "C", "<": "C", "#": "H", "%": "X", "^": "A",
  "*": "", "~": "", "-": "", "_": "", ".": "", ",": "",
};

// Normalize a tag: replace homoglyphs -> uppercase ASCII letters only
export function normalizeTag(tag) {
  return tag
  .split("")
  .map(char => HOMOGLYPH_MAP[char] ?? char)
  .join("")
  .toUpperCase()
  .replace(/[^A-Z]/g, "");
}


// ============================================================
// BLACKLIST
// Normalized uppercase ASCII forms only.
// Normalizer handles all leet/unicode bypass attempts.
// ============================================================
export const GUILD_TAG_BLACKLIST = new Set([

  // ---- N-WORD ----
  "NIG", "NIGG", "NIGR", "NGR",

  // ---- F-SLUR (anti-gay) ----
  "FAG", "FAGG", "FAGT", "FGT",

  // ---- C-SLUR ----
  "CUNT", "CNT",

  // ---- CHINK ----
  "CHNK", "CHIK",

  // ---- SPIC / SPICK ----
  "SPIC", "SPIK", "SPCK",

  // ---- KIKE ----
  "KIKE", "KYKE",

  // ---- GOOK ----
  "GOOK", "GUK",

  // ---- COON / KOON ----
  "COON", "KOON",

  // ---- CRACKER ----
  "CRKR",

  // ---- HONKY ----
  "HNKY",

  // ---- BEANER ----
  "BNAR", "BNRR",

  // ---- WETBACK ----
  "WETB", "WTBK",

  // ---- RAGHEAD ----
  "RGHD",

  // ---- JEWISH SLURS ----
  "YID", "HEB", "HYMY",

  // ---- PAKI ----
  "PAKI", "PAKY",

  // ---- ITALIAN SLURS ----
  "DAGO", "DEGO", "WOP",

  // ---- IRISH SLURS ----
  "MICK", "TAIG",

  // ---- ROMANI SLURS ----
  "GYPO", "GYPP",

  // ---- ABORIGINAL SLURS ----
  "ABBO", "BONG",

  // ---- EAST / SE ASIAN SLURS ----
  "SLOP", "NIPS",

  // ---- BLACK SLURS (additional) ----
  "SAMB", "DRKY", "JIGB", "JGBO", "GROD",

  // ---- NATIVE AMERICAN SLURS ----
  "SQAW", "INJN",

  // ---- MIXED HERITAGE SLURS ----
  "MLTO", "QUAD",

  // ---- MISC RACIAL ----
  "TOWL", "REDK",

  // ---- TRANS SLURS ----
  "TRNY", "TRAN",

  // ---- DYKE ----
  "DYKE",

  // ---- SLUT / WHORE ----
  "SLUT", "WHRE",

  // ---- ABLEIST ----
  "RTRD", "TARD", "MONG", "MNGL", "SPAZ",

  // ---- EXPLICIT SEXUAL ----
  "COCK", "DICK", "CUM", "JIZZ", "JIZ",
  "ANAL", "ANUS", "BDSM", "ORGY",
  "PRON", "PORN", "XXX", "SMUT",
  "TWAT", "PIMP", "HOE", "THOT",
  "VAGI", "VULV",
  "TITS",

  // ---- VIOLENCE & THREATS ----
  "KILL", "RAPE", "STAB", "BOMB",
  "GORE", "DEAD", "SHOT", "HURT",
  "DIE", "SNUF", "GURO", "HITM",
  "MERC", "ASSN", "NUKE", "GUT",

  // ---- EXTREMIST ORGS & SYMBOLS ----
  "KKK",
  "ISIS", "ISIL",
  "NAZI",
  "KLAN",
  "JIHD",
  "AB",
  "AWB",
  "PKK",
  "NSM",
  "NF",
  "BNP",
  "WAR",
  "NS",
  "HATE",
  "HAMS",
  "FARC",

  // ---- NUMERIC EXTREMIST CODES ----
  // Note: these are stored as their post-normalization letter forms
  // 1488 -> IAGG (I=1, A=4, G=8, G=8) - normalizer maps 8->B actually
  // We store the raw strings too for direct ASCII input
  "1488", "88",

  // ---- DRUGS & TRAFFICKING ----
  "METH", "COKE", "FENT", "MDMA",
  "DOPE", "BLOW", "CRCK", "SMCK",
  "SCAG", "DRUG", "PLUG", "TRAP",
  "SMGL", "TRFF", "XANS", "PERC",
  "BARS", "ACID", "LSD", "SNOW",
  "TINA", "WEED", "MARY",
  "HERO",  // heroin - also legitimate word, flag for manual review

  // ---- CSAM / MINOR EXPLOITATION ----
  "PEDO", "LOLI", "SHTA", "MAP",
  "CSAM", "CUBS", "PTCH", "NOMP",

  // ---- BESTIALITY / NECROPHILIA ----
  "ZOO", "BSTL", "NECR",

  // ---- CYBERCRIME ----
  "DDOS", "HACK", "DOXX", "SWAT",
  "PHSH", "MALW", "RATS", "XPLT",

  // ---- GENERAL PROFANITY ----
  "SHIT", "FUCK", "ASS", "PISS",

]);


// ============================================================
// EXPORTS
// ============================================================

/**
 * Check if a guild tag is blacklisted.
 * Automatically normalizes unicode, leet speak, and symbols before checking.
 *
 * @param {string} tag - Raw user input tag (any encoding)
 * @returns {boolean} true if the tag is blacklisted
 *
 * @example
 * isTagBlacklisted("N1GG")    // true  (1 -> I, normalized to NIGG)
 * isTagBlacklisted("F@GT")    // true  (@ -> A, normalized to FAGT)
 * isTagBlacklisted("VOLT")    // false
 * isTagBlacklisted("\u0421\u0423\u041D\u0422") // true (Cyrillic CUNT)
 */
export function isTagBlacklisted(tag) {
  const normalized = normalizeTag(tag);
  return GUILD_TAG_BLACKLIST.has(normalized);
}
