import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixture.ts";

export async function cliFixture(mode = "success") {
  const f = await fixture();
  const dir = join(f.directory, "CLI path with spaces");
  mkdirSync(dir);
  const script = join(dir, "fake.mjs"),
    executable = join(dir, "codex.cmd");
  writeFileSync(
    script,
    `
import {writeFileSync,readFileSync,existsSync,appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const directory=${JSON.stringify(f.directory)}, mode=${JSON.stringify(mode)};
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('codex-cli 0.0.1-fixture');process.exit(0);}
let text='';for await(const chunk of process.stdin) text+=chunk;
writeFileSync(directory+'/received.json',JSON.stringify({args,text,cwd:process.cwd()}));
appendFileSync(directory+'/received.jsonl',JSON.stringify({args,text,cwd:process.cwd()})+'\\n');
const out=e=>console.log(JSON.stringify(e));
out({type:'thread.started',thread_id:'fixture-thread-1'});
if(mode==='tree') {
 const child=spawn(process.execPath,['-e', 'setInterval(()=>{},1000)'],{windowsHide:true,stdio:'inherit'});
 writeFileSync(directory+'/ready.json',JSON.stringify({parent:process.pid,child:child.pid}));
 await new Promise(resolve=>{const t=setInterval(()=>{if(existsSync(directory+'/release')){clearInterval(t);child.kill();resolve();}},10);});
}
if(mode==='invalid') {console.log('not JSON');process.exit(0);}
if(mode==='oversize') {console.log('x'.repeat(9*1024*1024));process.exit(0);}
if(mode==='warning-and-error') {
 console.error('Unknown model group/reasoning is used. This will use fallback model metadata.');
 out({type:'turn.failed',error:{message:'unexpected status 502 Bad Gateway: local fixture did not stream'}});
 process.exit(1);
}
if(mode==='auth'||mode==='model'||mode==='exit') {
 console.error('private-diagnostic fixture-private-key sk-secret-FIXTURE-123456789');
 out({type:'turn.failed',error:{message:mode==='auth'?'401 Unauthorized fixture-private-key':mode==='model'?'model not supported':'failed'}});
 process.exit(7);
}
out({type:'future.event',private:'fixture-private-key'});
out({type:'item.completed',item:{type:'mcp_tool_call',arguments:'fixture-private-key',output:'sk-secret-FIXTURE-123456789'}});
out({type:'item.completed',item:{type:'agent_message',text:'earlier commentary'}});
out({type:'item.completed',item:{type:'agent_message',text:mode==='empty'?'':text.startsWith('Draw')?'<html><body><svg></svg></body></html>':'FINAL_ANSWER: 21'}});
if(mode==='multi-turn')out({type:'turn.completed',usage:{input_tokens:1000,output_tokens:250,cached_input_tokens:500,reasoning_output_tokens:100}});
if(mode!=='incomplete') out({type:'turn.completed',...(mode==='usage-missing'?{}:{usage:{input_tokens:12,output_tokens:7,cached_input_tokens:2,private:'fixture-private-key'}})});
`,
  );
  if (process.platform === "win32")
    writeFileSync(
      executable,
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
  else {
    const { chmodSync } = await import("node:fs");
    writeFileSync(
      executable,
      `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
    );
    chmodSync(executable, 0o700);
  }
  await f.api("settings", "PUT", { retentionDays: 5, codexPath: executable });
  return {
    ...f,
    get app() {
      return f.app;
    },
    executable,
    received: () =>
      JSON.parse(readFileSync(join(f.directory, "received.json"), "utf8")),
    receivedAll: () =>
      readFileSync(join(f.directory, "received.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ready: async () => {
      const deadline = Date.now() + 10000;
      while (!existsSync(join(f.directory, "ready.json"))) {
        if (Date.now() > deadline)
          throw Error("CLI child never reached ready state");
        await Bun.sleep(5);
      }
      return JSON.parse(
        readFileSync(join(f.directory, "ready.json"), "utf8"),
      ) as { parent: number; child: number };
    },
  };
}
