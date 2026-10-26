// Development-only preview against a local mock. Never uses a live Magpie key.
import { fixture } from "../tests/fixture.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
const f = await fixture((body) => ({
  text: String(body.messages[0].content).includes("Draw")
    ? '<!doctype html><html><body style="margin:0;background:#e6ebd9"><svg viewBox="0 0 600 360" xmlns="http://www.w3.org/2000/svg"><circle cx="460" cy="95" r="45" fill="#d9955f"/><path d="M0 270L165 90 340 270 460 150 600 280V360H0" fill="#9db2a0"/><path d="M0 320L190 200 380 310 500 245 600 330V360H0" fill="#547b6b"/><path d="M0 300Q270 350 600 290" stroke="#ececd9" stroke-width="12" fill="none"/><rect x="240" y="275" width="150" height="40" rx="7" fill="#d9955f"/><rect x="255" y="282" width="110" height="14" fill="#eeeeda"/><text x="24" y="38" fill="#527565" font-size="18">THE SLOW JOURNEY</text></svg></body></html>'
    : String(body.messages[0].content).includes("Bridge")
      ? "FINAL_ANSWER: 20"
      : "Reasoning completed.\nFINAL_ANSWER: 21",
}));
const object = await f.object({
  name: "主力编码模型",
  effort: "high",
  tests: [
    {
      kind: "logic",
      name: "糖果配对问题",
      prompt: "Solve the candy problem.",
      answers: ["21"],
    },
    {
      kind: "logic",
      name: "过桥最短时间",
      prompt: "Bridge problem",
      answers: ["17"],
    },
    { kind: "drawing", name: "山间列车", prompt: "Draw an alpine railway" },
  ],
});
if (process.env.MONITOR_PREVIEW_HISTORY) {
  f.setNow(f.now - 82 * 30 * 60000);
  await f.api("objects/" + object.id + "/run", "POST", {});
  await f.app.idle();
  await f.api("objects/" + object.id, "PUT", {
    ...object,
    name: "主力编码模型 · v2",
  });
}
for (let i = 0; i < (process.env.MONITOR_PREVIEW_HISTORY ? 82 : 1); i++) {
  await f.api("objects/" + object.id + "/run", "POST", {});
  await f.app.idle();
  if (process.env.MONITOR_PREVIEW_HISTORY) f.setNow(f.now + 30 * 60000);
}
// Development-only parent emulates Magpie's documented hello/theme messages.
const shell = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html><meta charset="utf-8"><style>body{margin:0;font:14px sans-serif}header{padding:8px}iframe{border:0;width:100%;height:calc(100vh - 42px)}</style><header><label>Language <select id="language"><option>zh</option><option>en</option><option>zh-TW</option><option>ja</option><option>de</option></select></label> <label>Theme <select id="theme"><option>light</option><option>dark</option><option>custom</option></select></label> · LOCAL MOCK DATA</header><iframe title="Monitor preview" id="monitor" sandbox="allow-scripts" src="${f.app.url}/#${f.app.token}"></iframe><script>const frame=document.getElementById('monitor'),select=document.getElementById('language'),theme=document.getElementById('theme');const appearance=()=>({lang:select.value,dark:theme.value==='dark',tokens:theme.value==='custom'?{bg:'#eef3f7',card:'#ffffff',accent:'#0073aa'}:{}});addEventListener('message',e=>{if(e.source===frame.contentWindow&&e.data?.method==='hello')frame.contentWindow.postMessage({magpie:1,id:e.data.id,result:appearance()},'*')});const push=()=>frame.contentWindow.postMessage({magpie:1,event:'theme',data:appearance()},'*');select.onchange=push;theme.onchange=push;</script></html>`,
  );
});
await new Promise<void>((r) => shell.listen(0, "127.0.0.1", r));
const shellURL = `http://127.0.0.1:${(shell.address() as { port: number }).port}`;
mkdirSync(".test-artifacts", { recursive: true });
writeFileSync(
  ".test-artifacts/preview.json",
  JSON.stringify({
    url: f.app.url + "/#" + f.app.token,
    shellURL,
    directory: f.directory,
    pid: process.pid,
  }),
);
console.log("MOCK ONLY preview:", f.app.url + "/#" + f.app.token);
console.log("Mock parent/language checks:", shellURL);
process.on("SIGINT", async () => {
  shell.closeAllConnections();
  shell.close();
  await f.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  shell.closeAllConnections();
  shell.close();
  await f.close();
  process.exit(0);
});
