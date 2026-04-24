const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const OUTPUT_DIR = './hdsd-data';

if (!DATABASE_ID) throw new Error('Missing NOTION_DATABASE_ID');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, retries = 4, baseDelay = 1000) {
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
      console.log(`↪ retry ${i + 1}/${retries} sau ${wait}ms: ${msg}`);
      await sleep(wait);
    }
  }
  throw lastErr;
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
    if (cursor) await sleep(400);
  } while (cursor);

  const toFetch = blocks.filter(b => b.has_children);
  for (const b of toFetch) {
    b._children = await fetchDeep(b.id);
    await sleep(250);
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

async function queryDatabaseIncremental() {
  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  let lastSync = null;
  if (fs.existsSync(indexPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(idx) && idx.length && idx[0].synced_at) {
        lastSync = idx.reduce((m, x) => !x.synced_at ? m : (!m || x.synced_at > m ? x.synced_at : m), null);
      }
    } catch {}
  }

  const pages = [];
  let cursor = null;
  do {
    const filters = [];
    if (lastSync) {
      filters.push({ timestamp: "last_edited_time", last_edited_time: { after: lastSync } });
    }
    const payload = { database_id: DATABASE_ID, page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    if (filters.length) payload.filter = filters[0];

    const res = await withRetry(() => notion.databases.query(payload), 4, 1200);
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
    if (cursor) await sleep(700);
  } while (cursor);

  return pages;
}

function getTitle(page) {
  const prop = Object.values(page.properties || {}).find(p => p.type === 'title');
  return prop?.title?.[0]?.plain_text || page.id.replace(/-/g, '');
}

async function main() {
  console.log('🔄 Bắt đầu sync Notion HDSD...');
  const pages = await queryDatabaseIncremental();
  console.log(`📄 Tìm thấy ${pages.length} tờ cần sync`);

  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  let index = [];
  if (fs.existsSync(indexPath)) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (!Array.isArray(index)) index = [];
    } catch { index = []; }
  }

  const indexMap = new Map(index.map(x => [x.id, x]));
  let success = 0, failed = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageId = page.id.replace(/-/g, '');
    process.stdout.write(` [${i + 1}/${pages.length}] ${pageId}... `);
    try {
      const blocks = await withRetry(() => fetchDeep(page.id), 3, 1500);
      const synced_at = new Date().toISOString();
      fs.writeFileSync(path.join(OUTPUT_DIR, `${pageId}.json`), JSON.stringify({ page, blocks, synced_at }, null, 2), 'utf-8');
      indexMap.set(pageId, { id: pageId, title: getTitle(page), synced_at });
      console.log('✅');
      success++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
    }
    if (i + 1 < pages.length) await sleep(1000);
  }

  index = Array.from(indexMap.values()).sort((a, b) => (b.synced_at || '').localeCompare(a.synced_at || ''));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  console.log(`\n✅ Xong. Thành công: ${success}, Lỗi: ${failed}`);
}

main().catch(err => {
  console.error('❌ Sync thất bại:', err.message);
  process.exit(1);
});
