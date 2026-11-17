import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";
import { createLiteEditionFixture } from "../test-support/lite-edition-fixture.mjs";

const run = promisify(execFile);
const url = (file) => new URL(`../public/${file}`, import.meta.url).href;

test("shared locale, calendar and rendering load and translate with Waifu copy forbidden", async (t) => {
  const fixture = createLiteEditionFixture();
  t.after(fixture.close);
  const probe = createLiteBoundaryProbe(fixture.root, {
    forbiddenModules: [
      "public/i18n.js",
      "public/waifu-locale.js",
      "public/app.js",
      "public/cost-currency.js",
      "public/waifu-timeline.js",
      "public/range-metrics.js",
    ],
  });
  const source = `
    import assert from 'node:assert/strict';
    const locale=await import(${JSON.stringify(url("locale.js"))});
    const calendar=await import(${JSON.stringify(url("calendar.js"))});
    const render=await import(${JSON.stringify(url("dashboard-render.js"))});
    assert.equal(locale.LOCALE_STORAGE_KEY,'codexUsageLocale');
    locale.setLocale('en-US',{persist:false});
    for(const [source,english] of [
      ['用量概览','Usage overview'],
      ['缓存读取','Cache Hit'], ['本周限额','Weekly Limit'], ['正在同步数据…','Syncing data…'],
      ['扫描失败：没有发现新的记录目录。','Scan failed: No new record directories found.'],
      ['上次：3分钟前','Last: 3 min ago'], ['缓存写入：明细未提供','Cache Write: Details unavailable'],
      ['本地 Git 仓库优先；当前先按本周正序；平手依次按其余周期倒序',
       'Local Git repositories first; Sort by this week ascending; ties follow the remaining periods in descending priority'],
    ]) assert.equal(locale.localizeText(source),english);
    for(const text of ['总花销','分享图片','切换主题','无皮肤','正在更新价格…','价格基准 2026-11-17','上下文 272K 分档'])
      assert.equal(locale.localizeText(text),text,'exclusive copy: '+text);
    assert.equal(locale.localizeServerError({code:'INVALID_PRICING'},400),'The request could not be completed (HTTP 400).');
    assert.equal(locale.localizeServerError({code:'INVALID_DATE'},400),'Enter a valid date in YYYY-MM-DD format.');
    assert.equal(locale.localizeQuotaReason({reasonCode:'waiting'}),'Waiting for a new limit record.');
    assert.match(calendar.renderDatePickerHtml({viewDate:new Date(2026,8,1)}),/September 2026/);
    assert.match(calendar.renderDatePickerHtml({viewDate:new Date(2026,8,1)}),/Choose a start date/);
    assert.equal(calendar.dateKey(new Date('2026-01-01T01:30:00Z'),'America/Los_Angeles'),'2025-12-31');
    assert.equal(render.rangeLabel({range:{preset:'quota_5h',recentValue:'上周',quotaState:'waiting'}}),'等待Last 7d数据');
    assert.equal(render.formatTokenMillions(1234567),'1.23M');
    locale.setLocale('zh-CN',{persist:false});
    assert.match(calendar.renderDatePickerHtml({viewDate:new Date(2026,8,1)}),/2026年09月/);
    console.log('shared locale passed');
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", source], {
    env: probe.env,
    windowsHide: true,
  });
  assert.equal(stdout.trim(), "shared locale passed");
  assert.equal(probe.read().filter((event) => event.forbidden).length, 0);
  for (const file of ["i18n.js", "waifu-locale.js"]) {
    await assert.rejects(
      run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url(file))})`], {
        env: probe.env,
        windowsHide: true,
      }),
      (error) => error.stderr.includes("LITE_BOUNDARY_MODULE"),
    );
  }
});

test("Waifu compatibility shares locale state, observers and cached DOM sources with the pure entry", async () => {
  const source = `
    import assert from 'node:assert/strict';
    const locale=await import(${JSON.stringify(url("locale.js"))});
    let observers=0;
    const writes=[];
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
      getItem:key=>key==='codexUsageLocale'?'en-US':null,setItem:(...args)=>writes.push(args),
    }});
    function element(text,className='') {
      const node={nodeType:1,tagName:'SPAN',dataset:{},hasAttribute:()=>false,matches:()=>false,
        closest:selector=>className&&selector.includes(className)?node:null,childNodes:[]};
      node.childNodes=[{nodeType:3,parentElement:node,nodeValue:text}];return node;
    }
    const shared=element('总输入'),user=element('总输入','.home-path'),priceName=element('总花销','.pricing-model-name');
    const body=element('');body.childNodes=[shared,user,priceName];
    globalThis.document={body,documentElement:{dataset:{},removeAttribute(){}}};
    globalThis.MutationObserver=class {
      constructor(){observers++} observe(target,options){assert.equal(target,body);assert.equal(options.subtree,true)}
    };
    locale.initializeLocale();
    assert.equal(shared.childNodes[0].nodeValue,'Total Input');
    assert.equal(user.childNodes[0].nodeValue,'总输入');
    assert.equal(locale.localizeText('总花销'),'总花销');
    const waifu=await import(${JSON.stringify(url("i18n.js"))});
    for(const key of Object.keys(waifu))assert.equal(waifu[key],locale[key],key+' must be the same export');
    waifu.initializeLocale();assert.equal(observers,1);assert.equal(locale.getLocale(),'en-US');
    assert.equal(waifu.localizeText('总花销'),'Estimated Cost');
    assert.equal(priceName.childNodes[0].nodeValue,'总花销','user model names stay untouched');
    assert.equal(waifu.localizeServerError({code:'INVALID_PRICING'},400),'Check the pricing rates and exchange rate, then try again.');
    waifu.setLocale('zh-CN');assert.equal(locale.getLocale(),'zh-CN');
    assert.equal(shared.childNodes[0].nodeValue,'总输入');
    locale.setLocale('en-US');assert.equal(waifu.getLocale(),'en-US');
    assert.equal(shared.childNodes[0].nodeValue,'Total Input');assert.equal(observers,1);
    assert.deepEqual(writes,[['codexUsageLocale','zh-CN'],['codexUsageLocale','en-US']]);
    for(const [source,english] of [
      ['按当前价目表估算 · 价格基准 2026-10-01 · OpenAI 价格表',
       'Estimated using current rates · Pricing baseline 2026-10-01 · OpenAI Pricing'],
      ['2026-11-16，费用估算 $2，未计价 3 tokens','2026-11-16, estimated cost $2，未计价 3 tokens'],
      ['时间分布，按模型堆叠 API 等价费用估算，人民币为纵轴单位；每个时间槽可查看完整日期和模型费用',
       'Usage over time, with estimated API-equivalent costs stacked by model in CNY. Inspect each interval for dates and model costs'],
    ])assert.equal(waifu.localizeText(source),english,'original full-template matching order');
    console.log('one locale instance passed');
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", source], { windowsHide: true });
  assert.equal(stdout.trim(), "one locale instance passed");
});

test("the shared locale contains no exclusive copy, currency handlers or price error code", async () => {
  const source = await readFile(new URL("../public/locale.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /费用|价目|计价|美元|人民币|汇率|皮肤|主题|分享|INVALID_PRICING|pricing-model-name/);
  assert.doesNotMatch(source, /style\s*:\s*["']currency["']/);
});
