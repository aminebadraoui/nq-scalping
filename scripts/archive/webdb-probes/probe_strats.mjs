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
  const sel=page.locator('[data-testid="simple-tpsl-atm-strategy-select"]').first();
  await sel.click();
  await page.waitForTimeout(1200);
  // dump li + a items with their text and visibility + tag
  const items=await page.evaluate(()=>{
    const out=[];
    for(const el of document.querySelectorAll("li, a")){
      const t=(el.textContent||"").trim();
      if(/^Strategy\s*\d+$/.test(t)){
        const r=el.getBoundingClientRect();
        out.push({tag:el.tagName,text:t,w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x),y:Math.round(r.y)});
      }
    }
    return out;
  });
  console.log(JSON.stringify(items,null,2));
}finally{await browser.close();}
