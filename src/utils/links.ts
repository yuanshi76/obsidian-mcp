import path from "node:path";

import type { PlannedChange } from "./transaction.js";
import type { VaultEntry, VaultFs } from "./vault.js";

interface NoteIndex {
  exact: Map<string, VaultEntry>;
  basename: Map<string, VaultEntry[]>;
}

export interface LinkChangeSet {
  changes: PlannedChange[];
  updatedFiles: string[];
  ambiguousLinks: number;
}

export async function planLinkUpdates(
  vaultFs: VaultFs,
  oldPath: string,
  newPath: string | undefined,
  mode: "move" | "mark_broken"
): Promise<LinkChangeSet> {
  const notes = await vaultFs.listMarkdown();
  const index = buildIndex(notes);
  const changes: PlannedChange[] = [];
  const updatedFiles: string[] = [];
  let ambiguousLinks = 0;

  for (const note of notes) {
    if (note.relativePath === oldPath) continue;
    const read = await vaultFs.readText(note);
    const result = rewriteLinks(read.text, note.relativePath, oldPath, newPath, mode, index);
    ambiguousLinks += result.ambiguous;
    if (result.text !== read.text) {
      changes.push({
        kind: "write",
        path: note.absolutePath,
        data: Buffer.from(result.text),
        expectedEtag: read.etag
      });
      updatedFiles.push(note.relativePath);
    }
  }
  return { changes, updatedFiles, ambiguousLinks };
}

function buildIndex(notes: readonly VaultEntry[]): NoteIndex {
  const exact = new Map<string, VaultEntry>();
  const basename = new Map<string, VaultEntry[]>();
  for (const note of notes) {
    const normalized = stripMarkdown(note.relativePath).toLocaleLowerCase();
    exact.set(normalized, note);
    const name = path.posix.basename(normalized);
    const candidates = basename.get(name) ?? [];
    candidates.push(note);
    basename.set(name, candidates);
  }
  return { exact, basename };
}

function rewriteLinks(
  text: string,
  sourcePath: string,
  oldPath: string,
  newPath: string | undefined,
  mode: "move" | "mark_broken",
  index: NoteIndex
): { text: string; ambiguous: number } {
  let ambiguous = 0;
  const lines = text.split(/(?<=\n)/u);
  let fenced = false;
  let inComment = false;
  const output = lines.map((line) => {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const transformed = transformVisibleLine(line, inComment, (visible) => {
      let rewritten = visible.replace(
        /(!?)\[\[([^\]]+)\]\]/gu,
        (whole, embed: string, inside: string) => {
          const [targetAndAnchor, alias] = splitOnce(inside, "|");
          const [target, anchor] = splitAnchor(targetAndAnchor);
          const resolution = resolveLink(target, sourcePath, index);
          if (resolution.kind === "ambiguous") {
            ambiguous += 1;
            return whole;
          }
          if (resolution.kind !== "resolved" || resolution.path !== oldPath) return whole;
          if (mode === "mark_broken") return `~~${whole}~~`;
          const replacement = formatWikiTarget(target, newPath ?? oldPath);
          return `${embed}[[${replacement}${anchor}${alias === undefined ? "" : `|${alias}`}]]`;
        }
      );
      // The URL class already admits every character of the literal "%20",
      // so a separate (?:%20…)* group cannot extend the language — it only
      // adds nested-quantifier ambiguity (exponential backtracking, CWE-1333).
      rewritten = rewritten.replace(
        /(!?)\[([^\]]*)\]\((<)?([^)>\s]+)(>)?\)/gu,
        (
          whole,
          embed: string,
          label: string,
          open: string | undefined,
          rawTarget: string,
          close: string | undefined
        ) => {
          const decoded = safeDecode(rawTarget);
          const [target, anchor] = splitAnchor(decoded);
          if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) return whole;
          const resolution = resolveLink(target, sourcePath, index);
          if (resolution.kind === "ambiguous") {
            ambiguous += 1;
            return whole;
          }
          if (resolution.kind !== "resolved" || resolution.path !== oldPath) return whole;
          if (mode === "mark_broken") return `~~${whole}~~`;
          const replacement = formatMarkdownTarget(target, newPath ?? oldPath, sourcePath);
          const encoded = replacement.split("/").map(encodeURIComponent).join("/");
          return `${embed}[${label}](${open ?? ""}${encoded}${anchor}${close ?? ""})`;
        }
      );
      return rewritten;
    });
    inComment = transformed.inComment;
    return transformed.text;
  });
  return { text: output.join(""), ambiguous };
}

