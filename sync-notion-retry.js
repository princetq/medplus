const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ 
  auth: process.env.NOTION_TOKEN,
  timeoutMs: 60_000,
  notionVersion: '2025-09-03'  // ✅ API version mới hỗ trợ data_sources
});

const DATABASE_ID = process.env.NOTION_DATABASE_ID?.trim();
const OUTPUT_DIR = './hdsd-data';

// Validate DATABASE_ID
if (!DATABASE_ID) throw new Error('Missing NOTION_DATABASE_ID');
if (!/^[0-9a-f]{32}$/i.test(DATABASE_ID)) {
  throw new Error(`NOTION_DATABASE_ID không hợp lệ: "${DATABASE_ID}" (length: ${DATABASE_ID.length}). Cần đúng 32 ký tự hex.`);
}
if (!process.env.NOTION_TOKEN) throw new Error('Missing NOTION_TOKEN');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry với đầy đủ các loại lỗi
async function withRetry(fn, retries = 4, baseDelay = 1000) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const code = err?.code || err?.status || '';
      const shouldRetry =
        /rate_limited|429|502|503|504|timeout|ECONNRESET|Premature close/i.test(msg) ||
        code === 429 || code >= 500;
      if (!shouldRetry || i === retries) throw err;
      let wait = baseDelay * Math.pow(2, i);
      const resetHeader = err?.headers?.['x-ratelimit-reset'] || err?.headers?.['retry-after'];
      if (resetHeader) {
        const delta = parseFloat(resetHeader);
        if (delta > 0 && delta < 300) wait = delta * 1000;
      }
      console.log(`↪ retry ${i + 1}/${retries} sau ${wait}ms: ${msg}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ✅ Bước 1: Lấy data_source_id từ database
async function getDataSourceId(databaseId) {
  console.log('🔍 Đang lấy data_source_id từ database...');
  const db = await withRetry(() => notion.databases.retrieve({ database_id: databaseId }));
  
  const sources = db.data_sources;
  
  // Nếu không có data_sources (database cũ) → fallback dùng database_id như cũ
  if (!sources || sources.length === 0) {
    console.log('ℹ️  Database không có data_sources → dùng database_id trực tiếp (kiểu cũ)');
    return null;
  }
  
  if (sources.length > 1) {
    console.log(`⚠️  Database có ${sources.length} data sources, dùng source đầu tiên`);
  }
  
  const id = sources[0].id;
  console.log(`✅ data_source_id: ${id.slice(0, 8)}...`);
  return id;
}

// ✅ Bước 2: Query dùng data_source_id nếu có, fallback về database_id nếu không
async function queryAllPages(dataSourceId) {
  const pages = [];
  let cursor = null;
  do {
    let res;
    if (dataSourceId) {
      // Dùng endpoint mới /v1/data_sources/{id}/query
      res = await withRetry(() => notion.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        ...(cursor && { start_cursor: cursor }),
      }), 4, 1200);
    } else {
      // Fallback endpoint cũ /v1/databases/{id}/query
      res = await withRetry(() => notion.databases.query({
        database_id: DATABASE_ID,
        page_size: 100,
        ...(cursor && { start_cursor: cursor }),
      }), 4, 1200);
    }
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
    if (cursor) await sleep(500);
  } while (cursor);
  return pages;
}

// Tải chi tiết nội dung (blocks) của một trang
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

function getTitle(page) {
  const prop = Object.values(page.properties || {}).find(p => p.type === 'title');
  return prop?.title?.[0]?.plain_text || page.id.replace(/-/g, '');
}

async function main() {
  console.log('🔄 Bắt đầu Full Sync Notion HDSD...');
  console.log(`   DATABASE_ID: ${DATABASE_ID.slice(0, 8)}... (${DATABASE_ID.length} ký tự)`);

  // Bước 1: Lấy data_source_id
  const dataSourceId = await getDataSourceId(DATABASE_ID);

  // Bước 2: Lấy tất cả trang
  const pages = await queryAllPages(dataSourceId);
  console.log(`📄 Notion hiện có ${pages.length} tờ`);

  const notionIds = new Set(pages.map(p => p.id.replace(/-/g, '')));
  const indexMap = new Map();
  let success = 0, skipped = 0, failed = 0, deleted = 0;

  // Dọn dẹp: Xóa file local nếu không còn trên Notion
  if (fs.existsSync(OUTPUT_DIR)) {
    const localFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
    for (const file of localFiles) {
      const fileId = file.replace('.json', '');
      if (!notionIds.has(fileId)) {
        console.log(`🗑️ Đang xóa file cũ (đã xóa trên Notion): ${file}`);
        fs.unlinkSync(path.join(OUTPUT_DIR, file));
        deleted++;
      }
    }
  }

  // Cập nhật hoặc thêm mới trang
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageId = page.id.replace(/-/g, '');
    const lastEditedTime = page.last_edited_time;
    const filePath = path.join(OUTPUT_DIR, `${pageId}.json`);

    let needUpdate = true;
    if (fs.existsSync(filePath)) {
      try {
        const localData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (localData.page && localData.page.last_edited_time === lastEditedTime) {
          needUpdate = false;
        }
      } catch (e) {
        needUpdate = true;
      }
    }

    if (!needUpdate) {
      process.stdout.write(` [${i + 1}/${pages.length}] ${pageId}... ⏩ Giữ nguyên\n`);
      indexMap.set(pageId, { id: pageId, title: getTitle(page), last_edited_time: lastEditedTime });
      skipped++;
      continue;
    }

    try {
      process.stdout.write(` [${i + 1}/${pages.length}] ${pageId}... 📥 Tải nội dung... `);
      const blocks = await withRetry(() => fetchDeep(page.id), 3, 1500);
      const synced_at = new Date().toISOString();

      fs.writeFileSync(filePath, JSON.stringify({ page, blocks, synced_at }, null, 2), 'utf-8');
      indexMap.set(pageId, { id: pageId, title: getTitle(page), last_edited_time: lastEditedTime });
      console.log('✅');
      success++;

      await sleep(400);
    } catch (err) {
      const detail = [err?.status, err?.code, err?.message].filter(Boolean).join(' | ');
      console.log(`❌ Lỗi: ${detail}`);
      failed++;
    }
  }

  // Lưu index.json
  const finalIndex = Array.from(indexMap.values()).sort((a, b) =>
    (b.last_edited_time || '').localeCompare(a.last_edited_time || '')
  );
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(finalIndex, null, 2), 'utf-8');

  console.log(`\n✨ HOÀN THÀNH TỔNG KẾT:`);
  console.log(`- Cập nhật/Mới: ${success}`);
  console.log(`- Không thay đổi: ${skipped}`);
  console.log(`- Đã xóa: ${deleted}`);
  console.log(`- Thất bại: ${failed}`);

  if (failed > 0 && success === 0 && skipped === 0) {
    throw new Error(`Toàn bộ ${failed} trang đều thất bại.`);
  }
}

main().catch(err => {
  console.error('❌ Sync thất bại nghiêm trọng:', err.message);
  process.exit(1);
});
