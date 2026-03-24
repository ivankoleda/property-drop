import { chromium, type BrowserContext } from 'playwright';
import { existsSync } from 'fs';
import { join } from 'path';

const AUTH_DIR = './twitter-auth';
const USER_DATA_DIR = join(AUTH_DIR, 'chrome-profile');
const DEBUG_DIR = './screenshots/debug';

async function launchChrome(headless: boolean = true) {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return context;
}

export async function twitterLogin(): Promise<void> {
  const { mkdirSync } = await import('fs');
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

  const context = await launchChrome(false);
  const page = context.pages()[0] || await context.newPage();

  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('\n=== Log in to Twitter/X in the browser window ===');
  console.log('Once you see your home feed, press Enter here to save the session.\n');

  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  console.log('Session saved (persistent Chrome profile)');
  await context.close();
}

export async function postTweet(
  text: string,
  imagePaths: string[],
  replyText?: string,
  headless: boolean = false,
): Promise<string | null> {
  const { mkdirSync } = await import('fs');
  if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR, { recursive: true });

  if (!existsSync(USER_DATA_DIR)) {
    throw new Error('No Twitter session found. Run `npm run cli twitter-login` first.');
  }

  console.log(`  [browser] Launching Chrome (${headless ? 'headless' : 'visible'})...`);
  const context = await launchChrome(headless);
  const page = context.pages()[0] || await context.newPage();

  try {
    // Step 1: Navigate to home and open compose via Post button
    console.log('  [browser] Opening home page...');
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${DEBUG_DIR}/01_home_loaded.png` });

    // Check URL — did we get redirected to login?
    const url = page.url();
    console.log(`  [browser] Current URL: ${url}`);
    if (url.includes('login') || url.includes('signin')) {
      await page.screenshot({ path: `${DEBUG_DIR}/01_redirected_to_login.png` });
      throw new Error('Not logged in — session expired. Run `npm run cli twitter-login` again.');
    }

    // Dismiss cookie banner if present
    const cookieBtn = page.locator('button:has-text("Accept all cookies"), [data-testid="xMigrationBottomBar"] button').first();
    if (await cookieBtn.count() > 0) {
      await cookieBtn.click();
      console.log('  [browser] Dismissed cookie banner');
      await page.waitForTimeout(1000);
    }

    // Click the Post/compose button in the sidebar to open compose dialog
    console.log('  [browser] Clicking Post button...');
    const sidebarPostBtn = page.locator('a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]').first();
    await sidebarPostBtn.waitFor({ timeout: 10000 });
    await sidebarPostBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${DEBUG_DIR}/01_compose_opened.png` });

    // Step 2: Find compose box
    console.log('  [browser] Waiting for compose box...');
    const composeBox = page.locator('[data-testid="tweetTextarea_0"]').first();
    await composeBox.waitFor({ timeout: 10000 });
    console.log('  [browser] Compose box found');

    // Step 3: Type text (human-like: click, pause, type slowly)
    await composeBox.click();
    await page.waitForTimeout(500);
    await page.keyboard.type(text, { delay: 80 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${DEBUG_DIR}/02_text_typed.png` });
    console.log(`  [browser] Typed: "${text}"`);

    // Step 4: Attach images
    for (const imgPath of imagePaths) {
      const absolutePath = join(process.cwd(), imgPath);
      if (!existsSync(absolutePath)) {
        console.log(`  [browser] SKIP image not found: ${absolutePath}`);
        continue;
      }
      console.log(`  [browser] Attaching: ${imgPath}`);
      const fileInput = page.locator('input[type="file"][accept*="image"]').first();
      await fileInput.setInputFiles(absolutePath);
      await page.waitForTimeout(2000);
    }
    await page.screenshot({ path: `${DEBUG_DIR}/03_images_attached.png` });
    console.log(`  [browser] ${imagePaths.length} images attached`);

    // Step 5: Click Post (human-like: hover, pause, click)
    console.log('  [browser] Clicking Post button...');
    const postButton = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
    const isEnabled = await postButton.isEnabled();
    console.log(`  [browser] Post button enabled: ${isEnabled}`);

    await postButton.hover();
    await page.waitForTimeout(300 + Math.random() * 500);
    await postButton.click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${DEBUG_DIR}/04_after_post_click.png` });

    // Check for error banners
    const errorBanner = page.locator('text=automated, text=Something went wrong, text=try again').first();
    if (await errorBanner.count() > 0) {
      const errorText = await errorBanner.textContent();
      console.log(`  [browser] ERROR: Twitter blocked post — "${errorText}"`);
      console.log('  [browser] Try posting with visible browser: set headless=false');
      throw new Error(`Twitter blocked: ${errorText}`);
    }

    console.log(`  [browser] Post clicked, URL now: ${page.url()}`);

    // Step 6: Verify the tweet was posted by checking profile
    console.log('  [browser] Checking profile for new tweet...');
    await page.goto('https://x.com/LondonPriceDrop', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${DEBUG_DIR}/05_profile.png` });

    // Get the first tweet link
    let tweetId: string | null = null;
    const tweetLinks = page.locator('a[href*="/LondonPriceDrop/status/"]');
    const count = await tweetLinks.count();
    console.log(`  [browser] Found ${count} tweet links on profile`);

    if (count > 0) {
      const href = await tweetLinks.first().getAttribute('href');
      const match = href?.match(/\/status\/(\d+)/);
      if (match) {
        tweetId = match[1];
        console.log(`  [browser] Latest tweet ID: ${tweetId}`);
      }
    }

    // Step 7: Post reply (if provided)
    if (replyText && replyText.length > 0 && tweetId) {
      console.log(`  [browser] Posting reply to ${tweetId}...`);
      await page.goto(`https://x.com/LondonPriceDrop/status/${tweetId}`, {
        waitUntil: 'domcontentloaded', timeout: 15000,
      });
      await page.waitForTimeout(2000);

      const replyBox = page.locator('[data-testid="tweetTextarea_0"]').first();
      await replyBox.waitFor({ timeout: 5000 }).catch(() => null);

      if (await replyBox.count() > 0) {
        await replyBox.click();
        await page.keyboard.type(replyText, { delay: 20 });
        await page.waitForTimeout(500);

        const replyButton = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
        await replyButton.click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: `${DEBUG_DIR}/06_reply_posted.png` });
        console.log('  [browser] Reply posted');
      } else {
        console.log('  [browser] Reply box not found, skipping reply');
      }
    }

    return tweetId;
  } finally {
    await context.close();
    console.log('  [browser] Chrome closed');
  }
}
