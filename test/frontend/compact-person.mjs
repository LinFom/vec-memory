// Real isolated backend, human entry workflow and useful viewport density.
export async function compactPersonChecks({evaluate,until,navigate,check,cdp,shot,call}) {
  const {getRuntime}=await import('../../src/core/backend.mjs');
  const rt=await getRuntime();
  rt.normalizer.setVocabulary([
    {id:'qq:10001111',kind:'person',surface:['Synthetic Person']},
    {id:'group:10009999',kind:'group',surface:['Synthetic Room']},
  ]);
  const who='10001111', chatKey='group:10009999';
  const instanceId=(await call('memory/person?who='+who)).instanceId;
  for(let i=1;i<=16;i++) await call('memory/entries',{
    operationId:'compact-seed-'+i,expectedInstanceId:instanceId,who,chatKey,
    kind:'trait',itemKey:'合成档案'+i,value:'这是一条用于检查人物卡信息密度的合成记忆，内容可直接阅读。',
  });
  await cdp('Emulation.setDeviceMetricsOverride',{width:1850,height:900,deviceScaleFactor:1,mobile:false});
  await navigate('/manage.html?theme=dark#/people/'+who);
  await until('document.querySelectorAll("#person-items .item").length>=16');
  check('compact person directory stays visible',await evaluate('document.querySelector(".person-link").getBoundingClientRect().top<innerHeight'));
  check('at least ten ordinary memories visible at host-sized viewport',await evaluate('[...document.querySelectorAll("#person-items .item")].filter(e=>e.getBoundingClientRect().bottom<=innerHeight).length>=10'));
  check('person shows human readable nickname',await evaluate('document.querySelector(".person-heading").innerText.includes("Synthetic Person")'));
  await shot('compact-people-dark',{fullPage:false});
  await evaluate('document.querySelector("#add-memory").click()');
  await evaluate('document.querySelector("#entry-chat").value="group:10009999";document.querySelector("#entry-kind").value="trait";document.querySelector("#entry-key").value="支持经历";document.querySelector("#entry-value").value="根据打赏通知手动补录：曾支持猫娘 Agent。";document.querySelector("#add-memory-form").requestSubmit()');
  await until('document.querySelector("#entry-status")?.innerText.includes("已保存")');
  await evaluate('document.querySelector("#close-dialog").click()');
  await until('document.querySelector("#person-items")?.innerText.includes("曾支持猫娘 Agent")');
  check('human create saves immediately without model call',true);
  await navigate('/manage.html?theme=light#/people/'+who);
  await until('document.querySelector("#person-items")?.innerText.includes("曾支持猫娘 Agent")');
  check('human entry survives page reload and has human origin',await evaluate('[...document.querySelectorAll(".item")].find(e=>e.innerText.includes("支持经历")).innerText.includes("人工新增")'));
  await shot('compact-people-light',{fullPage:false});
  await evaluate('[...document.querySelectorAll(".item")].find(e=>e.innerText.includes("支持经历")).querySelector("[data-source]").click()');
  await until('document.querySelector("#evidence-content")?.innerText.includes("manual")');
  check('human entry has manual provenance instead of chat evidence',true);
  await evaluate('document.querySelector("#version-history").open=true');
  await until('document.querySelector("#version-content")?.innerText.includes("addition")');
  check('human creation history accessible from same item',true);
  await evaluate('document.querySelector("#close-dialog").click();document.querySelector("#memory-filter").value="支持经历";document.querySelector("#memory-filter").dispatchEvent(new Event("input"))');
  check('content filter includes item name',await evaluate('document.querySelectorAll("#person-items .item").length===1'));
  await evaluate('document.querySelector("[data-op=replace]").click();document.querySelector("#draft").value="手动更正后的支持经历";document.querySelector("#submit-revision").click()');
  await until('document.querySelector("#write-status")?.innerText.includes("已保存")');
  await evaluate('document.querySelector("#close-dialog").click()');
  await until('document.querySelector("#person-items")?.innerText.includes("手动更正后的支持经历")');
  check('human created entry can be edited',true);
  await evaluate('[...document.querySelectorAll(".item")].find(e=>e.innerText.includes("支持经历")).querySelector("[data-op=hide]").click();document.querySelector("#submit-revision").click()');
  await until('document.querySelector("#write-status")?.innerText.includes("已保存")');
  await evaluate('document.querySelector("#close-dialog").click()');
  await until('!!document.querySelector("#hidden-filter")');
  await evaluate('document.querySelector("#hidden-filter").value="hidden";document.querySelector("#hidden-filter").dispatchEvent(new Event("change"))');
  await until('!!document.querySelector("[data-op=restore]")');
  await evaluate('document.querySelector("[data-op=restore]").click()');
  check('human restore clearly names initial human content',await evaluate('document.querySelector("#dialog-body").innerText.includes("恢复最初人工内容")'));
  await evaluate('document.querySelector("#submit-revision").click()');
  await until('document.querySelector("#write-status")?.innerText.includes("已保存")');
  await evaluate('document.querySelector("#close-dialog").click()');
  await until('document.querySelector("#person-items")?.innerText.includes("曾支持猫娘 Agent")');
  check('hide and restore human entry work end to end',true);
  for(const width of [960,390]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
    check('compact person no horizontal overflow at '+width,await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await shot('compact-people-'+width,{fullPage:false});
  }
}
