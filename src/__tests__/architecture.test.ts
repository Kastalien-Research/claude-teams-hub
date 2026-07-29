/**
 * Architecture guards for the extraction boundary.
 *
 * The upstream Thoughtbox version of this test held a knownDebt list of files
 * allowed to import SupabaseClient. The extraction deleted every Supabase
 * surface, so the guard inverts: nothing may import @supabase at all. The
 * second guard pins the property the extraction was designed around — the hub
 * is nearly free-standing, importing outside its own directory only the
 * persistence types module (plus node/SDK builtins) — so a future change that
 * couples the hub to another subsystem fails here first, by name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("extraction-boundary architecture", () => {
  it("no file imports @supabase", () => {
    const offenders = sourceFiles(SRC).filter((f) =>
      /from\s+["']@supabase/.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("src/hub imports outside itself only from persistence types", () => {
    const hubDir = join(SRC, "hub");
    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const f of sourceFiles(hubDir)) {
      if (f.includes("__tests__")) continue;
      const source = readFileSync(f, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.\.\/[^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier !== "../persistence/types.js") {
          offenders.push({ file: f.slice(SRC.length + 1), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
