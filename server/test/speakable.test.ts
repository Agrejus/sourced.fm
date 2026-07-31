import { test, expect } from "bun:test";
import { toSpeakable } from "../src/speech/speakable";

test("file extensions are spelled out, prose abbreviations are left alone", () => {
  expect(toSpeakable("a compiled .tsrx or .tsx module")).toBe("a compiled T S R X or T S X module");
  expect(toSpeakable("plain .ts or .js modules")).toBe("plain T S or J S modules");
  // not extensions
  expect(toSpeakable("e.g. this one")).toBe("e.g. this one");
  expect(toSpeakable("about 3.5 times")).toBe("about 3.5 times");
  expect(toSpeakable("End of sentence. Next one.")).toBe("End of sentence. Next one.");
});

test("identifiers become the words a person says", () => {
  expect(toSpeakable("useEffect, useMemo, and useImperativeHandle")).toBe(
    "use Effect, use Memo, and use Imperative Handle",
  );
  expect(toSpeakable("the call_notes field")).toBe("the call notes field");
  expect(toSpeakable("a use* name alone")).toBe("a use star name alone");
});

test("code punctuation is spoken or dropped, never left as a symbol", () => {
  expect(toSpeakable("src/index.ts")).toBe("src slash index T S");
  expect(toSpeakable("an arrow like => here")).toBe("an arrow like arrow here");
  expect(toSpeakable("`useState` returns")).toBe("use State returns");
  expect(toSpeakable("renders <div> elements")).toBe("renders div elements");
});

test("ordinary prose is untouched", () => {
  const prose =
    "So the compiler reads the callback body, figures out which variables it uses, " +
    "and builds the dependency list from that. That sounds almost too good to be true.";
  expect(toSpeakable(prose)).toBe(prose);
  expect(toSpeakable("The GPU renders it in one pass.")).toBe("The GPU renders it in one pass.");
  expect(toSpeakable("It costs $1.50 per hour, roughly.")).toBe("It costs $1.50 per hour, roughly.");
});

test("the real sentence from the episode that broke", () => {
  const written =
    "So if you write a custom hook in a compiled .tsrx or .tsx module, and it just passes " +
    "its callback and dependency parameter straight through to useEffect or useMemo, the " +
    "compiler can follow that. The compiler does not guess from a use* name alone.";
  const spoken = toSpeakable(written);
  expect(spoken).toContain("T S R X or T S X module");
  expect(spoken).toContain("use Effect or use Memo");
  expect(spoken).toContain("use star name alone");
  // nothing unspeakable survives
  expect(spoken).not.toMatch(/\.[a-z]{1,5}\b(?![.\d])/);
  expect(spoken).not.toMatch(/[a-z][A-Z]/);
  expect(spoken).not.toContain("*");
});

test("a real word after a dot is said, not spelled", () => {
  // "props.state" is not a file; spelling it out would be worse than the bug.
  expect(toSpeakable("it reads props.state directly")).toBe("it reads props state directly");
  expect(toSpeakable("chained like foo.state.time here")).toBe("chained like foo state time here");
  // extensions with vowels still spell out, via the known list
  expect(toSpeakable("edit the package.json file")).toBe("edit the package J S O N file");
  // domains are said the way people say them
  expect(toSpeakable("published on example.com yesterday")).toBe("published on example dot com yesterday");
});

test("a camelCase hump right after a dot does not hide the boundary", () => {
  expect(toSpeakable("it calls console.timeEnd there")).toBe("it calls console time End there");
  expect(toSpeakable("a compiler.stateModel policy")).toBe("a compiler state Model policy");
});

test("dashes become pauses, and number ranges become words", () => {
  // The common shape in our scripts: no spaces around the dash.
  expect(toSpeakable("the runtime itself—the part that ships")).toBe(
    "the runtime itself, the part that ships",
  );
  expect(toSpeakable("two modes — carries a cost")).toBe("two modes, carries a cost");
  expect(toSpeakable("takes 5–10 minutes")).toBe("takes 5 to 10 minutes");
  expect(toSpeakable("a choice, — and a cost")).toBe("a choice, and a cost");
});

test("call syntax, handles and symbols are spoken", () => {
  expect(toSpeakable("you call use() at the top")).toBe("you call use at the top");
  expect(toSpeakable("it wraps use(t) internally")).toBe("it wraps use t internally");
  expect(toSpeakable("as @trueadm put it")).toBe("as at trueadm put it");
  expect(toSpeakable("the @octanejs scope")).toBe("the at octanejs scope");
  expect(toSpeakable("about 5x faster")).toBe("about 5 times faster");
  expect(toSpeakable("where count = total")).toBe("where count equals total");
  expect(toSpeakable("hits /posts first")).toBe("hits slash posts first");
  expect(toSpeakable("add it to .gitignore now")).toBe("add it to dot gitignore now");
});

test("prose parentheses and real currency survive", () => {
  expect(toSpeakable("the compiler (and the runtime) both change")).toBe(
    "the compiler (and the runtime) both change",
  );
  expect(toSpeakable("it costs $1.50 an hour")).toBe("it costs $1.50 an hour");
});

test("stranded symbols do not reach the model", () => {
  expect(toSpeakable("the @octanejs/* scope")).toBe("the at octanejs slash star scope");
  expect(toSpeakable("reads slots._k$N here")).not.toContain("$");
  expect(toSpeakable("an _ on its own")).toBe("an on its own");
  expect(toSpeakable("a * on its own")).toBe("a star on its own");
});

test("command-line flags and code punctuation glue", () => {
  expect(toSpeakable("run it with --sparkplug enabled")).toBe("run it with sparkplug enabled");
  expect(toSpeakable("the -v flag")).toBe("the v flag");
  expect(toSpeakable("reads slots._k$N once")).toBe("reads slots k dollar N once");
  // a hyphenated word is not a flag
  expect(toSpeakable("a well-known trade-off")).toBe("a well-known trade-off");
});

test("long property access and stray empty parens", () => {
  expect(toSpeakable("it reads todo.priority first")).toBe("it reads todo priority first");
  expect(toSpeakable("you call use () there")).toBe("you call use there");
  // a dotfile still says its dot
  expect(toSpeakable("listed in .gitignore")).toBe("listed in dot gitignore");
});
