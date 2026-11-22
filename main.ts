// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool
// calls, finds the lines each edit names at the first of three matching
// tiers, and writes every change or none. Node 22, standard library only.
// Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// --strict is set once per run, before any edit is read.
let STRICT = false;

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function eqAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!eqAtTier(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** First tier (0..2, or 0 only when strict) with an occurrence at/after `from`. */
function findTier(lines: string[], oldLines: string[], from = 0, eofOnly = false): Found | null {
  const maxTier = STRICT ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrences(lines, oldLines, t).filter(
      (p) => p >= from && (!eofOnly || p + oldLines.length === lines.length),
    );
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** A body item: context (' '), old ('-'), new ('+') or backslash marker. */
type Item = { k: 'c' | 'o' | 'n' | 'b'; t: string };

function bodyItem(line: string): Item {
  if (line === '') return { k: 'c', t: '' };
  if (line[0] === ' ') return { k: 'c', t: line.slice(1) };
  if (line[0] === '-') return { k: 'o', t: line.slice(1) };
  return { k: 'n', t: line.slice(1) };
}

/** Tier-2 re-indent of one non-context new line (SPEC section 5). */
function reindent(t: string, tier: number, p: string, f: string): string {
  if (tier !== 2) return t;
  if (t === '' || /^[ \t]*$/.test(t)) return t;
  if (!t.startsWith(p)) return t;
  return f + t.slice(p.length);
}

/** The lines that replace the matched lines: context lines come from the
 *  file itself, other new lines are re-indented at tier 2. */
function buildReplacement(items: Item[], fileLines: string[], pos: number, tier: number): string[] {
  const oldLines = items.filter((it) => it.k === 'c' || it.k === 'o').map((it) => it.t);
  const p = oldLines.length > 0 ? leadWs(oldLines[0]!) : '';
  const f = leadWs(fileLines[pos] ?? '');
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.k === 'c') {
      out.push(fileLines[pos + oIdx]!);
      oIdx++;
    } else if (it.k === 'o') {
      oIdx++;
    } else if (it.k === 'n') {
      out.push(reindent(it.t, tier, p, f));
    }
  }
  return out;
}

function oldLinesOf(items: Item[]): string[] {
  return items.filter((it) => it.k === 'c' || it.k === 'o').map((it) => it.t);
}

function newLinesOf(items: Item[]): string[] {
  return items.filter((it) => it.k === 'c' || it.k === 'n').map((it) => it.t);
}

