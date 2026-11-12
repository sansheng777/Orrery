// The notes of a GitHub release, from CHANGELOG.md, and the checks that keep a release consistent:
//   node scripts/release-notes.mjs v1.2.3 > notes.md
// It fails unless the tag is a version tag, every package.json carries that version, and CHANGELOG.md
// has a section for it. The release workflow runs it before anything is built.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

// name -> version of the root package and every workspace.
export function packageVersions(root = ROOT) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const top = read("package.json");
  const versions = { [top.name]: top.version };
  for (const pattern of top.workspaces || []) {
    const dirs = pattern.endsWith("/*") ? fs.readdirSync(path.join(root, pattern.slice(0, -2))).map((d) => `${pattern.slice(0, -2)}/${d}`) : [pattern];
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(root, dir, "package.json"))) continue;
      const pkg = read(`${dir}/package.json`);
      versions[pkg.name] = pkg.version;
    }
  }
  return versions;
}

// The text under "## [1.2.3] - YYYY-MM-DD", up to the next heading of that level or the link list.
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}] - `));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && (l.startsWith("## ") || /^\[[^\]]+\]: /.test(l)));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim() || null;
}

export function releaseNotes({ tag, changelog, versions, repo }) {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`"${tag}" is not a release tag such as v1.2.3 or v1.2.3-rc.1`);
  const version = m[1];
  const off = Object.entries(versions).filter(([, v]) => v !== version);
  if (off.length) throw new Error(`The tag says ${version}, but ${off.map(([name, v]) => `${name} is ${v}`).join(", ")}. Run: npm version ${version} --workspaces --include-workspace-root --no-git-tag-version`);
  const body = changelogSection(changelog, version);
  if (!body) throw new Error(`CHANGELOG.md has no section "## [${version}] - YYYY-MM-DD" with notes in it`);
  return `${body}

## Install

On a fresh Debian or Ubuntu VPS, as root, with a hostname on a domain you have on Cloudflare:

\`\`\`bash
curl -fsSL https://github.com/${repo}/releases/download/${tag}/install.sh | bash -s -- orrery.example.com
\`\`\`

Already running Orrery? The same line without the hostname updates it to this release. Every step, and the setup by hand: [docs/deploy.md](https://github.com/${repo}/blob/${tag}/docs/deploy.md).

The files of this release and its image carry build provenance from GitHub Actions. Check one with \`gh attestation verify install.sh --repo ${repo}\`, or compare it with \`SHA256SUMS\`.
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    const repo = process.env.GITHUB_REPOSITORY || "sansheng777/Orrery";
    process.stdout.write(releaseNotes({ tag: process.argv[2] || "", changelog, versions: packageVersions(), repo }));
  } catch (e) {
    console.error(`Not releasing: ${e.message}`);
    process.exit(1);
  }
}
