// Isolated Chrome/CDP verification; no npm/browser dependency, never opens production data.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { start, readSkillConfig } from "../../src/server.mjs";
import { createFileSettingsEditor } from "../../src/core/settings-editor.mjs";
import { getRuntime, disposeMemoryVec } from "../../src/core/backend.mjs";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-frontend-")),
  out = path.resolve(
    process.env.MV_FRONTEND_ARTIFACTS || path.join(temp, "artifacts"),
  );
fs.mkdirSync(out, { recursive: true });
const chrome =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
let server, registryTarget, child, ws;
const checks = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const service = await start({
    dataRoot: path.join(temp, "data"),
    port: 0,
    settings: {
      ...createFileSettingsEditor(path.join(temp,"data")),
      getSkillConfig: (_, defaults) => ({
        ...defaults,
        autoIndexEnabled: false,
        consolidateEnabled: false,
        embedBaseURL: "",
        embedModel: "",
        ...readSkillConfig(path.join(temp,"data"),'memory-vec',{}),
      }),
    },
  });
  server = service.server;
  const rt = await getRuntime();
  for (let i = 0; !rt.lastIdentityCheck && i < 200; i++) await pause(10);
  rt.normalizer.setVocabulary([
    { id: "qq:10001111", kind: "person", surface: ["Synthetic Person"] },
    { id: "group:10009999", kind: "group", surface: ["Synthetic Room"] },
  ]);
  const call = async (p, body) => {
    const r = await fetch(
      service.url + "/api/vec/" + p,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    const b = await r.json();
    assert.equal(r.status, 200, JSON.stringify(b));
    return b;
  };
  await call("remember", {
    chatKey: "group:10009999",
    userId: "10001111",
    kind: "trait",
    attr: "职业",
    text: "synthetic engineer",
  });
  child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + path.join(temp, "chrome"),
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const active = path.join(temp, "chrome", "DevToolsActivePort");
  for (let i = 0; !fs.existsSync(active) && i < 100; i++) await pause(100);
  const port = fs.readFileSync(active, "utf8").split("\n")[0];
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const pending = new Map(),
    exceptions = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
    if (m.method === "Runtime.exceptionThrown") {
      exceptions.push(
        m.params.exceptionDetails.exception?.description ||
          m.params.exceptionDetails.text,
      );
      console.error("Browser exception:", exceptions.at(-1));
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await pause(80);
    }
    throw Error(
      "Timed out: " +
        expression +
        " BODY: " +
        (await evaluate("document.body.innerText")),
    );
  };
  const navigate = async (suffix) => {
    await cdp("Page.navigate", { url: service.url + suffix });
    await until('document.readyState==="complete"');
  };
  const text = () => evaluate("document.body.innerText");
  const shot = async (name, {fullPage=true}={}) => {
    const r = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    });
    fs.writeFileSync(
      path.join(out, name + ".png"),
      Buffer.from(r.data, "base64"),
    );
  };
  const check = (name, result) => {
    assert.ok(result, name);
    checks.push(name);
  };
  await navigate("/manage.html?demo=1&theme=dark#/people/demo-person");
  await until('!!document.querySelector("[data-edit]")');
  check(
    "multiscope, unknown mapping, long content",
    (await text()).includes("来源场合未识别"),
  );
  check("synthetic banner", (await text()).includes("所有内容均为合成数据"));
  await shot("people-dark");
  await evaluate(
    'document.querySelector("[data-source]").focus();document.querySelector("[data-source]").click()',
  );
  check("no fabricated provenance", (await text()).includes("无法追溯"));
  await evaluate('document.querySelector("#close-dialog").click()');
  check(
    "dialog restores focus to initiating control",
    await evaluate('document.activeElement.hasAttribute("data-source")'),
  );
  await evaluate(
    'document.querySelector("[data-op=replace]").click();document.querySelector("#draft").value="[409] retained draft";document.querySelector("#submit-revision").click()',
  );
  await until('document.querySelector("#reload-revision")?.hidden===false');
  check(
    "409 draft retained",
    await evaluate(
      'document.querySelector("#draft").value.includes("retained draft")',
    ),
  );
  await shot("edit-conflict");
  await evaluate('document.querySelector("#reload-revision").click()');
  await until('!document.querySelector("#draft").disabled');
  check(
    "409 requires explicit reviewed submit",
    await evaluate(
      'document.querySelector("#submit-revision").textContent.includes("已比较")',
    ),
  );
  await evaluate('document.querySelector("#close-dialog").click()');
  await evaluate(
    'document.querySelector("[data-op=replace]").click();document.querySelector("#draft").value="[503] preserved";document.querySelector("#submit-revision").click()',
  );
  await until(
    'document.querySelector("#submit-revision")?.textContent.includes("重试")',
  );
  check(
    "503 draft retained and no success",
    (await text()).includes("尚未确认保存成功"),
  );
  await shot("edit-unavailable");
  await evaluate('document.querySelector("#close-dialog").click()');
  await evaluate(
    'document.querySelector(".policy-details").open=true;document.querySelector("#chat-key").value="group:100";document.querySelector("#policy-form").requestSubmit()',
  );
  await until(
    'document.querySelector("#policy-result").textContent.includes("混合场合")',
  );
  check(
    "server policy blocked counts and mixed sources",
    (await text()).includes("阻止"),
  );
  await shot("policy-comparison");
  await navigate("/manage.html?demo=1&theme=light#/subjects/demo-subject-1");
  await until('document.body.innerText.includes("进度落后")');
  check(
    "conflicting observations remain unclassified",
    (await text()).includes("关系未判定"),
  );
  await shot("subject-light");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  check(
    "960px no horizontal overflow",
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
  );
  await shot("subject-960");
  await navigate("/manage.html?demo=1#/people/demo-empty");
  await until('document.body.innerText.includes("此筛选下没有记忆项目")');
  check("empty person state", true);
  await navigate("/manage.html#/people/10001111");
  await until('!!document.querySelector("[data-edit]")');
  check(
    "real isolated backend read",
    (await text()).includes("synthetic engineer"),
  );
  await evaluate(
    'document.querySelector("[data-op=replace]").click();document.querySelector("#draft").value="synthetic revised profession";document.querySelector("#submit-revision").click()',
  );
  await until(
    'document.querySelector("#write-status")?.textContent.includes("已保存")',
  );
  await evaluate('document.querySelector("#close-dialog").click()');
  await until(
    'document.body.innerText.includes("synthetic revised profession")',
  );
  const real = await call("memory/person?who=10001111");
  check(
    "real isolated revision persisted",
    JSON.stringify(real).includes("synthetic revised profession"),
  );
  await evaluate(
    'document.querySelector("[data-op=hide]").click();document.querySelector("#submit-revision").click()',
  );
  await until(
    'document.querySelector("#write-status")?.textContent.includes("已保存")',
  );
  await evaluate('document.querySelector("#close-dialog").click()');
  await until('!!document.querySelector("#hidden-filter")');
  await evaluate(
    'document.querySelector("#hidden-filter").value="hidden";document.querySelector("#hidden-filter").dispatchEvent(new Event("change"))',
  );
  await until('!!document.querySelector("[data-op=restore]")');
  check("hidden items accessible", true);
  await evaluate(
    'document.querySelector("[data-op=restore]").click();document.querySelector("#submit-revision").click()',
  );
  await until(
    'document.querySelector("#write-status")?.textContent.includes("已保存")',
  );
  await evaluate('document.querySelector("#close-dialog").click()');
  check(
    "restore latest machine projection",
    JSON.stringify(await call("memory/person?who=10001111")).includes(
      "synthetic engineer",
    ),
  );
  await navigate("/manage.html#/subjects");
  await until('!!document.querySelector("#create-subject")');
  await evaluate(
    'document.querySelector("#create-subject").click();document.querySelector("#kind").value="project";document.querySelector("#label").value="Synthetic project";document.querySelector("#subject-write").requestSubmit()',
  );
  await until(
    'document.querySelector("#subject-status")?.textContent.includes("操作成功")',
  );
  await evaluate('document.querySelector("#close-dialog").click()');
  check(
    "real subject registration",
    (await call("subjects")).items.some((s) => s.label === "Synthetic project"),
  );

  const registered = (await call("subjects")).items.find(
    (s) => s.label === "Synthetic project",
  );
  await navigate("/manage.html#/subjects/" + registered.id);
  await until('!!document.querySelector("#aliases")');
  await evaluate(
    'document.querySelector("#aliases").click();document.querySelector("#aliases-value").value="Synthetic alias";document.querySelector("#subject-write").requestSubmit()',
  );
  await until(
    'document.querySelector("#subject-status")?.textContent.includes("操作成功")',
  );
  await evaluate('document.querySelector("#close-dialog").click()');
  check(
    "real alias replacement",
    (await call("subjects/" + registered.id)).subject.aliases.includes(
      "Synthetic alias",
    ),
  );
  const diag = await call("memory/diagnostics");
  const targetSubject = await call("subjects", {
    operationId: "test-merge-target",
    expectedInstanceId: diag.instanceId,
    kind: "project",
    label: "Synthetic target",
    scopeBinding: null,
  });
  await evaluate('document.querySelector("#merge").click()');
  await until('!!document.querySelector("#merge-target")');
  await evaluate('document.querySelector("#subject-write").requestSubmit()');
  await until(
    'document.querySelector("#subject-status")?.textContent.includes("操作成功")',
  );
  check("real merge impact displayed", (await text()).includes("实际影响"));
  await evaluate('document.querySelector("#close-dialog").click()');
  await until('document.querySelector("#unmerge")?.disabled===false');
  await evaluate(
    'document.querySelector("#unmerge").click();document.querySelector("#subject-write").requestSubmit()',
  );
  await until(
    'document.querySelector("#subject-status")?.textContent.includes("操作成功")',
  );
  await evaluate('document.querySelector("#close-dialog").click()');
  check(
    "real unmerge restores subject",
    (await call("subjects/" + registered.id)).subject.status === "active",
  );
  registryTarget = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><html><body>Synthetic registry destination</body></html>",
    );
  });
  await new Promise((r) => registryTarget.listen(0, "127.0.0.1", r));
  const destination = "http://127.0.0.1:" + registryTarget.address().port;
  await navigate("/manage.html?qa=followup#/timeline");
  await until(
    'document.querySelector("#timeline-status")?.textContent.includes("总数")',
  );
  check("real empty timeline route", true);
  await navigate("/manage.html?qa=followup#/diagnostics");
  await until('document.body.innerText.includes("整理诊断")');
  check("real consolidate diagnostics GET", true);
  await navigate("/manage.html?qa=followup#/people/10001111");
  await until('!!document.querySelector("[data-source]")');
  await evaluate('document.querySelector("[data-source]").click()');
  await until(
    'document.querySelector("#evidence-content")?.textContent.includes("来源层级")',
  );
  check("real evidence route response shown", true);
  await shot("real-evidence");
  await evaluate('document.querySelector("#close-dialog").click()');
  // Inject failures and a transport that ignores abort, using synthetic responses only.
  const injected = await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `const nativeFetch=window.fetch.bind(window);window.fetch=async(input,options)=>{const url=String(input);if(url.endsWith('/api/vec/instances'))return new Response(JSON.stringify({ok:true,instances:[{name:'synthetic-target',baseURL:'${destination}',alive:true}],problems:[]}));if(url.includes('memory/person?who=slow-test')){await new Promise(r=>setTimeout(r,300));return new Response(JSON.stringify({ok:true,instanceId:'synthetic-late',person:{labels:['STALE-SYNTHETIC-RESPONSE']},items:[],scopes:[]}));}if(url.includes('/api/vec/person')&&!url.includes('memory/person'))return new Response(JSON.stringify({ok:false,error:'Synthetic unavailable'}),{status:503,headers:{'content-type':'application/json'}});return nativeFetch(input,options);};`,
  });
  await navigate("/manage.html?qa=errors#/people/slow-test");
  await pause(70);
  await evaluate('location.hash="#/people/10001111"');
  await until('document.body.innerText.includes("synthetic engineer")');
  await pause(400);
  check(
    "late person response cannot overwrite new selection",
    !(await text()).includes("STALE-SYNTHETIC-RESPONSE"),
  );
  await evaluate('location.hash="#/people"');
  await until('!!document.querySelector("#retry")');
  check(
    "API error has retry state",
    (await text()).includes("Synthetic unavailable"),
  );
  await shot("api-error");
  await evaluate('location.hash="#/people/slow-test"');
  await pause(70);
  await evaluate('location.hash="#/instances"');
  await until('!!document.querySelector("[data-instance]")');
  await evaluate('document.querySelector("[data-instance]").click()');
  await until(
    'document.body.innerText.includes("Synthetic registry destination")',
  );
  await pause(400);
  check(
    "registry instance switch is full origin navigation and ignores old response",
    (await evaluate("location.origin")) === destination &&
      !(await text()).includes("STALE-SYNTHETIC-RESPONSE"),
  );
  await cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: injected.identifier,
  });
  for (const url of [
    "/person.html?who=10001111&with=10002222&kinds=trait",
    "/memory.html",
    "/working.html",
    "/instances.html",
    "/",
  ]) {
    await navigate(url);
    check(
      "legacy loads " + url,
      await evaluate('!!document.querySelector("#manage-entry")'),
    );
  }
  // Same-origin graph iframe and its real host-style theme message convention.
  await navigate("/manage.html#/graph");
  await until(
    '!!document.querySelector("iframe")?.contentDocument?.querySelector("canvas")',
  );
  check("graph iframe preserved", true);
  await evaluate(
    'document.querySelector("#theme").value="light";document.querySelector("#theme").dispatchEvent(new Event("change"))',
  );
  await until(
    'document.querySelector("iframe").contentDocument.documentElement.dataset.theme==="light"',
  );
  check("theme forwarded to graph iframe", true);
  // Parent fixture emulates host postMessage from a distinct, actual parent window.
  await navigate("/manage.html?demo=1#/overview");
  await until('!!document.querySelector("nav a")');
  await evaluate(
    `document.body.innerHTML='<iframe id="host-frame" src="/manage.html?demo=1&theme=dark#/people/demo-person"></iframe>'`,
  );
  await until(
    'document.querySelector("iframe").contentDocument?.querySelector("[data-edit]")',
  );
  await evaluate(
    'document.querySelector("iframe").contentWindow.localStorage.removeItem("memory-manage-theme");document.querySelector("iframe").contentDocument.querySelector("#theme").value="auto";document.querySelector("iframe").contentWindow.postMessage({type:"mv-theme",theme:"light"},location.origin)',
  );
  await until(
    'document.querySelector("iframe").contentDocument.documentElement.dataset.theme==="light"',
  );
  check("host iframe parent theme accepted", true);
  await (
    await import("./final-checks.mjs")
  ).finalChecks({
    evaluate,
    until,
    navigate,
    check,
    cdp,
    shot,
    rt,
    temp,
    call,
    service,
  });
  await (await import('./compact-person.mjs')).compactPersonChecks({evaluate,until,navigate,check,cdp,shot,call});
  await (await import('./settings-page.mjs')).settingsPageChecks({evaluate,until,navigate,check,cdp,shot,call});
  check("no uncaught browser exceptions", exceptions.length === 0);
  fs.writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify(
      { checks, exceptions, realBackend: "isolated temporary data only" },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, artifacts: out, checks }, null, 2),
  );
} finally {
  ws?.close();
  if (child) {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
  if (registryTarget) await new Promise((r) => registryTarget.close(r));
  if (server) await new Promise((r) => server.close(r));
  disposeMemoryVec();
  await pause(200);
  if (
    path.dirname(temp) === path.resolve(os.tmpdir()) &&
    path.basename(temp).startsWith("mv-frontend-")
  )
    fs.rmSync(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
}
