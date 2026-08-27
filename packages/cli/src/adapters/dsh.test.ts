import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshAdapter } from "./dsh";

const originalDshHome = process.env.DSH_HOME;
const originalProfile = process.env.MC_DSH_PROFILE;
const tempDirs: string[] = [];

function freshHome(): string {
    const root = mkdtempSync(join(tmpdir(), "mc-dsh-adapter-"));
    tempDirs.push(root);
    process.env.DSH_HOME = root;
    process.env.MC_DSH_PROFILE = "web";
    return root;
}

afterEach(() => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalDshHome;
    if (originalProfile === undefined) delete process.env.MC_DSH_PROFILE;
    else process.env.MC_DSH_PROFILE = originalProfile;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const okRunner = { runCommand: () => ({ status: 0, stderr: "" }) };

describe("DshAdapter ensurePluginEntry", () => {
    it("creates a fresh profile with base bundles + plugin and patch entries", async () => {
        const root = freshHome();
        const adapter = new DshAdapter(okRunner);
        const result = await adapter.ensurePluginEntry();

        expect(result.ok).toBe(true);
        const manifest = JSON.parse(readFileSync(join(root, "profiles/web/package.json"), "utf8"));
        expect(manifest.dsh.profile.bundles).toEqual([
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-headless",
            "@cortexkit/dsh-magic-context",
        ]);
        const patch = readFileSync(join(root, "profiles/web/cordis.patch.yml"), "utf8");
        expect(patch).toContain("- id: compaction-basic");
        expect(patch).toContain("disabled: true");
        expect(patch).toContain("- id: mc-compaction");
        expect(adapter.hasPluginEntry()).toBe(true);
        expect(adapter.isDefaultCompactionDisabled()).toBe(true);
    });

    it("is idempotent and preserves existing user patch content", async () => {
        const root = freshHome();
        mkdirSync(join(root, "profiles/web"), { recursive: true });
        writeFileSync(
            join(root, "profiles/web/cordis.patch.yml"),
            "# user's own entry\n- id: something-else\n  config:\n    x: 1\n",
        );
        const adapter = new DshAdapter(okRunner);
        await adapter.ensurePluginEntry();
        await adapter.ensurePluginEntry();

        const manifest = JSON.parse(readFileSync(join(root, "profiles/web/package.json"), "utf8"));
        expect(
            manifest.dsh.profile.bundles.filter(
                (b: string) => b === "@cortexkit/dsh-magic-context",
            ),
        ).toHaveLength(1);
        const patch = readFileSync(join(root, "profiles/web/cordis.patch.yml"), "utf8");
        expect(patch).toContain("# user's own entry");
        expect(patch.match(/- id: mc-compaction/g)).toHaveLength(1);
    });

    it("refuses to overwrite a malformed manifest", async () => {
        const root = freshHome();
        mkdirSync(join(root, "profiles/web"), { recursive: true });
        const path = join(root, "profiles/web/package.json");
        const malformed = `{"dsh":{\n`;
        writeFileSync(path, malformed);

        const result = await new DshAdapter(okRunner).ensurePluginEntry();
        expect(result.ok).toBe(false);
        expect(result.message).toContain("Refusing to overwrite unparseable");
        expect(readFileSync(path, "utf8")).toBe(malformed);
    });

    it("reports a plugin install failure without losing the registration", async () => {
        freshHome();
        const failing = { runCommand: () => ({ status: 1, stderr: "pnpm exploded" }) };
        const result = await new DshAdapter(failing).ensurePluginEntry();

        expect(result.ok).toBe(false);
        expect(result.message).toContain("pnpm exploded");
        // manifest + patch were still written (registration precedes install)
        expect(new DshAdapter(okRunner).hasPluginEntry()).toBe(true);
    });
});

describe("DshAdapter removePluginEntry", () => {
    it("removes only the plugin bundle", async () => {
        const root = freshHome();
        const adapter = new DshAdapter(okRunner);
        await adapter.ensurePluginEntry();
        const removed = await adapter.removePluginEntry();

        expect(removed.ok).toBe(true);
        const manifest = JSON.parse(readFileSync(join(root, "profiles/web/package.json"), "utf8"));
        expect(manifest.dsh.profile.bundles).not.toContain("@cortexkit/dsh-magic-context");
    });
});
