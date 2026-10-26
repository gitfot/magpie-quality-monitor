import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function target(directory: string, spec: string) {
  if (spec.startsWith("file://")) return fileURLToPath(spec);
  if (isAbsolute(spec) || /^[.\\/]/.test(spec)) return resolve(spec);

  let name: string | undefined;
  try {
    // Magpie retains Git specs in plugins.json; Bun records their package names.
    const dependencies = JSON.parse(
      readFileSync(join(directory, "plugins", "package.json"), "utf8"),
    ).dependencies;
    name = Object.entries(dependencies).find(
      ([, value]) => value === spec,
    )?.[0];
  } catch {}
  if (!name) {
    const version = spec.lastIndexOf("@");
    name = version > 0 ? spec.slice(0, version) : spec;
  }
  if (!packageName.test(name)) throw Error("Unresolved plugin installation");
  return join(directory, "plugins", "node_modules", name);
}

export function installationActive(
  directory: string,
  root: string,
  options: Record<string, unknown> = {},
) {
  try {
    const list = JSON.parse(
      readFileSync(join(directory, "plugins.json"), "utf8"),
    ).plugins;
    if (!Array.isArray(list)) return false;
    const signature = JSON.stringify(options);
    const canonical = (path: string) => {
      const value = realpathSync(path);
      return process.platform === "win32" ? value.toLowerCase() : value;
    };
    const own = canonical(root);
    return list.some((entry) => {
      try {
        return (
          typeof entry.spec === "string" &&
          !entry.off &&
          JSON.stringify(entry.options ?? {}) === signature &&
          canonical(target(directory, entry.spec)) === own
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
