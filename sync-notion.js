const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const OUTPUT_DIR = './hdsd-data';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Fetch đệ quy toàn bộ block con
async function fetchDeep(blockId) {
    const blocks = [];
    let cursor = null;
    do {
        const res = await notion.blocks.children.list({
            block_id: blockId,
            page_size: 100,
            ...(cursor && { start_cursor: cursor }),
        });
        blocks.push(...res.results);
        cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);

    // Fetch đệ quy block con, tối đa 3 request song song
    const LIMIT = 3;
    const toFetch = blocks.filter(b => b.has_children);
    for (let i = 0; i < toFetch.length; i += LIMIT) {
        await Promise.all(
            toFetch.slice(i, i + LIMIT).map(async b => {
                b._children = await fetchDeep(b.id);
            })
        );
    }

    // XỬ LÝ ẢNH UPLOAD NOTION: Xóa URL S3 hết hạn, chỉ giữ blockId
    // Worker sẽ fetch URL S3 mới khi người dùng cần xem ảnh
    for (const block of blocks) {
        if (block.type === 'image' && block.image?.type === 'file') {
            block.image._proxy = true;
            block.image._blockId = block.id;
            delete block.image.file.url; // Xóa URL S3 hết hạn
        }
        // Ảnh external (link ngoài) giữ nguyên, không cần proxy
    }

    return blocks;
}

async function main() {
    console.log('🔄 Bắt đầu sync Notion HDSD...\n');

    // Lấy toàn bộ trang trong database (hỗ trợ pagination > 100 tờ)
    let cursor = null;
    const allPages = [];
    do {
        const res = await notion.databases.query({
            database_id: DATABASE_ID,
            page_size: 100,
            ...(cursor && { start_cursor: cursor }),
        });
        allPages.push(...res.results);
        cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);

    console.log(`📄 Tìm thấy ${allPages.length} tờ HDSD\n`);

    const index = [];
    let success = 0, failed = 0;

    for (let i = 0; i < allPages.length; i++) {
        const page = allPages[i];
        const pageId = page.id.replace(/-/g, '');
        process.stdout.write(`  [${i + 1}/${allPages.length}] ${pageId}... `);

        try {
            const blocks = await fetchDeep(page.id);

            // Lưu từng tờ thành 1 file JSON riêng
            fs.writeFileSync(
                path.join(OUTPUT_DIR, `${pageId}.json`),
                JSON.stringify({ page, blocks, synced_at: new Date().toISOString() }),
                'utf-8'
            );

            // Lấy title từ property đầu tiên có type = title
            const titleProp = Object.values(page.properties || {})
                .find(p => p.type === 'title');
            const title = titleProp?.title?.[0]?.plain_text || pageId;

            index.push({ id: pageId, title, synced_at: new Date().toISOString() });
            console.log('✅');
            success++;
        } catch (err) {
            console.log(`❌ ${err.message}`);
            failed++;
        }

        // Nghỉ nhẹ giữa các tờ để tránh rate limit Notion (3 req/s)
        if (i < allPages.length - 1) {
            await new Promise(r => setTimeout(r, 350));
        }
    }

    // Lưu file index tổng — trang web dùng để biết có những tờ nào
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'index.json'),
        JSON.stringify(index, null, 2),
        'utf-8'
    );

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`✅ Sync xong! Thành công: ${success} | Lỗi: ${failed}`);
    console.log(`📁 Dữ liệu lưu tại: ${OUTPUT_DIR}/`);
}

main().catch(err => {
    console.error('\n❌ Sync thất bại:', err.message);
    process.exit(1);
});
