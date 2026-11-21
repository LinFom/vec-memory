import { MemoryApi, operationId } from "./manage-api.js";
const $ = (s) => document.querySelector(s),
  esc = (v) =>
    String(v ?? "未提供").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const query = new URLSearchParams(location.search),
  demo = query.get("demo") === "1";
const api = demo
  ? (await import("./manage-demo.js")).createDemoApi({
      modern: query.get("scenario") === "modern",
    })
  : new MemoryApi();
let diagnostic = null,
  diagnosticError = null,
  epoch = 0,
  person = null,
  selectedSubject = null;
let peopleQuery = "", directoryScroll = 0;
const names = {
  overview: "概览",
  people: "人物记忆",
  timeline: "事件时间线",
  working: "工作记忆",
  subjects: "主体管理",
  graph: "关系星图",
  instances: "实例",
  diagnostics: "诊断",
  settings: "设置",
};
const stateLabels = {
  total: "全部", working: "短期保留", pending: "待处理", promoted: "已转长期",
  dimmed: "已淡化", retired: "已回收", fresh: "未排练",
};
function stateSummary(counts) {
  const entries = Object.entries(counts || {});
  return entries.length ? entries.map(([key, count]) => tag((stateLabels[key] || key) + " " + count)).join(" ") : empty("暂无状态统计");
}
function localTime(ms) {
  return ms == null ? "时间未提供" : new Date(ms).toLocaleString("zh-CN", {hour12:false});
}
const kinds = {
  group: "群",
  work: "作品",
  project: "项目",
  object: "物品",
  case: "事件对象",
  concept: "概念",
};
const factKinds = {trait:"档案",speaker_profile:"画像",event:"事件",topic:"话题",promise:"承诺",joke:"梗",preference:"偏好",grudge:"芥蒂",pattern:"模式"};
const main = $("#main"),
  dialog = $("#dialog");