function transformVisibleLine(
  line: string,
  initialComment: boolean,
  transform: (visible: string) => string
): { text: string; inComment: boolean } {
  let output = "";
  let visible = "";
  let inComment = initialComment;
  let ticks = 0;
  const flush = (): void => {
    output += transform(visible);
    visible = "";
  };
  for (let cursor = 0; cursor < line.length; cursor += 1) {
    if (!inComment && ticks === 0 && line.startsWith("<!--", cursor)) {
      flush();
      inComment = true;
    }
    if (inComment) {
      output += line[cursor];
      if (line.startsWith("-->", cursor)) {
        output += "->";
        cursor += 2;
        inComment = false;
      }
      continue;
    }
    if (line[cursor] === "`") {
      flush();
      let count = 1;
      while (line[cursor + count] === "`") count += 1;
      output += "`".repeat(count);
      cursor += count - 1;
      ticks = ticks === 0 ? count : ticks === count ? 0 : ticks;
      continue;
    }
    if (ticks === 0) visible += line[cursor];
    else output += line[cursor];
  }
  flush();
  return { text: output, inComment };
}

function resolveLink(
  target: string,
  sourcePath: string,
  index: NoteIndex
): { kind: "resolved"; path: string } | { kind: "ambiguous" } | { kind: "missing" } {
  const normalized = stripMarkdown(target.replace(/^\.\//u, "")).toLocaleLowerCase();
  const relative = stripMarkdown(
    path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), normalized))
  );
  const exact = index.exact.get(normalized) ?? index.exact.get(relative);
  if (exact !== undefined) return { kind: "resolved", path: exact.relativePath };
  if (target.includes("/")) return { kind: "missing" };
  const candidates = index.basename.get(path.posix.basename(normalized)) ?? [];
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return { kind: "resolved", path: candidates[0].relativePath };
  }
  return candidates.length > 1 ? { kind: "ambiguous" } : { kind: "missing" };
}

function formatWikiTarget(original: string, destination: string): string {
  const extension = original.toLocaleLowerCase().endsWith(".md") ? ".md" : "";
  const base = original.includes("/")
    ? stripMarkdown(destination)
    : path.posix.basename(stripMarkdown(destination));
  return `${base}${extension}`;
}

function formatMarkdownTarget(original: string, destination: string, sourcePath: string): string {
  const extension = original.toLocaleLowerCase().endsWith(".md") ? ".md" : "";
  if (original.startsWith("./") || original.startsWith("../")) {
    let relative = path.posix.relative(path.posix.dirname(sourcePath), stripMarkdown(destination));
    if (!relative.startsWith(".")) relative = `./${relative}`;
    return `${relative}${extension}`;
  }
  const base = original.includes("/")
    ? stripMarkdown(destination)
    : path.posix.basename(stripMarkdown(destination));
  return `${base}${extension}`;
}

function stripMarkdown(value: string): string {
  return value.toLocaleLowerCase().endsWith(".md") ? value.slice(0, -3) : value;
}

function splitAnchor(value: string): [string, string] {
  const index = value.indexOf("#");
  return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index)];
}

function splitOnce(value: string, delimiter: string): [string, string | undefined] {
  const index = value.indexOf(delimiter);
  return index === -1
    ? [value, undefined]
    : [value.slice(0, index), value.slice(index + delimiter.length)];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
