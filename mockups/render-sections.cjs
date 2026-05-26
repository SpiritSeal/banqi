const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1480, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + path.resolve(__dirname, 'game-ui-mockups.html'));
  await page.waitForLoadState('networkidle');
  const sections = await page.$$('.section');
  for (let i = 0; i < sections.length; i++) {
    const box = await sections[i].boundingBox();
    if (!box) continue;
    const name = i === 0 ? 'portrait' : i === 1 ? 'landscape' : i === 2 ? 'desktop' : `section-${i}`;
    await sections[i].screenshot({ path: `mockup-${name}.png` });
    console.log(`wrote mockup-${name}.png (${Math.round(box.width)}x${Math.round(box.height)})`);
  }
  await browser.close();
})();
