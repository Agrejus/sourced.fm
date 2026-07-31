// Script text is written to be read; the TTS needs text written to be said.
// Code tokens (file extensions, camelCase identifiers, globs, paths) are not
// English words, and VibeVoice improvises sounds for them — the failure the
// listener hears as "it switched language mid-sentence".
//
// This runs on the way to the speech service only. The stored script keeps the
// original text, so the on-screen transcript still reads like code. Alignment
// uses the spoken form too, which is what whisper actually hears.

// Dotted abbreviations that are prose, not file extensions.
const NOT_AN_EXTENSION = new Set(["e", "g", "i", "al", "etc", "vs", "cf", "ex", "no", "pp"]);
// Domains are said, not spelled: "example dot com", never "example C O M".
const TLDS = new Set(["com", "org", "net", "io", "ai", "dev", "co", "gov", "edu"]);
// Extensions containing a vowel, which the vowel heuristic below cannot catch.
const EXTENSIONS = new Set([
  "json", "yaml", "yml", "toml", "java", "wav", "mp3", "mp4", "png", "jpeg", "jpg",
  "svg", "pdf", "html", "xml", "ini", "log", "lock", "env", "exe", "bat",
]);

// ".tsx" -> "T S X". Spaced capitals are what makes a TTS spell it out.
function spellExtension(letters: string): string {
  return letters.toUpperCase().split("").join(" ");
}

export function toSpeakable(text: string): string {
  let out = text;

  // Fenced or inline code markers carry no sound.
  out = out.replace(/`+/g, "");

  // Dashes. An em dash with no spaces around it ("itself—the") is a single
  // unknown token to the model, and it is by far the most common one in our
  // scripts. A comma gives the pause the writer intended.
  out = out.replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2"); // ranges: 5–10
  out = out.replace(/\s*[–—]\s*/g, ", ");
  out = out.replace(/,\s*,/g, ",");

  // Call syntax: "use()" is said "use", "User(id)" is said "User id". Only
  // parentheses glued to a word are calls; prose parentheses are left alone
  // because a TTS already reads straight through them.
  out = out.replace(/(?<=\w)\(([^)]*)\)/g, (_whole, inner: string) => (inner ? ` ${inner}` : ""));

  // Handles and scopes: "@trueadm", "@octanejs".
  out = out.replace(/@(\w)/g, "at $1");

  // Symbols that are words when spoken.
  out = out.replace(/\$(?=[A-Za-z_])/g, " dollar ");
  out = out.replace(/\s=\s/g, " equals ");
  out = out.replace(/(\d)\s*x\b/g, "$1 times"); // 5x -> five times

  // A command-line flag is said without its dashes: the sentence around it
  // already says "flag". Also kills the dot-underscore in code like "._k".
  out = out.replace(/(^|\s)--?(?=[A-Za-z])/g, "$1");
  out = out.replace(/\._/g, " ");

  // A leading-slash route reads as a path.
  out = out.replace(/(^|\s)\/(\w)/g, "$1slash $2");

  // snake_case and camelCase split into words first: a hump straight after a
  // dot ("console.timeEnd") hides the word boundary the dotted rule needs.
  out = out.replace(/(\w)_(\w)/g, "$1 $2");
  out = out.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

  // Dotted suffixes, standalone (".tsx") or attached ("index.ts", "props.state").
  // A dot followed by a space, a digit or capitals never matches, so sentence
  // ends, decimals and "U.S." are safe. The preceding character is inspected
  // rather than consumed, so chains like "props.state.time" resolve every link.
  out = out.replace(/\.([a-z]{1,5})\b/g, (whole: string, suffix: string, offset: number) => {
    const prev = offset > 0 ? out[offset - 1]! : " ";
    if (!/[\w\s("']/.test(prev)) return whole;
    if (NOT_AN_EXTENSION.has(suffix)) return whole;
    if (TLDS.has(suffix)) return ` dot ${suffix}`;
    // An extension gets spelled out; a real word after a dot is simply said.
    // Anything without a vowel is an extension however obscure: .tsrx, .rs, .css.
    const isExtension = EXTENSIONS.has(suffix) || !/[aeiou]/.test(suffix);
    return isExtension ? ` ${spellExtension(suffix)}` : ` ${suffix}`;
  });

  // Property access with a long name ("todo.priority") is two spoken words. The
  // rule above only covers suffixes short enough to be a file extension.
  out = out.replace(/(\w)\.([a-z]{6,15})\b/g, "$1 $2");

  // An empty argument list left by itself carries no sound.
  out = out.replace(/\(\s*\)/g, "");

  // Dotfiles are longer than an extension and are said with the dot out loud:
  // ".gitignore" is "dot gitignore".
  out = out.replace(/(^|\s)\.([a-z][a-z-]{4,14})\b/g, "$1dot $2");

  // Globs and wildcards: "use*" is read as a word plus a symbol.
  out = out.replace(/(\w)\*/g, "$1 star").replace(/\*(\w)/g, "star $1");

  // Arrows, in code or in prose.
  out = out.replace(/=>|->/g, " arrow ");

  // Paths and either/or slashes.
  out = out.replace(/(\w)\/(\w)/g, "$1 slash $2");

  // Brackets and braces are silent; whatever sits inside them still gets said.
  out = out.replace(/[<>{}[\]]/g, " ");

  // Whatever the rules above left stranded: a slash before a symbol ("/*"), a
  // lone at-sign or star, an orphan underscore.
  out = out.replace(/\/(?=\W|$)/g, " slash ");
  out = out.replace(/(^|\s)@(\s|$)/g, "$1at$2");
  out = out.replace(/(^|\s)\*+(\s|$)/g, "$1star$2");
  out = out.replace(/(^|\s)_+|_+(?=\s|$)/g, "$1");

  // Collapse the whitespace the rules above introduce.
  return out.replace(/[ \t]{2,}/g, " ").trim();
}
