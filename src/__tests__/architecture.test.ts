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

// Both guards walk and read every source file. That takes ~175ms alone but
// contends with the rest of the suite for I/O under full-suite parallelism,
// where it has exceeded the 5s default. The work is bounded, so a generous
// timeout removes the flake without hiding a real hang.
describe("extraction-boundary architecture", { timeout: 30_000 }, () => {
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

  // RFC 0001: the dependency direction is src/celld -> src/hub, never the
  // reverse — celld routing composes AROUND the hub (injected at index.ts /
  // server-factory), so the hub stays celld-agnostic and the filesystem path
  // cannot silently grow a celld dependency. The guard above already blocks
  // src/hub from importing ../celld/*; this one blocks any OTHER spelling
  // (deep relative, re-export) by scanning for the directory name itself.
  it("src/hub never references src/celld", () => {
    const hubDir = join(SRC, "hub");
    const offenders = sourceFiles(hubDir).filter(
      (f) => !f.includes("__tests__") && /from\s+["'][^"']*celld/.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  // The domain reducer must stay runtime-portable: it is bundled into the
  // celld Worker, where node: modules are inert stubs at best (RFC 0001,
  // probe 0.5). Web Crypto and structuredClone only.
  it("src/celld/domain and canonical-json import no node: modules", () => {
    const portable = [
      ...sourceFiles(join(SRC, "celld", "domain")),
      join(SRC, "celld", "canonical-json.ts"),
      join(SRC, "celld", "errors.ts"),
    ];
    const offenders = portable.filter(
      (f) => !f.includes("__tests__") && /from\s+["']node:/.test(readFileSync(f, "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
