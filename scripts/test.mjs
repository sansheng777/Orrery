// Tests for scripts/release-notes.mjs, and the release state of the repository itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import { packageVersions, changelogSection, releaseNotes, TAG } from "./release-notes.mjs";

const CHANGELOG = `# Changelog

## [Unreleased]

### Fixed
- Not released yet.

## [1.2.0] - 2026-02-01

### Added
- Something new.

## [1.1.0] - 2026-01-01

- Older.

[Unreleased]: https://github.com/example/repo/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/example/repo/releases/tag/v1.2.0
`;

// The section of one version, without the next one, the unreleased notes or the link list.
assert.equal(changelogSection(CHANGELOG, "1.2.0"), "### Added\n- Something new.");
assert.equal(changelogSection(CHANGELOG, "1.1.0"), "- Older.");
assert.equal(changelogSection(CHANGELOG, "1.3.0"), null);
assert.equal(changelogSection("## [2.0.0] - 2026-03-01\n\n## [1.0.0] - 2026-01-01\n- x", "2.0.0"), null, "an empty section is no section");

// Notes: the section, then how to install exactly this release.
const notes = releaseNotes({ tag: "v1.2.0", changelog: CHANGELOG, versions: { a: "1.2.0", b: "1.2.0" }, repo: "example/repo" });
assert.ok(notes.startsWith("### Added\n- Something new.\n\n## Install"));
assert.ok(notes.includes("https://github.com/example/repo/releases/download/v1.2.0/install.sh | bash -s -- orrery.example.com"));
assert.ok(notes.includes("gh attestation verify install.sh --repo example/repo"));

// A release that does not add up is refused before anything is built.
assert.throws(() => releaseNotes({ tag: "1.2.0", changelog: CHANGELOG, versions: { a: "1.2.0" }, repo: "r" }), /not a release tag/);
assert.throws(() => releaseNotes({ tag: "v1.2.0", changelog: CHANGELOG, versions: { a: "1.2.0", b: "1.1.0" }, repo: "r" }), /tag says 1\.2\.0, but b is 1\.1\.0.*npm version 1\.2\.0/);
assert.throws(() => releaseNotes({ tag: "v1.3.0", changelog: CHANGELOG, versions: { a: "1.3.0" }, repo: "r" }), /no section "## \[1\.3\.0\]/);
for (const ok of ["v0.1.0", "v1.2.3-rc.1", "v10.20.30"]) assert.ok(TAG.test(ok), ok);
for (const bad of ["v1.2", "v1.2.3.4", "1.2.3", "v1.2.3-", "v1.2.3 ", "v1.2.3;rm"]) assert.ok(!TAG.test(bad), bad);

// The repository: one version everywhere, a changelog section for it, and an installer that the
// release workflow can stamp with the tag.
const versions = packageVersions();
assert.ok(Object.keys(versions).length >= 10, "the root package and every workspace");
assert.equal(new Set(Object.values(versions)).size, 1, `one version for every package: ${JSON.stringify(versions)}`);
const [version] = Object.values(versions);
assert.ok(changelogSection(fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version), `CHANGELOG.md has a section for ${version}`);
const installer = fs.readFileSync(new URL("../deploy/install.sh", import.meta.url), "utf8");
assert.equal(installer.match(/^RELEASE=""$/gm)?.length, 1, 'deploy/install.sh has exactly one RELEASE="" line for the workflow to fill in');

console.log("release test passed");
