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
  await page.waitForTimeout(1000);
  await page.locator("#add-tpsl-option").first().click();
  await page.waitForTimeout(1500);
  await page.locator('[data-testid="bracket-0-take-profit-input"] input').first().fill("4");
  await page.locator('[data-testid="bracket-0-stop-loss-input"] input').first().fill("4");
  await page.getByText("Save",{exact:true}).first().click();
  await page.waitForTimeout(2000);

  // WITHOUT re-clicking the select, check strategy link visibility
  const links=page.locator('a:has-text("Strategy")');
  const n=await links.count();
  console.log("strategy links:",n);
  const vis=[];
  for(let i=0;i<n;i++){vis.push({id:await links.nth(i).getAttribute("id"),v:await links.nth(i).isVisible().catch(()=>false)});}
  console.log(JSON.stringify(vis,null,1));
  // try clicking last directly
  if(n>0){await links.last().click();await page.waitForTimeout(800);}
  console.log("select text after direct click:",JSON.stringify(await sel.innerText().catch(()=>"N/A")));
}finally{await browser.close();}