/** True when a `\` line follows the chunk/hunk's last context or `+` line. */
function noEolAfterLast(items: Item[]): boolean {
  for (let j = items.length - 1; j >= 0; j--) {
    if (items[j]!.k === 'c' || items[j]!.k === 'n') {
      return items[j + 1] !== undefined && items[j + 1]!.k === 'b';
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    diffOld: null,
    diffNew: null,
    pairOld: null,
    pairNew: null,
    hasPair: false,
    plusPath: null,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDel: false,
    hunks: [],
  };
}

/** Path from a `--- ` / `+++ ` header line: text after the four characters,
 *  up to the first tab, surrounding spaces removed, a leading a/ or b/
 *  removed; /dev/null means no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function applyUnifiedHunk(ft: FileText, hunk: Hunk, d: number, path: string): FileText {
  const o = oldLinesOf(hunk.items);
  const n = newLinesOf(hunk.items);
  if (o.length === 0) {
    const at = Math.min(hunk.a + d, ft.lines.length);
    const lines = [...ft.lines.slice(0, at), ...hunk.items.filter((it) => it.k === 'n').map((it) => it.t), ...ft.lines.slice(at)];
    const final = at === ft.lines.length ? !noEolAfterLast(hunk.items) : ft.final;
    return { br: ft.br, lines, final };
  }
  const found = findTier(ft.lines, o);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const repl = buildReplacement(hunk.items, ft.lines, best, found.tier);
  const lines = [...ft.lines.slice(0, best), ...repl, ...ft.lines.slice(best + o.length)];
  const runsToEnd = best + o.length === ft.lines.length;
  const final = runsToEnd ? !noEolAfterLast(hunk.items) : ft.final;
  return { br: ft.br, lines, final };
}

function unifiedSectionEdit(sec: Section): Edit {
  return (tree) => {
    // A `---`/`+++` pair names both paths; /dev/null in it means no file, so
    // the pair must win outright instead of falling through to diff --git
    // (which would turn a creation/deletion into a change). Without a pair,
    // rename lines win over diff --git, and a lone `+++` names the new path.
    const oldP = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
    const newP = sec.hasPair ? sec.pairNew : (sec.plusPath ?? sec.renameTo ?? sec.diffNew);
    const isCreate = sec.isNew || (oldP === null && newP !== null);
    const isDelete = sec.isDel || (newP === null && oldP !== null);
    // Contradictory headers (e.g. `new file mode` with `+++ /dev/null`, or a
    // pair of two /dev/null lines) name no usable path: change nothing rather
    // than crash on a null path.
    if (oldP === null && newP === null) return;
    if (isCreate && newP === null) return;
    if (isDelete && oldP === null) return;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.k === 'n') plus.push(it.t);
      let text = '';
      if (plus.length > 0) {
        let noeol = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const items = sec.hunks[hi]!.items;
          for (let j = items.length - 1; j >= 0; j--) {
            if (items[j]!.k === 'n') {
              noeol = items[j + 1] !== undefined && items[j + 1]!.k === 'b';
              break outer;
            }
          }
        }
        text = plus.join('\n') + (noeol ? '' : '\n');
      }
      tree.now.set(p, text);
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const path = oldP ?? newP!;
    if (!safe(path)) throw new Fail('unsafe', path);
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let ft = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const next = applyUnifiedHunk(ft, h, d, path);
      d += newLinesOf(h.items).length - oldLinesOf(h.items).length;
      ft = next;
    }
    const out = joinFile(ft);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(path, null);
      tree.moves.push([path, newP!]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      // Greedy: the separator is the LAST ` b/`, so paths may hold spaces
      // (and even ` b/` itself) on either side.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: Item[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          items.push(bodyItem(l));
          j++;
          continue;
        }
        if (l[0] === '\\') {
          items.push({ k: 'b', t: '' });
          j++;
          continue;
        }
        break;
      }
      while (items.length > 0 && items[items.length - 1]!.k === 'c' && items[items.length - 1]!.t === '') items.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
          cur.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.plusPath = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null) sections.push(cur);
      cur = newSection();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    // A lone `--- ` line outside a section's header is prose, not an error:
    // SPEC section 6 only calls it `error: parse` "inside a section's
    // header", and "outside bodies, lines that are not part of a section
    // header are ignored". (Inside a header the throw above already fired;
    // directly after a hunk body it is eaten as an old line instead.)
    i++;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const ft = splitFile(text);
      const found = findTier(ft.lines, oldLines);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length !== 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const pr = leadWs(oldLines[0]!);
      const fr = leadWs(ft.lines[pos]!);
      const repl = newLines.map((t) => reindent(t, found.tier, pr, fr));
      const out = [...ft.lines.slice(0, pos), ...repl, ...ft.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile({ br: ft.br, lines: out, final: ft.final }));
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

const SECTION_START = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const addLines: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (SECTION_START(l)) break;
        if (l.startsWith('+')) {
          addLines.push(l.slice(1));
          j++;
          continue;
        }
        if (blank(l)) {
          addLines.push('');
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      const path = p;
      const content = addLines;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (SECTION_START(l)) break;
        if (blank(l)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      const path = p;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let curChunk: Chunk | null = null;
      const closeChunk = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      let j = i + 1;
      // After a chunk is closed by `*** End of File`, only `@@` may start a
      // new chunk: a body line there is `error: parse <its line>` (a chunk
      // starts at `@@`, "or, for the first chunk, at a body line"). Blank
      // lines there are end-of-section blanks only while nothing but blanks
      // follows them to the section end; pendingBlank remembers the first.
      let eofClosed = false;
      let pendingBlank = -1;
      while (j < last) {
        const l = lines[j]!;
        if (SECTION_START(l)) break;
        // `*** End of File` matches EXACTLY: SPEC section 8 states trimming
        // for Begin/End Patch, section paths, the `@@` anchor and
        // SEARCH/REPLACE markers, but never for this line, so a trailing
        // space or tab makes it any other line (parse error below).
        if (l === '*** End of File') {
          if (pendingBlank >= 0) throw new Exit2(`error: parse ${pendingBlank + 1}`);
          if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          closeChunk();
          eofClosed = true;
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          if (pendingBlank >= 0) throw new Exit2(`error: parse ${pendingBlank + 1}`);
          closeChunk();
          curChunk = { anchor: l.slice(2).trim(), items: [], eof: false };
          eofClosed = false;
          j++;
          continue;
        }
        if (l.startsWith('*** Move to: ') && moveTo === null && chunks.length === 0 && curChunk === null) {
          if (pendingBlank >= 0) throw new Exit2(`error: parse ${pendingBlank + 1}`);
          moveTo = l.slice('*** Move to: '.length).trim();
          j++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (eofClosed) {
            if (l === '') {
              if (pendingBlank < 0) pendingBlank = j;
              j++;
              continue;
            }
            throw new Exit2(`error: parse ${pendingBlank >= 0 ? pendingBlank + 1 : j + 1}`);
          }
          if (curChunk === null) curChunk = { anchor: null, items: [], eof: false };
          curChunk.items.push(bodyItem(l));
          j++;
          continue;
        }
        if (pendingBlank >= 0) throw new Exit2(`error: parse ${pendingBlank + 1}`);
        throw new Exit2(`error: parse ${j + 1}`);
      }
      closeChunk();
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        // Trailing blank context lines are end-of-section blanks, EXCEPT in
        // an end-of-file chunk, where they sit before the End of File line
        // and belong to the chunk. An `@@`-started chunk still exists when
        // its body trims to empty (it still runs its anchor search); only a
        // body-line-started first chunk that trims to empty is no chunk.
        if (!tail.eof) {
          while (tail.items.length > 0 && tail.items[tail.items.length - 1]!.k === 'c' && tail.items[tail.items.length - 1]!.t === '') tail.items.pop();
          if (tail.items.length === 0 && tail.anchor === null) chunks.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      const path = p;
      const dest = moveTo;
      const chunkList = chunks;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
        const ft = splitFile(text);
        let curLines = [...ft.lines];
        let cursor = 0;
        for (const ch of chunkList) {
          if (ch.anchor !== null && ch.anchor !== '') {
            const aFound = findTier(curLines, [ch.anchor], cursor);
            if (aFound === null) throw new Fail('no-match', path);
            cursor = aFound.positions[0]! + 1;
          }
          const o = oldLinesOf(ch.items);
          if (o.length === 0) {
            const at = ch.eof ? curLines.length : cursor;
            const ins = ch.items.filter((it) => it.k === 'n').map((it) => it.t);
            curLines.splice(at, 0, ...ins);
            cursor = at + ins.length;
            continue;
          }
          const found = findTier(curLines, o, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', path);
          const pos = found.positions[0]!;
          const repl = buildReplacement(ch.items, curLines, pos, found.tier);
          curLines.splice(pos, o.length, ...repl);
          cursor = pos + repl.length;
        }
        const out = joinFile({ br: ft.br, lines: curLines, final: ft.final });
        if (dest !== null) {
          tree.now.set(dest, out);
          tree.now.set(path, null);
          tree.moves.push([path, dest]);
        } else {
          tree.now.set(path, out);
        }
      });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

const cmpBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  STRICT = strict;
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Changed paths, with move pairs folded into R lines (SPEC section 2).
  const changed: Array<{ key: string; row: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      changed.push({ key: newP, row: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (usedOld.has(p) || usedNew.has(p)) continue;
    changed.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => cmpBytes(a.key, b.key));
  const rows = changed.map((c) => c.row);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(cmpBytes)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
