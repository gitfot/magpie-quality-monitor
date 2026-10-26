import { pathToFileURL } from "node:url";

const { default: plugin } = await import(pathToFileURL(process.argv[2]).href);
await plugin.server({ directory: process.argv[3] });
console.log("entry-returned");
for await (const _ of Bun.stdin.stream()) break;
