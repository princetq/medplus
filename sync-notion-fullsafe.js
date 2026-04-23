const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const OUTPUT_DIR = './hdsd-data';
const CHECKPOINT_PATH = path.join(OUTPUT_DIR, 'checkpoint.json');
const INDEX_PATH = path.join(OUTPUT_DIR, 'index.json');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, retries = 5, baseDelay = 1200) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const shouldRetry = /rate_limited|429|502|503|504|timeout|ECONNRESET/i.test(msg);
      if (!shouldRetry || i === retries) throw err;
      const wait = baseDelay * Math.pow(2, i);
      console.log(`    ↪ retry ${i + 1}/${retries} sau ${wait}ms: ${msg}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_PATH)) return { startAt: 0, done: [] };
  try {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
    return {
      startAt: Number(cp.startAt || 0),
      done: Array.isArray(cp.done) ? cp.done : [],
    };
  } catch {
    return { startAt: 0, done: [] };
  }
}

function saveCheckpoint(startAt, done) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ startAt, done }, null, 2), 'utf-8');
}

async function fetchDeep(blockId) {
  const blocks = [];
  let cursor = null;
  do {
    const res = await withRetry(() => notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    }));
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
    if (cursor) await sleep(700);
  } while (cursor);

  const toFetch = blocks.filter(b => b.has_children);
  for (const b of toFetch) {
    b._children = await fetchDeep(b.id);
    await sleep(400);
  }

  for (const block of blocks) {
    if (block.type === 'image' && block.image?.type === 'file') {
      block.image._proxy = true;
      block.image._blockId = block.id;
      delete block.image.file.url;
    }
  }

  return blocks;
}

async function queryAllPages() {
  const pages = [];
  let cursor = null;
  do {
    const res = await withRetry(() => notion.databases.query({
      database_id: DATABASE_ID,
      page_size: 100,
      ...(cursor && { start_cursor: cursor }),
    }), 5, 1500);
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
    if (cursor) await sleep(1000);
  } while (cursor);
  return pages;
}

function getTitle(page) {
  const prop = Object.values(page.properties || {}).find(p => p.type === 'title');
  return prop?.title?.[0]?.plain_text || page.id.replace(/-/g, '');
}

async function main() {
  console.log('🔄 Bắt đầu sync full lần đầu...');
  const checkpoint = loadCheckpoint();
  const allPages = await queryAllPages();
  console.log(`📄 Tổng số trang: ${allPages.length}`);
  console.log(`▶️ Tiếp tục từ vị trí: ${checkpoint.startAt}`);

  let index = [];
  if (fs.existsSync(INDEX_PATH)) {
    try {
      const oldIndex = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
      if (Array.isArray(oldIndex)) index = oldIndex;
    } catch {}
  }
  const indexMap = new Map(index.map(x => [x.id, x]));

  for (let i = checkpoint.startAt; i < allPages.length; i++) {
    const page = allPages[i];
    const pageId = page.id.replace(/-/g, '');
    process.stdout.write(`  [${i + 1}/${allPages.length}] ${pageId}... `);
    try {
      const blocks = await withRetry(() => fetchDeep(page.id), 5, 1500);
      const synced_at = new Date().toISOString();
      fs.writeFileSync(path.join(OUTPUT_DIR, `${pageId}.json`), JSON.stringify({ page, blocks, synced_at }, null, 2), 'utf-8');
      indexMap.set(pageId, { id: pageId, title: getTitle(page), synced_at });
      saveCheckpoint(i + 1, Array.from(indexMap.keys()));
      console.log('✅');
    } catch (err) {
      console.log(`❌ ${err.message}`);
      saveCheckpoint(i, Array.from(indexMap.keys()));
      await sleep(3000);
    }

    if ((i + 1) % 20 === 0) {
      console.log(`⏸ Nghỉ dài sau mỗi 20 tờ để tránh rate limit...`);
      await sleep(8000);
    } else {
      await sleep(1200);
    }
  }

  const finalIndex = Array.from(indexMap.values());
  fs.writeFileSync(INDEX_PATH, JSON.stringify(finalIndex, null, 2), 'utf-8');
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ startAt: allPages.length, done: Array.from(indexMap.keys()) }, null, 2), 'utf-8');
  console.log(`\n✅ Hoàn tất full sync. Tổng tờ đã lưu: ${finalIndex.length}`);
}

main().catch(err => {
  console.error('❌ Sync thất bại:', err.message);
  process.exit(1);
});
