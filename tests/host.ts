import { existsSync } from "node:fs";
import { startMonitor } from "../src/service.ts";
const directory = process.argv[2];
console.log("waiting");
while (!existsSync(directory + "/start")) await Bun.sleep(10);
const app = await startMonitor({ directory, timers: false });
console.log(JSON.stringify({ url: app.url, token: app.token }));
for await (const _ of Bun.stdin.stream()) {
  await app.close();
  break;
}
