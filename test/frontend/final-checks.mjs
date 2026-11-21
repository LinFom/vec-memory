export async function finalChecks({
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
}) {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const { consolidatePaths, runConsolidate } =
    await import("../../src/core/consolidate.mjs");
  const { factStoreOf, getRuntime } =
    await import("../../src/core/backend.mjs");
  rt = await getRuntime();
  rt.normalizer.setVocabulary([
    { id: "qq:10001111", kind: "person", surface: ["Synthetic Person"] },
    { id: "group:10009999", kind: "group", surface: ["Synthetic Room"] },
  ]);
  const p = consolidatePaths(rt.dir);
  fs.mkdirSync(p.base, { recursive: true });
  const rows = ["a", "b", "c"].map((id) => ({
    id,
    windowId: "w",
    chatKey: "group:10009999",
    title: "PAGE-" + id,
    summary: "synthetic",
    fromTs: 1000,
    toTs: 2000,
    hits: 0,
  }));
  rows.push({
    id: "other",
    windowId: "other",
    chatKey: "group:other",
    title: "FILTER-ONLY",
    fromTs: 1000,
    toTs: 2000,
    hits: 0,
  });
  fs.writeFileSync(
    p.events,
    rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  const expectedCursor = (
    await call("memory/events?chatKey=group%3A10009999&limit=2")
  ).nextCursor;
  const requestLog = [];
  await cdp("Network.enable");
  // Observe actual requests without replacing real pagination responses.
  const observer = await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.qaRequests=[];const f=fetch.bind(window);window.fetch=(u,o)=>{window.qaRequests.push({url:String(u),method:o?.method||'GET'});return f(u,o);}`,
  });
  await navigate("/manage.html?qa=final-real#/timeline");
  await until(
    'document.querySelector("#timeline-status")?.textContent.includes("总数")',
  );
  await evaluate(
    `document.querySelector('[name=limit]').value=2;document.querySelector('[name=chatKey]').value='group:10009999';document.querySelector('#timeline-filter').requestSubmit()`,
  );
  await until(
    'document.querySelectorAll("#timeline-items article").length===2',
  );
  await evaluate(`document.querySelector('#timeline-more').click()`);
  await until(
    'document.querySelectorAll("#timeline-items article").length===3',
  );
  check(
    "exact server nextCursor used",
    await evaluate(
      `qaRequests.some(x=>new URL(x.url).searchParams.get('cursor')===${JSON.stringify(expectedCursor)})`,
    ),
  );
  check(
    "real same timestamp pagination complete and unique",
    await evaluate(
      `new Set([...document.querySelectorAll('#timeline-items h3')].map(x=>x.textContent)).size===3&&qaRequests.some(x=>new URL(x.url).searchParams.has('cursor'))`,
    ),
  );
  await evaluate(
    `document.querySelector('[name=chatKey]').value='group:other';document.querySelector('#timeline-filter').requestSubmit()`,
  );
  await until(
    'document.querySelector("#timeline-items").textContent.includes("FILTER-ONLY")',
  );
  check(
    "filter reset removes old items and cursor",
    await evaluate(
      `!document.querySelector('#timeline-items').textContent.includes('PAGE-')&&!new URL(qaRequests.at(-1).url).searchParams.has('cursor')`,
    ),
  );
  await cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: observer.identifier,
  });
  // Real archive identity rejection through the UI, with a real consolidated window reference.
  const base = 1800000000000,
    ev = path.join(temp, "data", "memory");
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(
    path.join(ev, "evidence.jsonl"),
    Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        at: base + i * 1000,
        chatKey: "group:10009999",
        id: "m" + i,
        speakerId: "10001111",
        speakerName: "Synthetic Person",
        text: "synthetic guitar",
      }),
    ).join("\n") + "\n",
  );
  await runConsolidate(
    {
      sourceRoot: path.join(temp, "data"),
      libDir: rt.dir,
      settings: {
        consolidateWindowMsgs: 20,
        consolidateSettleMin: 0,
        consolidateWindowSpanMin: 120,
        maxChars: 1200,
      },
      normalizer: rt.normalizer,
      factStore: factStoreOf(rt),
      store: null,
      callLlm: async () =>
        JSON.stringify({
          events: [],
          people: [
            { qq: "10001111", kind: "trait", attr: "爱好", text: "guitar" },
          ],
        }),
    },
    { now: base + 600000 },
  );
  const archive = path.join(temp, "data", "messages");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(
    path.join(archive, "group_10009999.json"),
    JSON.stringify({
      chatKey: "private:other",
      messages: [{ id: "m1", ts: base + 1000, text: "REJECTED-SECRET" }],
    }),
  );
  const fixtureSlot = [...factStoreOf(rt).slots.values()].find((x) =>
    JSON.stringify(x.content).includes("guitar"),
  );
  if (!fixtureSlot) throw Error("consolidation fixture missing");
  const fixtureItem = {
    key: fixtureSlot.key,
    itemKey: fixtureSlot.content.items?.[0]?.k ?? null,
    value: "guitar",
    scope: fixtureSlot.scope,
    editable: false,
    kind: "trait",
  };
  const personFixture = await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `const sourceFetch=fetch.bind(window);window.fetch=(u,o)=>String(u).includes('memory/person?')?Promise.resolve(new Response(JSON.stringify({ok:true,person:{labels:['Synthetic source fixture']},scopes:[],items:[${JSON.stringify(fixtureItem)}]}))):sourceFetch(u,o);`,
  });
  await navigate("/manage.html?qa=archive#/people/fixture");
  await until('!!document.querySelector("[data-source]")');
  await evaluate(`document.querySelector('[data-source]').click()`);
  await until('!!document.querySelector("#load-source")');
  await evaluate(`document.querySelector('#load-source').click()`);
  await until(
    'document.querySelector("#evidence-content").textContent.includes("unavailable")',
  );
  check(
    "real archive content mismatch never leaks text",
    await evaluate(`!document.body.textContent.includes('REJECTED-SECRET')`),
  );
  await evaluate(`document.querySelector('#close-dialog').click()`);
  const inject = await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.qaRequests=[];window.qaScenario='normal';window.qaCount=0;const real=fetch.bind(window);window.fetch=async(u,o)=>{const url=new URL(u);qaRequests.push({url:String(u),method:o?.method||'GET'});let body,status=200;if(url.pathname.endsWith('/memory/events')){if(url.searchParams.has('cursor')&&['409','400'].includes(qaScenario)){status=Number(qaScenario);body={ok:false,error:'重新加载快照',code:status===409?'SNAPSHOT_CHANGED':'INVALID_CURSOR'};}else {const chat=url.searchParams.get('chatKey');if(chat==='slow')await new Promise(r=>setTimeout(r,300));body={ok:true,items:[{id:chat||'first',title:chat||'FIRST',state:'working'}],total:2,stateCounts:{working:2},snapshotId:'snapshot',nextCursor:chat?null:'SERVER-CURSOR'};}}else if(url.pathname.endsWith('/facts/evidence')){const mode=qaScenario;if(mode==='error'&&qaCount++===0){status=503;body={ok:false,error:'SYNTHETIC-503'};}else{body={ok:true,level:mode==='item'?'item':'slot',state:mode==='item'?'exact':'window-match',references:mode==='multi'?[{type:'window',chatKey:'group:1'},{type:'window',chatKey:'group:2'}]:mode==='missing'?[{type:'window'}]:[{type:'window',chatKey:'group:1',resolved:true}],unresolved:[]};if(url.searchParams.has('withSource'))body.sourceLookup={note:'按时间区间重新取回，不保证当时批次',sources:[{status:['expired','unavailable'].includes(mode)?mode:'found',truncated:true,reason:'synthetic',messages:[{text:'SYNTHETIC-SOURCE'}]}]};}}else if(url.pathname.endsWith('/consolidate')){if(qaScenario==='error'){status=503;body={ok:false,error:'diagnostic unavailable'};}else body={ok:true,enabled:true,running:false,llmConfigured:false,lastConsolidate:qaScenario==='null'?null:{ok:true,degraded:{code:'EVIDENCE_MISSING'}}};}if(body)return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});return real(u,o);};`,
  });
  await navigate("/manage.html?qa=faults#/timeline");
  await until(
    'document.querySelector("#timeline-items").textContent.includes("FIRST")',
  );
  for (const mode of ["409", "400"]) {
    await evaluate(
      `qaScenario='${mode}';document.querySelector('#timeline-more').click()`,
    );
    await until('!!document.querySelector("#timeline-reload")');
    const n = await evaluate("qaRequests.length");
    await new Promise((r) => setTimeout(r, 100));
    check(
      mode + " clears old list and stops automatic requests",
      await evaluate(
        `document.querySelector('#timeline-items').textContent===''&&qaRequests.length===${n}`,
      ),
    );
    await evaluate(`document.querySelector('#timeline-reload').click()`);
    await until(
      'document.querySelector("#timeline-items").textContent.includes("FIRST")',
    );
    check(
      mode + " reload starts without cursor",
      await evaluate(
        `!new URL(qaRequests.at(-1).url).searchParams.has('cursor')`,
      ),
    );
  }
  await evaluate(
    `document.querySelector('[name=chatKey]').value='slow';document.querySelector('#timeline-filter').requestSubmit()`,
  );
  await new Promise((r) => setTimeout(r, 50));
  await evaluate(
    `document.querySelector('[name=chatKey]').value='new';document.querySelector('#timeline-filter').requestSubmit()`,
  );
  await until(
    'document.querySelector("#timeline-items").textContent.includes("new")',
  );
  await new Promise((r) => setTimeout(r, 350));
  check(
    "late old timeline filter cannot replace new list",
    await evaluate(
      `!document.querySelector('#timeline-items').textContent.includes('slow')`,
    ),
  );
  await evaluate(
    `location.hash='#/people/${encodeURIComponent(fixtureSlot.speaker)}'`,
  );
  await until('!!document.querySelector("[data-source]")');
  for (const mode of [
    "multi",
    "missing",
    "expired",
    "unavailable",
    "item",
    "normal",
    "error",
  ]) {
    const sourceStart = await evaluate("qaRequests.length");
    await evaluate(
      `qaScenario='${mode}';qaCount=0;document.querySelector('[data-source]').click()`,
    );
    if (mode === "error") {
      await until('!!document.querySelector("#retry-evidence")');
      await evaluate(`document.querySelector('#retry-evidence').click()`);
    }
    await until('!!document.querySelector("#load-source")');
    if (["multi", "missing"].includes(mode)) {
      check(
        mode + " disables original source request",
        await evaluate(
          `document.querySelector('#load-source').disabled&&!qaRequests.slice(${sourceStart}).some(x=>x.url.includes('withSource'))`,
        ),
      );
    } else {
      check(
        mode + " no source before explicit click",
        await evaluate(
          `!new URL(qaRequests.at(-1).url).searchParams.has('withSource')`,
        ),
      );
      await evaluate(`document.querySelector('#load-source').click()`);
      await until(
        'document.querySelector("#evidence-content").textContent.includes("truncated")',
      );
      check(
        mode + " source status and granularity",
        await evaluate(
          `document.querySelector('#evidence-content').textContent.includes('${mode === "item" ? "item · 状态：exact" : "slot · 状态：window-match"}')&&${["expired", "unavailable"].includes(mode) ? "!document.querySelector('#evidence-content').textContent.includes('SYNTHETIC-SOURCE')" : "document.querySelector('#evidence-content').textContent.includes('SYNTHETIC-SOURCE')"}`,
        ),
      );
      if (mode === "error")
        check(
          "retry keeps exact source address",
          await evaluate(
            `(()=>{const a=qaRequests.filter(x=>x.url.includes('facts/evidence')&&!x.url.includes('withSource'));return a.at(-1).url===a.at(-2).url})()`,
          ),
        );
    }
    await evaluate(`document.querySelector('#close-dialog').click()`);
  }
  for (const mode of ["normal", "null", "error"]) {
    await evaluate(`qaScenario='${mode}';location.hash='#/diagnostics'`);
    await until(
      'document.body.textContent.includes("整理诊断")||document.body.textContent.includes("diagnostic unavailable")',
    );
    check(
      "diagnostic " + mode,
      await evaluate(
        `document.body.textContent.includes('${mode === "normal" ? "部分工作暂停" : mode === "null" ? "暂无记录" : "实例"}')`,
      ),
    );
    await evaluate(`location.hash='#/working'`);
    await until('document.body.textContent.includes("工作记忆状态")');
  }
  check(
    "diagnostics never POST",
    await evaluate(
      `qaRequests.filter(x=>x.url.endsWith('/consolidate')).every(x=>x.method==='GET')`,
    ),
  );
  await shot("final-diagnostics");
  await cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: inject.identifier,
  });
  await cdp("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: personFixture.identifier,
  });
  await navigate("/manage.html?demo=1&scenario=modern#/timeline");
  await until('document.body.textContent.includes("合成事件 A")');
  check(
    "modern demo nonempty timeline and banner",
    await evaluate('!document.querySelector("#demo").hidden'),
  );
  await navigate("/manage.html?demo=1&scenario=modern#/diagnostics");
  await until('document.body.textContent.includes("部分工作暂停")');
  check("modern demo degraded diagnostic", true);
  await navigate("/manage.html?demo=1&scenario=modern#/people/demo-person");
  await until('!!document.querySelector("[data-source]")');
  await evaluate('document.querySelector("[data-source]").click()');
  await until('!!document.querySelector("#load-source")');
  check("modern demo evidence", true);
  await shot("modern-demo-source");
  await evaluate('document.querySelector("#close-dialog").click()');
}
