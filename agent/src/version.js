// Orrery's version: the "version" in the repository's package.json, which a release is tagged with
// (v0.1.0 for 0.1.0). It is sent to clients at connect and shown where a version helps.
import fs from "node:fs";

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
