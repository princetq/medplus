.const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN, timeoutMs: 60_000 });
const DATABASE_ID = process.env.NOTION_DATABASE_ID?.trim();
const OUTPUT_DIR = './hdsd-data';

// ✅ FIX 1: Validate kỹ DATABASE_ID trước khi chạy
if (!DATABASE_ID) throw new Error('Missing NOTION_DATABASE_ID');
if (!/^[0-9a-f]{32}$/i.test(DATABASE_ID)) {
  throw new Error(`NOTION_DATABASE_ID không hợp lệ: "${DATABASE_ID}" (length: ${DATABASE_ID.length}). Cần đúng 32 ký tự hex.`);
}
if (!process.env.NOTION_TOKEN) throw new Error('Missing NOTION_TOKEN');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ✅ FIX 2: Retry bổ sung thêm "Premature close" và invalid_request_url
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
      // ✅ FIX 3: Đọc đúng header RateLimit-Reset (giờ là số giây delta, không phải timestamp)
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

// Lấy toàn bộ danh sách trang hiện có trong Database
async function queryAllPages() {
  const pages = [];
  let cursor = null;
  do {
    const payload = { database_id: DATABASE_ID, page_size: 100 };
    if (cursor) payload.start_cursor = cursor;

    const res = await withRetry(() => notion.databases.query(payload), 4, 1200);
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
    if (cursor) await sleep(500);
  } while (cursor);
  return pages;
}

function getTitle(page) {
  const prop = Object.values(page.properties || {}).find(p => p.type === 'title');
  return prop?.title?.[0]?.plain_text || page.id.replace(/-/g, '');
}

async function main() {
  console.log('🔄 Bắt đầu Full Sync Notion HDSD...');
  console.log(`   DATABASE_ID: ${DATABASE_ID.slice(0, 8)}... (${DATABASE_ID.length} ký tự)`);

  // 1. Lấy tất cả trang từ Notion
  const pages = await queryAllPages();
  console.log(`📄 Notion hiện có ${pages.length} tờ`);

  const notionIds = new Set(pages.map(p => p.id.replace(/-/g, '')));
  const indexMap = new Map();
  let success = 0, skipped = 0, failed = 0, deleted = 0;

  // 2. Dọn dẹp: Xóa file local nếu không còn trên Notion
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

  // 3. Cập nhật hoặc thêm mới trang
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
      // ✅ FIX 4: Log chi tiết lỗi từng trang (status, code, message) thay vì chỉ message
      const detail = [err?.status, err?.code, err?.message].filter(Boolean).join(' | ');
      console.log(`❌ Lỗi: ${detail}`);
      failed++;
    }
  }

  // 4. Lưu index.json
  const finalIndex = Array.from(indexMap.values()).sort((a, b) =>
    (b.last_edited_time || '').localeCompare(a.last_edited_time || '')
  );
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(finalIndex, null, 2), 'utf-8');

  console.log(`\n✨ HOÀN THÀNH TỔNG KẾT:`);
  console.log(`- Cập nhật/Mới: ${success}`);
  console.log(`- Không thay đổi: ${skipped}`);
  console.log(`- Đã xóa: ${deleted}`);
  console.log(`- Thất bại: ${failed}`);

  // ✅ Nếu tất cả đều thất bại thì exit 1 để GitHub Actions báo lỗi
  if (failed > 0 && success === 0 && skipped === 0) {
    throw new Error(`Toàn bộ ${failed} trang đều thất bại.`);
  }
}

main().catch(err => {
  console.error('❌ Sync thất bại nghiêm trọng:', err.message);
  process.exit(1);
});
