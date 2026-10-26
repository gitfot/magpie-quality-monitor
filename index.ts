import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OtherParentError, startMonitor } from "./src/service.ts";
import { installationActive } from "./src/installation.ts";

const root = dirname(fileURLToPath(import.meta.url));
export default {
  id: "quality-monitor",
  async server(
    input: { directory: string },
    options: Record<string, unknown> = {},
  ) {
    const directory = join(homedir(), ".magpie-quality-monitor");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const active = () => installationActive(input.directory, root, options);
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
