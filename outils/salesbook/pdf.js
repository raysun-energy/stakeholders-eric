const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 960, height: 540 } });
  await p.goto('file://' + __dirname + '/book.html'); await p.waitForTimeout(800);
  const over = await p.$$eval('.s', (ss) => ss.map((s, k) => { let max = 0; s.querySelectorAll(':scope > *:not(.foot):not(.circle):not(.in):not(.meta)').forEach((e) => { max = Math.max(max, e.getBoundingClientRect().bottom - s.getBoundingClientRect().top); }); return [k + 1, Math.round(max)]; }).filter(([, m]) => m > 518));
  console.log('débordements :', JSON.stringify(over));
  await p.pdf({ path: process.argv[2], width: '960px', height: '540px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await b.close(); })();