$("#demo").hidden = !demo;
function theme(value) {
  document.documentElement.dataset.theme = value;
  document
    .querySelector("iframe")
    ?.contentWindow?.postMessage(
      { type: "mv-theme", theme: value },
      location.origin,
    );
}
let inherited =
  query.get("theme") ||
  (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
$("#theme").value = localStorage.getItem("memory-manage-theme") || "auto";
function applyTheme() {
  theme($("#theme").value === "auto" ? inherited : $("#theme").value);
}
$("#theme").onchange = () => {
  localStorage.setItem("memory-manage-theme", $("#theme").value);
  applyTheme();
};
applyTheme();
addEventListener("message", (e) => {
  if (
    e.source !== parent ||
    parent === window ||
    e.data?.type !== "mv-theme" ||
    !["light", "dark"].includes(e.data.theme)
  )
    return;
  let origin;
  try {
    origin = new URL(document.referrer).origin;
  } catch {}
  if (origin && e.origin !== origin) return;
  inherited = e.data.theme;
  applyTheme();
});
matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
  inherited = e.matches ? "light" : "dark";
  applyTheme();
});
function href(route) {
  return "#/" + route;
}
function heading(title, description = "") {
  main.innerHTML = `<h1>${esc(title)}</h1><p class="lead">${esc(description)}</p><div id="content" aria-live="polite"></div>`;
  return $("#content");
}
function error(e) {
  return `<div class="card error" role="alert">${esc(e.message)}${e.status ? ` · HTTP ${e.status}` : ""}</div>`;
}
function empty(text = "暂无记录") {
  return `<div class="card empty">${esc(text)}</div>`;
}
function json(value) {
  return `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;
}
function tag(text) {
  return `<span class="tag">${esc(text)}</span>`;
}
function capability(name) {
  return diagnostic?.capabilities?.includes(name);
}
function modal(html) {
  const previous = document.activeElement;
  dialog.innerHTML = `<div id="dialog-body">${html}</div><div class="actions"><button id="close-dialog">关闭</button></div>`;
  dialog.showModal();
  $("#close-dialog").onclick = () => dialog.close();
  dialog.addEventListener(
    "close",
    () => (previous?.isConnected ? previous.focus() : main.focus()),
    { once: true },
  );
}
function routeTo(route) {
  location.hash = href(route);
}
async function boot() {
  try {
    diagnostic = await api.get("memory/diagnostics", "diagnostic");
    diagnosticError = null;
    $("#instance").textContent = diagnostic.instanceId;
  } catch (e) {
    diagnosticError = e;
    $("#instance").textContent = "实例连接失败";
  }
  await render();
}
async function render() {
  if($(".people-directory")) directoryScroll=$(".people-directory").scrollTop;
  api.cancel();
  const current = ++epoch;
  const parts = (location.hash.slice(2) || "overview").split("/"),
    route = parts[0];
  person = null;
  selectedSubject = null;
  $("nav").innerHTML = Object.entries(names)
    .map(
      ([id, label]) =>
        `<a href="${href(id)}" ${route === id ? 'aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  const content = heading(
    names[route] || "页面不存在",
    ({
      overview: "选择要查的人物、事件或场合。",
      timeline: "按会话和本地日期查看事件。",
      working: "选择一个会话，查看其中的短期记录。",
      subjects: "查找群、项目或作品，核对相关观察。",
      instances: "查看各账号的记忆服务并切换实例。",
      settings: "配置当前连接的记忆服务，只保存修改项。",
    })[route] || "",
  );
  main.classList.toggle("people-page", route === "people");
  if (route === "people") $(".lead").remove();
  content.innerHTML = '<div class="card muted">正在加载…</div>';
  const live = () => current === epoch;
  try {
    if (diagnosticError && ["people", "subjects"].includes(route)) {
      content.innerHTML =
        error(diagnosticError) +
        "<button id=retry-connection>重新连接实例</button>";
      $("#retry-connection").onclick = boot;
      return;
    }
    if (route === "overview") {
      const [people, subjects, working] = await Promise.all([
        api.get("person"),
        api.get("subjects"),
        api.get("working"),
      ]);
      if (!live()) return;
      content.innerHTML = `<div class="grid">${[
        ["已知人物", people.people?.length, "people"],
        ["已登记主体", subjects.items?.length, "subjects"],
        ["有工作记忆的场合", working.chats?.length, "working"],
      ]
        .map(
          ([title, count, url]) =>
            `<a class="card list-link" href="${href(url)}"><div>${title}</div><div class="metric">${count ?? "未提供"}</div></a>`,
        )
        .join(
          "",
        )}</div><div class="card"><h2>查最近发生的事</h2><p>按日期翻事件，或进入工作记忆查看某个会话。</p><a href="#/timeline">打开事件时间线 →</a></div><div class="card"><h2>服务状态</h2>${tag(diagnostic?.storage?.readOnly ? "存储只读" : "存储状态见诊断")}${tag(diagnostic?.vectors?.mode ?? "向量模式未提供")}<p><a href="#/diagnostics">查看实例诊断</a></p></div>`;
    } else if (route === "people") {
      await renderPeople(parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : null, content, live);
    } else if (route === "subjects" && !parts[1]) {
      await subjects(content, live);
    } else if (route === "subjects") {
      await subjectDetail(decodeURIComponent(parts[1]), content, live);
    } else if (route === "timeline") {
      await timeline(content, live);
    } else if (route === "working") {
      const data = await api.get("working");
      if (!live()) return;
      content.innerHTML = `<div class="card"><h2>工作记忆状态</h2>${stateSummary(data.counts)}</div><div class="grid">${(data.chats || []).map((c) => `<div class="card"><h3>${esc(c.chatLabel || c.chatKey)}</h3>${tag(c.chatKey)}<p>${esc(c.count)} 条记录</p><button data-chat="${esc(c.chatKey)}">查看记录</button></div>`).join("")}</div>${data.chats?.length ? "" : empty("当前实例暂无工作记忆会话。")}<div id="working-items"></div>`;
      content.querySelectorAll("[data-chat]").forEach(
        (b) =>
          (b.onclick = async () => {
            const target = $("#working-items");
            target.textContent = "正在加载…";
            target.scrollIntoView({block:"nearest"});
            try {
              const r = await api.get(
                "working/items?limit=50&chatKey=" +
                  encodeURIComponent(b.dataset.chat),
                "working-items",
              );
              if (live())
                target.innerHTML =
                  `<h2>${esc(b.dataset.chat)} · 最多显示前 50 条</h2>` +
                    ((r.items || [])
                      .map(
                        (i) =>
                          `<div class="card"><h3>${esc(i.title)}</h3>${tag(stateLabels[i.state] || i.state || "状态未提供")}<p>${esc(i.summary || "无摘要")}</p><small>${esc(localTime(i.toTs))}</small></div>`,
                      )
                      .join("") || empty("此会话暂无记录。"));
            } catch (e) {
              if (e.name !== "AbortError" && live())
                target.innerHTML = error(e);
            }
          }),
      );
    } else if (route === "settings") {
      await (await import('./manage-settings.js')).renderSettings({api,content,live,esc,error});
    } else if (route === "diagnostics") {
      const d = await api.get("memory/diagnostics");
      if (!live()) return;
      diagnostic = d;
      diagnosticError = null;
      $("#instance").textContent = d.instanceId;
      content.innerHTML = `<div class="grid">${[
        ["实例", d.instanceId],
        ["服务版本", d.service?.version],
        ["向量模式", d.vectors?.mode],
        ["向量代", d.vectors?.generation],
        ["存储只读", d.storage?.readOnly],
        ["只读原因", d.storage?.reason],
        ["待处理窗口", d.pending?.windows],
        ["待发送", d.pending?.outbox],
        ["最近验证", d.lastValidation],
      ]
        .map(
          ([k, v]) =>
            `<div class="card"><h3>${k}</h3><p>${esc(typeof v === "object" && v !== null ? JSON.stringify(v) : v)}</p></div>`,
        )
        .join(
          "",
        )}</div><div class="card"><h2>已提供能力</h2>${(d.capabilities || []).map(tag).join("")}</div>`;
      const extra = document.createElement("section");
      content.append(extra);
      try {
        const c = await api.get("consolidate");
        if (live())
          extra.innerHTML =
            "<h2>整理诊断</h2>" +
            '<details><summary>查看完整整理诊断</summary>' + json(c) + "</details>" +
            (c.lastConsolidate === null ? "<p>暂无记录</p>" : "") +
            (c.lastConsolidate?.degraded?.code === "EVIDENCE_MISSING"
              ? '<p class="card notice">部分工作暂停：新窗口与待恢复窗口暂停，层维护按结果显示。</p>'
              : "");
      } catch (e) {
        if (live() && e.name !== "AbortError") extra.innerHTML = error(e);
      }
    } else if (route === "instances") {
      const d = await api.get("instances");
      if (!live()) return;
      content.innerHTML =
        (d.problems?.length
          ? `<div class="card error">${esc(d.problems.join("；"))}</div>`
          : "") +
        (d.instances || [])
          .map(
            (i) =>
              `<div class="card"><h2>${esc(i.name)} ${i.self ? tag("当前服务") : ""}</h2><p>${esc(i.note || i.baseURL)}</p>${tag(i.alive ? "在线" : "离线")}${i.dataRootMatch === false ? tag("数据目录不匹配") : ""}<p class="muted">${esc(i.reason || "")}</p><button data-instance="${esc(i.name)}" ${!i.alive ? "disabled" : ""}>在该实例打开</button></div>`,
          )
          .join("");
      content.querySelectorAll("[data-instance]").forEach(
        (b) =>
          (b.onclick = () => {
            const i = d.instances.find((x) => x.name === b.dataset.instance);
            const u = new URL(i.baseURL);
            if (!["http:", "https:"].includes(u.protocol)) return;
            u.pathname = "/manage.html";
            u.search = "?theme=" + document.documentElement.dataset.theme;
            u.hash = "#/people";
            location.assign(u.href);
          }),
      );
      if (!d.instances?.length) content.innerHTML = empty("注册表未提供实例");
    } else if (route === "graph" && demo) {
      content.innerHTML = empty("演示模式不加载真实星图。请从正式入口查看。");
    } else if (route === "graph") {
      content.innerHTML = `<p class="muted">关系星图为辅助视图。<a href="/${location.search}" target="_blank" rel="noopener">独立打开星图</a></p><iframe title="关系星图" src="/?theme=${document.documentElement.dataset.theme}"></iframe>`;
    } else content.innerHTML = empty("页面不存在");
  } catch (e) {
    if (live() && e.name !== "AbortError")
      content.innerHTML = error(e) + '<button id="retry">重新加载</button>';
    if ($("#retry")) $("#retry").onclick = render;
  }
}
async function renderPeople(who, content, live) {
  content.innerHTML = `<div class="people-workspace"><aside class="people-directory"><form id="people-search"><input id="search" type="search" aria-label="搜索人物" placeholder="昵称 / QQ / 别名"><button>查找</button></form><small id="people-count"></small><div id="people-list">正在加载人物…</div></aside><div id="person-detail"></div></div>`;
  const directory = $("#people-list"), detail = $("#person-detail");
  $("#search").value=peopleQuery;
  // A failed directory must not prevent a directly linked person from opening.
  const loadList = async (q=peopleQuery) => {
    peopleQuery=q;
    try {
      const data = await api.get("person" + (q ? "?q="+encodeURIComponent(q) : ""), "people-directory");
      if (!live()) return;
      const list=data.people || [];
      $("#people-count").textContent=`${list.length} 人`;
      directory.innerHTML=list.map(p=>`<a class="person-link" data-person="${esc(p.speaker)}" href="${href("people/"+encodeURIComponent(p.speaker))}" ${p.speaker===who?'aria-current="true"':""}><strong>${esc(p.names?.[0]||p.speaker)}</strong><small>${esc(p.speaker)} · ${esc(p.slots??0)} 槽</small></a>`).join("") || empty("未找到人物，可输入完整 QQ 号查找");
      $(".people-directory").scrollTop=directoryScroll;
      if(person) markSelectedPerson(person);
      if(!who && !q && list.length) await renderPerson(list[0].speaker,detail,live);
    } catch(e) { if(live() && e.name!=="AbortError") { directory.innerHTML=error(e)+'<button id="retry">重新加载人物</button>'; $("#retry").onclick=()=>loadList(q); } }
  };
  let searchTimer;
  $("#search").oninput=()=>{directoryScroll=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(live()) loadList($("#search").value.trim());},200);};
  $("#people-search").onsubmit=e=>{e.preventDefault();clearTimeout(searchTimer);loadList($("#search").value.trim());};
  if(who) await Promise.all([loadList(),renderPerson(who,detail,live)]);
  else { detail.innerHTML=empty("从左侧选择人物，或搜索尚无记忆的人物"); await loadList(); }
}
function markSelectedPerson(data) {
  document.querySelectorAll(".person-link").forEach(a=>{
    if(data.person?.labels?.includes(a.dataset.person)) a.setAttribute("aria-current","true");
    else a.removeAttribute("aria-current");
  });
}
async function renderPerson(who, content, live) {
  if (!capability("memory.person")) {
    content.innerHTML = empty("服务版本尚未提供人物管理接口");
    return;
  }
  const data = await api.get(
    "memory/person?who=" + encodeURIComponent(who),
    "person",
  );
  if (!live()) return;
  person = data;
  markSelectedPerson(data);
  const face=data.person || {}, title=face.names?.[0] || face.labels?.join(" / ") || who;
  content.innerHTML = `<div class="row between person-heading"><div><h2>${esc(title)} <small>${esc(face.labels?.join(" / ")||who)}</small></h2><small>${esc(face.names?.slice(1).join(" / ") || "")} · ${data.items.length} 条 · ${data.scopes.length} 个场合</small></div><div class="row"><a href="/person.html?who=${encodeURIComponent(who)}">旧版人物卡</a><button id="add-memory" ${!capability("memory.entries.create")?'disabled title="当前服务尚未提供人工新增接口"':""}>＋ 添加记忆</button></div></div><div class="row person-filters"><select id="hidden-filter" aria-label="显示状态"><option value="visible">正常项目</option><option value="hidden">已隐藏项目</option><option value="all">全部项目</option></select><select id="kind-filter" aria-label="记忆分类"><option value="">全部分类</option>${Object.entries(factKinds).map(([k,v])=>`<option value="${k}">${v} ${data.items.filter(i=>i.kind===k).length}</option>`).join("")}</select><input id="memory-filter" type="search" aria-label="搜索记忆内容" placeholder="筛选当前人物的记忆"><details class="person-help"><summary>使用说明</summary><p>未知场合仅显示原始标识，不推断群名。人工恢复回到原始内容（机器项目使用最新机器内容，人工新增使用最初输入）。保存后是否采用仍受场合、相关性和条数限制。</p></details></div><div id="person-items"></div><details class="policy-details"><summary>目标场合的策略比较</summary><p class="muted">以服务器返回的实际统计为准；不在页面计算授权。</p><form id="policy-form"><input id="chat-key" aria-label="目标 chatKey" placeholder="填写实际 chatKey，例如 group:123"><button ${!capability("memory.policy-impact") ? "disabled" : ""}>比较策略</button></form><div id="policy-result"></div></details>`;
  const draw = () => {
    const filter = $("#hidden-filter").value;
    const items = data.items.filter(
      (i) => (filter === "all" || (filter === "hidden" ? i.hidden : !i.hidden)) && (!$("#kind-filter").value || i.kind===$("#kind-filter").value) && JSON.stringify([i.value,i.itemKey]).toLowerCase().includes($("#memory-filter").value.toLowerCase()),
    );
    const scopes = [...new Set(items.map((i) => i.scope))];
    $("#person-items").innerHTML =
      scopes
        .map((scope) => {
          const mapping = data.scopes.find((s) => s.scope === scope);
          return `<section class="scope"><div class="row scope-heading"><h3>${esc(mapping?.mappingStatus !== "unknown" && mapping?.displayName ? mapping.displayName : "来源场合未识别")}</h3><small>${esc(scope)} · ${items.filter(i=>i.scope===scope).length} 条</small></div>${items
            .filter((i) => i.scope === scope)
            .map(
              (i) =>
                `<article class="item"><div class="item-meta">${tag(factKinds[i.kind]||i.kind)}${i.origin!=="machine"?tag(i.origin==="human"?"人工新增":"人工修订"):""}${i.hidden ? tag("已隐藏") : ""}${i.sourceState === "source_changed" ? tag("机器来源已变化") : ""}</div><p class="value">${i.itemKey?`<strong>${esc(i.itemKey)}：</strong>`:""}${esc(typeof i.value === "string" ? i.value : JSON.stringify(i.value))}</p><div class="actions"><button data-source="${esc(encodeURIComponent(i.key))}" data-item="${esc(i.itemKey ?? "")}">来源与版本</button>${i.editable && capability("memory.revisions") ? `<button data-edit="${esc(encodeURIComponent(i.key))}" data-item="${esc(i.itemKey ?? "")}" data-op="replace">编辑</button><button data-edit="${esc(encodeURIComponent(i.key))}" data-item="${esc(i.itemKey ?? "")}" data-op="${i.hidden ? "restore" : "hide"}">${i.hidden ? "恢复" : "隐藏"}</button>` : tag(i.editable ? "修订不可用" : "结构化 · 只读")}</div></article>`,
            )
            .join("")}</section>`;
        })
        .join("") || empty("此筛选下没有记忆项目");
    $("#person-items")
      .querySelectorAll("[data-source]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const i = findItem(data, b);
            evidence(i);
          }),
      );
    $("#person-items")
      .querySelectorAll("[data-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            revision(findItem(data, b), b.dataset.op, data, who)),
      );
  };
  draw();
  $("#hidden-filter").onchange = draw;
  $("#kind-filter").onchange = draw;
  $("#memory-filter").oninput = draw;
  $("#add-memory").onclick=()=>addMemory(data,who);
  $("#policy-form").onsubmit = async (e) => {
    e.preventDefault();
    const target = $("#policy-result"),
      chat = $("#chat-key").value.trim();
    if (!chat) return;
    target.textContent = "正在比较…";
    try {
      const r = await api.get(
        `memory/policy-impact?who=${encodeURIComponent(who)}&chatKey=${encodeURIComponent(chat)}`,
        "policy",
      );
      if (!live()) return;
      target.innerHTML = (r.policies || [])
        .map(
          (p) =>
            `<div class="card"><h3>${esc(p.id)}</h3>${tag("来源：" + p.origin)}<table><tr><th>候选</th><th>允许</th><th>阻止</th><th>采用来源槽</th><th>输出行</th></tr><tr>${[p.eligibleSlots, p.allowedSlots, p.blockedSlots, p.selectedSourceSlots, p.renderedLines].map((v) => `<td>${esc(v)}</td>`).join("")}</tr></table>${json(p.reasons)}${(p.details || []).map((d) => `<p>${esc(d.text)}</p>${d.mixedScopes ? tag("混合场合来源") : ""}<details><summary>来源槽元数据（非单项证据）</summary>${json(d.sourceSlots)}</details>`).join("")}</div>`,
        )
        .join("");
    } catch (e) {
      if (e.name !== "AbortError" && live()) target.innerHTML = error(e);
    }
  };
}
function addMemory(data,who) {
  const options=data.scopes.filter(s=>s.chatKey).map(s=>`<option value="${esc(s.chatKey)}">${esc(s.displayName||s.chatKey)}</option>`).join("");
  modal(`<h2>添加人物记忆</h2><p>${esc(data.person?.names?.[0]||who)} · 人工输入，无需模型确认。</p><form id="add-memory-form"><label>所属场合<input id="entry-chat" list="entry-scopes" required placeholder="group:群号 / private:QQ号" pattern="(group|private):[0-9]{5,15}"><datalist id="entry-scopes">${options}</datalist></label><label>分类<select id="entry-kind">${Object.entries(factKinds).filter(([k])=>k!=="pattern").map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}</select></label><label>属性或事项名称<input id="entry-key" required maxlength="100" placeholder="例如：支持经历 / 2026-10-29打赏"></label><label class="full-width">内容<textarea id="entry-value" required maxlength="4000" placeholder="例如：曾通过打赏支持我的猫娘 Agent。"></textarea></label><label class="full-width">备注（可选）<input id="entry-reason" maxlength="1000" placeholder="例如：由我根据打赏通知手动补录"></label><p class="muted">场合决定后续使用范围。人工输入不会被当作付款核验或聊天原文；日期、金额请按实际情况填写。同名项目请使用编辑。</p><div id="entry-status" class="full-width" aria-live="polite"></div><button id="save-entry">保存记忆</button></form>`);
  if(data.scopes.length===1 && data.scopes[0].chatKey) $("#entry-chat").value=data.scopes[0].chatKey;
  const form=$("#add-memory-form"), status=$("#entry-status"), submit=$("#save-entry");
  let request=null;
  form.onsubmit=async e=>{
    e.preventDefault();
    if(!request) request={operationId:operationId(),expectedInstanceId:data.instanceId,who,chatKey:$("#entry-chat").value.trim(),kind:$("#entry-kind").value,itemKey:$("#entry-key").value.trim(),value:$("#entry-value").value.trim(),...($("#entry-reason").value.trim()?{reason:$("#entry-reason").value.trim()}:{})};
    form.querySelectorAll("input,select,textarea,button").forEach(x=>x.disabled=true);
    status.textContent="正在保存…";
    try {
      const result=await api.write("memory/entries",request);
      status.textContent=`已保存${result.replayed?"（重复提交已去重）":""}。可关闭窗口查看。`;
      if(person===data) await render();
    } catch(err) {
      status.innerHTML=error(err);
      if(err.status>=400 && err.status<500) {
        request=null;
        form.querySelectorAll("input,select,textarea").forEach(x=>x.disabled=false);
        submit.textContent="修改后重新提交";
      } else {
        status.innerHTML+="<p>尚未确认保存结果。草稿已保留，重试会使用同一操作，避免重复新增。</p>";
        submit.textContent="使用原操作重试";
      }
      submit.disabled=false;
    }
  };
}
function findItem(data, b) {
  return data.items.find(
    (i) =>
      i.key === decodeURIComponent(b.dataset.edit || b.dataset.source) &&
      String(i.itemKey ?? "") === b.dataset.item,
  );
}
function revision(item, op, data, who) {
  const restoreLabel=item.humanCreated?"恢复最初人工内容":"恢复最新机器内容";
  const body = {
    operationId: operationId(),
    expectedInstanceId: data.instanceId,
    target: { key: item.key, itemKey: item.itemKey ?? null },
    expectedEtag: item.etag,
    op,
  };
  let attempted = false;
  modal(
    `<h2>${op === "replace" ? "编辑记忆" : op === "hide" ? "隐藏（可恢复）" : restoreLabel}</h2><p class="muted">实例 ${esc(data.instanceId)} · ${esc(item.scope)}</p>${op === "replace" ? `<label>内容<textarea id="draft">${esc(item.value)}</textarea></label>` : `<p>${op === "hide" ? "该项目将从采用结果中隐藏，可在隐藏筛选中恢复。" : restoreLabel+"，不是撤销到历史版本。"}</p>`}<label>修订原因（可选）<input id="reason" maxlength="500"></label><div id="write-status" aria-live="polite"></div><div class="actions"><button id="submit-revision">确认提交</button><button id="reload-revision" hidden>读取当前版本，保留草稿</button></div>`,
  );
  const submit = $("#submit-revision"),
    draft = $("#draft"),
    reason = $("#reason"),
    status = $("#write-status");
  submit.onclick = async () => {
    if (!attempted) {
      if (op === "replace") body.value = draft.value;
      if (reason.value.trim()) body.reason = reason.value.trim();
      else delete body.reason;
      attempted = true;
    }
    submit.disabled = true;
    if (draft) draft.disabled = true;
    reason.disabled = true;
    status.textContent = "正在提交…";
    try {
      const r = await api.write("memory/revisions", body);
      status.innerHTML = `<p>已保存${r.replayed ? "（幂等重放）" : ""}</p>`;
      submit.hidden = true;
      if (person === data) render();
    } catch (e) {
      status.innerHTML = error(e);
      if (e.status === 409) {
        status.innerHTML +=
          "<p>草稿已保留。请读取当前版本并比较，再主动提交；页面不会自动覆盖新版本。</p>";
        $("#reload-revision").hidden = false;
      } else if (e.status >= 400 && e.status < 500) {
        attempted = false;
        body.operationId = operationId();
        if (draft) draft.disabled = false;
        reason.disabled = false;
        submit.disabled = false;
        submit.textContent = "修改后提交新操作";
      } else {
        submit.disabled = false;
        submit.textContent = "使用同一操作 ID 重试";
        status.innerHTML +=
          "<p>尚未确认保存成功。重试使用原操作 ID 和原内容。</p>";
      }
    }
  };
  $("#reload-revision").onclick = async () => {
    try {
      const r = await api.get(
        "memory/person?who=" + encodeURIComponent(who),
        "revision-current",
      );
      const now = r.items.find(
        (i) => i.key === item.key && i.itemKey === item.itemKey,
      );
      status.innerHTML = `<p>服务器当前内容：</p>${json(now?.value ?? null)}<p>你的草稿仍保留在上方。确认比较后，可发起新操作。</p>`;
      if (!now || !now.editable || r.instanceId !== data.instanceId) return;
      body.expectedEtag = now.etag;
      body.operationId = operationId();
      attempted = false;
      if (draft) draft.disabled = false;
      reason.disabled = false;
      submit.disabled = false;
      submit.textContent = "已比较，按当前版本提交";
      $("#reload-revision").hidden = true;
    } catch (e) {
      status.innerHTML = error(e);
    }
  };
}
async function subjects(content, live) {
  if (!capability("subjects.read")) {
    content.innerHTML = empty("服务版本尚未提供主体功能");
    return;
  }
  const d = await api.get("subjects");
  if (!live()) return;
  content.innerHTML = `<div class="row between"><p class="muted">显式登记主体。同名不会自动合并，观察数量不代表可信度。</p><button id="create-subject" ${!capability("subjects.create") ? "disabled" : ""}>登记主体</button></div><form id="subject-filter"><input id="subject-q" aria-label="搜索主体" placeholder="搜索主体"><select id="subject-kind"><option value="">所有类型</option>${Object.entries(
    kinds,
  )
    .map(([v, t]) => `<option value="${v}">${t}</option>`)
    .join(
      "",
    )}</select><button>筛选</button></form><div id="subject-list"></div>`;
  const draw = () => {
    $("#subject-list").innerHTML =
      (d.items || [])
        .filter(
          (s) =>
            (!$("#subject-kind").value ||
              s.kind === $("#subject-kind").value) &&
            JSON.stringify(s).includes($("#subject-q").value),
        )
        .map(
          (s) =>
            `<a class="card list-link" href="${href("subjects/" + encodeURIComponent(s.id))}"><strong>${esc(s.label)}</strong><p>${tag(kinds[s.kind] || s.kind)}${tag(s.status)}${tag(s.scopeBinding || "无绑定场合")}</p><small>${esc(s.id)}</small></a>`,
        )
        .join("") || empty("未找到主体");
  };
  draw();
  $("#subject-filter").onsubmit = (e) => {
    e.preventDefault();
    draw();
  };
  $("#create-subject").onclick = () =>
    subjectForm(
      "登记主体",
      `<label>类型<select id="kind">${Object.entries(kinds)
        .map(([v, t]) => `<option value="${v}">${t}</option>`)
        .join(
          "",
        )}</select></label><label>名称<input id="label" required></label><label>场合绑定（群主体必填规范 scope）<input id="scope" placeholder="group:C123"></label>`,
      () => ({
        path: "subjects",
        body: {
          kind: $("#kind").value,
          label: $("#label").value,
          scopeBinding: $("#scope").value.trim() || null,
        },
      }),
      d.instanceId,
    );
}
async function subjectDetail(id, content, live) {
  const d = await api.get("subjects/" + encodeURIComponent(id));
  if (!live()) return;
  selectedSubject = d;
  const s = d.subject;
  content.innerHTML = `<div class="row between"><div><h2>${esc(s.label)}</h2>${tag(kinds[s.kind] || s.kind)}${tag(s.status)}${tag(s.scopeBinding || "无绑定场合")}</div><a href="#/subjects">返回主体列表</a></div><div class="card"><h3>别名</h3><p>${esc(s.aliases?.join("、") || "未设置")}</p><div class="actions"><button id="aliases" ${!capability("subjects.aliases") ? "disabled" : ""}>修改别名</button><button id="merge" ${s.status === "merged" || !capability("subjects.merge") ? "disabled" : ""}>合并到另一主体</button><button id="unmerge" ${s.status !== "merged" || !capability("subjects.unmerge") ? "disabled" : ""}>撤销合并</button></div>${s.mergedInto ? `<p>已合并到 <a href="${href("subjects/" + s.mergedInto)}">${esc(s.mergedInto)}</a></p>` : ""}</div><h2>原始观察</h2><p class="muted">关系未判定时不推断共识、支持或反对。当前版本不开放观察写入。</p>${(d.observations || []).map((o) => `<div class="card"><h3>${esc(o.aspect)}</h3>${tag({ fact: "事实陈述", opinion: "意见", pattern: "模式" }[o.claimType] || o.claimType)}${tag(o.sourceScope || "来源场合未识别")}<p>${esc(o.statement)}</p><small>报告者：${esc(o.reporterLabel)} · ${esc(o.observedAt)}</small><details><summary>来源元数据（不提供原文跳转）</summary>${json(o.provenance)}</details></div>`).join("") || empty("尚无原始观察")}<div class="card"><h3>观察分组</h3>${(d.groups || []).map((g) => `<p>${esc(g.aspect)} · ${g.relation === "unknown" ? "关系未判定" : esc(g.relation)} · ${g.observationIds.length} 条观察</p>`).join("") || "<p>未提供</p>"}</div>`;
  $("#aliases").onclick = () =>
    subjectForm(
      "修改别名",
      '<p>每行一个别名；提交会替换完整别名列表。</p><textarea id="aliases-value">' +
        esc(s.aliases.join("\n")) +
        "</textarea>",
      () => ({
        path: `subjects/${id}/aliases`,
        body: {
          expectedRev: s.rev,
          aliases: $("#aliases-value")
            .value.split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
        },
      }),
      d.instanceId,
    );
  $("#unmerge").onclick = () =>
    subjectForm(
      "撤销合并",
      "<p>恢复合并前的主体归属。若存在后续合并，需先撤销后续操作。</p>",
      () => ({ path: `subjects/${id}/unmerge`, body: { expectedRev: s.rev } }),
      d.instanceId,
    );
  $("#merge").onclick = async () => {
    try {
      const all = await api.get("subjects");
      if (!live()) return;
      const candidates = all.items.filter(
        (x) =>
          x.id !== id &&
          x.status === "active" &&
          x.kind === s.kind &&
          x.scopeBinding === s.scopeBinding,
      );
      subjectForm(
        "合并主体",
        `<p>源主体：${esc(s.label)} · 当前返回 ${d.observations.length} 条观察。提交后以服务器影响摘要为准。</p><label>目标主体<select id="merge-target">${candidates.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} · ${esc(t.id)}</option>`).join("")}</select></label>${!candidates.length ? "<p>没有同类型、同绑定场合的可合并主体。</p>" : ""}`,
        () => {
          const t = candidates.find((x) => x.id === $("#merge-target").value);
          if (!t) throw Error("请选择有效的目标主体");
          return {
            path: `subjects/${id}/merge`,
            body: {
              intoId: t.id,
              expectedFromRev: s.rev,
              expectedIntoRev: t.rev,
            },
          };
        },
        d.instanceId,
      );
    } catch (e) {
      modal(error(e));
    }
  };
}
function subjectForm(title, fields, build, instanceId) {
  let request = null;
  modal(
    `<h2>${title}</h2><form id="subject-write" style="display:block">${fields}<div id="subject-status" aria-live="polite"></div><button id="subject-submit">确认提交</button></form>`,
  );
  $("#subject-write").onsubmit = async (e) => {
    e.preventDefault();
    const b = $("#subject-submit"),
      status = $("#subject-status");
    try {
      if (!request) {
        request = build();
        request.body = {
          ...request.body,
          operationId: operationId(),
          expectedInstanceId: instanceId,
        };
      }
      b.disabled = true;
      const r = await api.write(request.path, request.body);
      status.innerHTML =
        "<p>操作成功</p>" +
        (r.affectedObservationIds
          ? `<p>实际影响 ${r.affectedObservationIds.length} 条观察</p>`
          : "");
      b.hidden = true;
      $("#subject-write")
        .querySelectorAll("input,textarea,select")
        .forEach((x) => (x.disabled = true));
      render();
    } catch (err) {
      status.innerHTML = error(err);
      b.disabled = false;
      if (err.status === 409) {
        b.disabled = true;
        status.innerHTML +=
          "<p>版本已变化，输入已保留。请关闭弹层，重新读取主体后再发起操作。</p>";
      } else if (err.status >= 400 && err.status < 500) {
        request = null;
        b.textContent = "修改后提交新操作";
      } else {
        b.textContent = "用相同操作 ID 重试";
        $("#subject-write")
          .querySelectorAll("input,textarea,select")
          .forEach((x) => (x.disabled = true));
      }
    }
  };
}
addEventListener("hashchange", render);
boot();

async function evidence(item) {
  modal('<h2>来源与版本</h2><div id="evidence-content">正在加载…</div><details id="version-history"><summary>查看历史版本与人工操作</summary><div id="version-content"></div></details>');
  $("#version-history").ontoggle=async e=>{
    if(!e.target.open) return;
    const history=$("#version-content"); history.textContent="正在读取…";
    try { const r=await api.get("facts/versions?key="+encodeURIComponent(item.key),"versions"); if(history.isConnected) history.innerHTML=json({machineVersions:r.versions,manualHistory:r.manualHistory||[]}); }
    catch(err) {if(history.isConnected && err.name!=="AbortError") history.innerHTML=error(err);}
  };
  const target = $("#evidence-content");
  if (!capability("facts.evidence")) {
    target.innerHTML =
      "<p>无法追溯：服务版本尚未提供来源接口。整槽来源不能证明单项。</p>" +
      json(item);
    return;
  }
  const params = new URLSearchParams({ key: item.key });
  if (item.itemKey != null) params.set("itemKey", item.itemKey);
  async function load(source = false, chatKey = null) {
    try {
      const q = new URLSearchParams(params);
      if (source) {
        q.set("withSource", "1");
        q.set("chatKey", chatKey);
      }
      const r = await api.get("facts/evidence?" + q, "evidence");
      if (!target.isConnected) return;
      const refs = r.references || [],
        contentRefs = refs.filter((x) => x.type !== "manual"),
        chats = [...new Set(contentRefs.map((x) => x.chatKey))];
      target.innerHTML =
        "<p>来源层级：" +
        esc(r.level) +
        " · 状态：" +
        esc(r.state) +
        "</p><p>" +
        esc(r.reason) +
        "</p><p>整槽来源不能证明单项；取回原话不改变证据状态。</p>" +
        json({ references: refs, unresolved: r.unresolved, note: r.note }) +
        '<button id="load-source" ' +
        (chats.length !== 1 || !chats[0] ? "disabled" : "") +
        '>显式读取引用会话原话</button><p class="muted">' +
        (chats.length !== 1 || !chats[0]
          ? "引用包含多个会话、缺失会话或没有内容引用，禁止整单原话查询。"
          : "仅查询引用标注会话：" + esc(chats[0])) +
        "</p>";
      if (r.sourceLookup) {
        target.innerHTML += "<p>" + esc(r.sourceLookup.note) + "</p>";
        for (const source of r.sourceLookup.sources || [])
          target.innerHTML +=
            '<section class="card"><h3>' +
            esc(source.status) +
            "</h3><p>truncated: " +
            esc(source.truncated) +
            " · " +
            esc(source.reason) +
            "</p>" +
            (source.status === "found"
              ? json(source.messages)
              : "<p>没有可核实原话</p>") +
            "</section>";
      }
      $("#load-source").onclick = () => load(true, chats[0]);
    } catch (e) {
      if (e.name !== "AbortError" && target.isConnected) {
        target.innerHTML =
          error(e) + '<button id="retry-evidence">重试来源读取</button>';
        $("#retry-evidence").onclick = () => load(source, chatKey);
      }
    }
  }
  await load();
}
async function timeline(content, live) {
  if (!capability("memory.events")) {
    content.innerHTML = empty("服务版本尚未提供时间线功能");
    return;
  }
  content.innerHTML =
    '<form id="timeline-filter"><input name="chatKey" aria-label="会话" placeholder="会话标识（选填）"><select name="state" aria-label="事件状态"><option value="">所有状态</option>' +
    ["working", "promoted", "dimmed", "retired"]
      .map((x) => `<option value="${x}">${stateLabels[x]}</option>`)
      .join("") +
    '</select><label>开始日期<input name="from" type="date"></label><label>结束日期<input name="to" type="date"></label><label>每页条数<input name="limit" type="number" min="1" max="100" value="30"></label><button>应用筛选</button></form><div id="timeline-status"></div><div id="timeline-items"></div><button id="timeline-more">加载下一页</button>';
  const form = $("#timeline-filter"),
    status = $("#timeline-status"),
    list = $("#timeline-items"),
    more = $("#timeline-more");
  let cursor = null,
    snapshot = null,
    generation = 0,
    seen = new Set(),
    filters;
  async function page(reset = false) {
    if (reset) {
      const {from, to} = form.elements;
      if (from.value && to.value && from.value > to.value) {
        to.setCustomValidity("结束日期须在开始日期当天或之后");
        to.reportValidity();
        to.setCustomValidity("");
        return;
      }
      generation++;
      cursor = null;
      snapshot = null;
      seen.clear();
      list.innerHTML = "";
      filters = new URLSearchParams(
        [...new FormData(form)].filter(([, v]) => v !== ""),
      );
      if (from.value) filters.set("from", new Date(from.value + "T00:00:00").getTime());
      if (to.value) filters.set("to", new Date(to.value + "T23:59:59.999").getTime());
    }
    const gen = generation;
    more.disabled = true;
    try {
      const q = new URLSearchParams(filters);
      if (cursor) q.set("cursor", cursor);
      const r = await api.get("memory/events?" + q, "timeline");
      if (!live() || gen !== generation) return;
      snapshot = r.snapshotId;
      cursor = r.nextCursor;
      status.innerHTML =
        "<p>总数 " +
        esc(r.total) +
        " · 快照 " +
        esc(snapshot) +
        "</p>" +
        stateSummary(r.stateCounts) +
        (r.degraded
          ? '<div class="card notice">降级：' +
            esc(JSON.stringify(r.degraded)) +
            "</div>"
          : "");
      for (const i of r.items || []) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        list.innerHTML +=
          '<article class="card"><h3>' +
          esc(i.title) +
          "</h3>" +
          tag(stateLabels[i.state] || i.state) +
          "<p>" +
          esc(i.summary) +
          "</p><p>" +
          esc(localTime(i.fromTs)) +
          " → " +
          esc(localTime(i.toTs)) +
          "</p><small>来源未核验；不提供原话链接</small></article>";
      }
      if (!seen.size) list.innerHTML = empty();
      more.hidden = !cursor;
      more.disabled = false;
    } catch (e) {
      if (!live() || gen !== generation || e.name === "AbortError") return;
      if (e.status === 409 || e.body?.code === "INVALID_CURSOR") {
        cursor = null;
        snapshot = null;
        seen.clear();
        list.innerHTML = "";
        more.hidden = true;
      }
      status.innerHTML =
        error(e) + '<button id="timeline-reload">从第一页重新加载</button>';
      $("#timeline-reload").onclick = () => page(true);
    }
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    page(true);
  };
  more.onclick = () => page();
  await page(true);
}
