const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1480, height: 4200 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto('file://' + path.resolve(__dirname, 'game-ui-mockups.html'));
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'game-ui-mockups.png', fullPage: true });
  await browser.close();
})();
