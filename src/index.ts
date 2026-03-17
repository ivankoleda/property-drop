import cron from 'node-cron';
import { config } from './config.js';
import { runPost } from './pipeline.js';

console.log(`Property Drop Bot - Poster Service`);
console.log(`Schedule: ${config.bot.postSchedule}`);
console.log(`Daily cap: ${config.bot.dailyPostCap}`);

cron.schedule(config.bot.postSchedule, async () => {
  console.log(`[${new Date().toISOString()}] Cron triggered`);
  try {
    await runPost();
  } catch (err) {
    console.error('Post job failed:', err);
  }
});

console.log('Cron scheduler started. Waiting for next trigger...');
