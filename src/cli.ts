import { readFileSync } from 'fs';
import { runScrape, runScreenshots, runScore, runFullPipeline, runPost } from './pipeline.js';
import { getStatus, runMigration } from './db.js';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'migrate': {
      console.log('Running database migration...');
      const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf-8');
      await runMigration(sql);
      console.log('Migration complete');
      break;
    }

    case 'scrape':
      await runScrape();
      break;

    case 'screenshot':
      await runScreenshots();
      break;

    case 'score':
      await runScore();
      break;

    case 'run':
      await runFullPipeline();
      break;

    case 'post': {
      const limit = parseInt(process.argv[3] || '5', 10);
      await runPost(limit);
      break;
    }

    case 'status': {
      const status = await getStatus();
      console.log('\n=== Property Drop Bot Status ===');
      console.log(`  Areas enabled:     ${status.areas}`);
      console.log(`  Properties:        ${status.properties}`);
      console.log(`  Transactions:      ${status.transactions}`);
      console.log(`  Queue (pending):   ${status.pending}`);
      console.log(`  Queue (posted):    ${status.posted}`);
      console.log(`  Posted today:      ${status.postedToday}`);
      console.log('');
      break;
    }

    default:
      console.log(`Usage: npm run cli <command>

Commands:
  migrate      Run database schema migration
  scrape       Scrape all enabled areas
  screenshot   Take screenshots of properties with drops
  score        Score properties and populate post queue
  run          Full pipeline: scrape → screenshot → score
  post [n]     Post top N pending items (default: 5)
  status       Show bot status summary`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
