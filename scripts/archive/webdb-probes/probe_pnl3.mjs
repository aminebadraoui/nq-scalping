import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
function loadEnv(){const e={};const p=path.resolve(process.cwd(),".env.local");try{for(const l of readFileSync(p,"utf8").split("\n")){const s=l.trim();if(!s||s.startsWith("#")||!s.includes("="))continue;const i=s.indexOf("=");e[s.slice(0,i).trim()]=s.slice(i+1).trim();}}catch{}return e;}
const env=loadEnv();
const browser=await chromium.launch({headless:false,args:["--disable-blink-features=AutomationControlled"]});
try{
  const ctx=await browser.newContext({viewport:{width:1600,height:1000}});
  await ctx.addInitScript(()=>{Object.defineProperty(navigator,"webdriver",{get:()=>undefined});});
  const page=await ctx.newPage();
  await page.goto("https://trader.tradovate.com",{waitUntil:"domcontentloaded",timeout:60000});
  await page.waitForSelector("#name-input",{timeout:30000});
  await page.fill("#name-input",env.TRADOVATE_USERNAME);
  await page.fill("#password-input",env.TRADOVATE_PASSWORD);
  await page.click("button:has-text('Login')");
  await page.waitForTimeout(5000);
  if(page.url().includes("current-sessions")){
    const b=page.locator("button:has-text('Close oldest session and Continue to login'), a:has-text('Close oldest session and Continue to login')").first();
    if(await b.count()){await b.click();await page.waitForTimeout(6000);}
  }
  const sim=page.locator("button:has-text('Access Simulation'), a:has-text('Access Simulation')").first();
  if(await sim.count()){await sim.click();await page.waitForTimeout(10000);}

  // find ALL elements mentioning EQUITY, dump each one's full outerHTML
  const matches=await page.evaluate(()=>{
    const out=[];
    for(const el of document.querySelectorAll("div,span")){
      const own=(el.childNodes.length===1&&el.childNodes[0].nodeType===3)?el.textContent:null;
      const t=(el.textContent||"").replace(/\s+/g," ");
      if(t.includes("EQUITY")&&t.length<600){
        out.push({tag:el.tagName,cls:(el.className||"").toString().slice(0,40),len:t.length,html:el.outerHTML.slice(0,1500)});
      }
    }
    return out.slice(0,6);
  });
  for(const m of matches){console.log("=== ",m.tag,m.cls,"len",m.len,"===\n",m.html,"\n");}
}finally{await browser.close();}
