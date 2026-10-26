import { readFileSync, realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OtherParentError, startMonitor } from "./src/service.ts";

const root = dirname(fileURLToPath(import.meta.url));
export default {
  id: "quality-monitor",
  async server(
    input: { directory: string },
    options: Record<string, unknown> = {},
  ) {
    const directory = join(homedir(), ".magpie-quality-monitor");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const signature = JSON.stringify(options);
    const active = () => {
      try {
        const list = JSON.parse(
          readFileSync(join(input.directory, "plugins.json"), "utf8"),
        ).plugins;
        return list.some(
          (entry: { spec: string; off?: boolean; options?: unknown }) => {
            let own =
              entry.spec === "magpie-quality-monitor" ||
              entry.spec.startsWith("magpie-quality-monitor@");
            if (!own)
              try {
                own =
                  realpathSync(resolve(entry.spec)).toLowerCase() ===
                  realpathSync(root).toLowerCase();
              } catch {}
            return (
              own &&
              !entry.off &&
              JSON.stringify(entry.options ?? {}) === signature
            );
          },
        );
      } catch {
        return false;
      }
    };
    const launch = async (): Promise<void> => {
      if (!active()) return;
      try {
        await startMonitor({
          directory,
          pageDirectory: join(root, "page"),
          active,
          respectOtherParents: true,
        });
      } catch (e) {
        if (!(e instanceof OtherParentError)) throw e;
        // CLI hosts must not steal an active gateway. A persistent host retries
        // so that a CLI winning a cold start cannot strand the monitor.
        setTimeout(
          () =>
            void launch().catch(() =>
              console.error(
                "Quality monitor startup failed; reload the plugin",
              ),
            ),
          2000,
        ).unref();
      }
    };
    await launch();
    return {};
  },
};
