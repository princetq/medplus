const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const OUTPUT_DIR = './hdsd-data';

if (!DATABASE_ID) throw new Error('Missing NOTION_DATABASE_ID');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Hàm retry để xử lý lỗi mạng hoặc Rate Limit của Notion
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
    
    // Kiểm tra xem trang có thay đổi gì so với file local không
    let needUpdate = true;
    if (fs.existsSync(filePath)) {
      try {
        const localData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Nếu thời gian sửa đổi giống hệt nhau, không cần tải lại nội dung block
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
      
      // Nghỉ ngắn để tránh bị Notion giới hạn tốc độ
      await sleep(400);
    } catch (err) {
      console.log(`❌ Lỗi: ${err.message}`);
      failed++;
    }
  }

  // 4. Lưu index.json (chỉ chứa các trang hiện đang tồn tại)
  const finalIndex = Array.from(indexMap.values()).sort((a, b) => 
    (b.last_edited_time || '').localeCompare(a.last_edited_time || '')
  );
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(finalIndex, null, 2), 'utf-8');
  
  console.log(`\n✨ HOÀN THÀNH TỔNG KẾT:`);
  console.log(`- Cập nhật/Mới: ${success}`);
  console.log(`- Không thay đổi: ${skipped}`);
  console.log(`- Đã xóa: ${deleted}`);
  console.log(`- Thất bại: ${failed}`);
}

main().catch(err => {
  console.error('❌ Sync thất bại nghiêm trọng:', err.message);
  process.exit(1);
});
