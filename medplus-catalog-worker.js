let catalog = [];
let aliases = [];
let overrides = [];
let combos = [];
let allHybridText = '';
let allImageText = '';

function norm(v) {
    return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function phrase(text, value) {
    text = String(text || ' ').trim(); value = String(value || ' ').trim();
    if (!text || !value) return false;
    return (' ' + text + ' ').indexOf(' ' + value + ' ') >= 0;
}
function clean(v) { return String(v || 'Đang cập nhật').replace(/\s+/g, ' ').trim() || 'Đang cập nhật'; }
function activeFamilies(active, brand) {
    const found = new Set();
    const a = norm(active), b = norm(brand), compact = b.replace(/\s+/g, '');
    for (const group of aliases) {
        const canonical = norm(group && group[0]);
        if (!canonical) continue;
        for (const alias of (group || [])) {
            const k = norm(alias);
            if (k && phrase(a, k)) { found.add(canonical); break; }
        }
    }
    for (const rule of overrides) {
        const canonical = norm(rule && rule.family);
        for (const name of ((rule && rule.brands) || [])) {
            const k = norm(name);
            if (k && (b === k || compact === k.replace(/\s+/g, ''))) { if (canonical) found.add(canonical); }
        }
    }
    for (const profile of combos) {
        let hit = false;
        for (const name of ((profile && profile.brandOverrides) || [])) {
            const k = norm(name);
            if (k && (b === k || compact === k.replace(/\s+/g, ''))) { hit = true; break; }
        }
        if (hit) for (const family of ((profile && profile.families) || [])) found.add(norm(family));
    }
    // Fallback: giữ nguyên active khi không có alias để vẫn có thể match
    // chính xác theo chuỗi với các hoạt chất không nằm trong alias list.
    if (!found.size && a) found.add(a);
    return Array.from(found);
}
function makeHybridLine(row, position) {
    return position + '. Tên: ' + clean(row.brand) + ' | Hoạt chất: ' + clean(row.active) + ' | Nhóm dược lý: ' + clean(row.group);
}
function makeImageLine(row, position) {
    let line = position + '. Biệt dược: ' + clean(row.brand) + ' | Hoạt chất: ' + clean(row.active);
    if (row.group) line += ' | Nhóm: ' + clean(row.group);
    line += ' | Hàm lượng: ' + clean(row.strength) + ' | Dạng: ' + clean(row.form);
    if (row.link) line += ' | HDSD: ' + row.link;
    return line;
}
function textFor(indices, format) {
    const rows = Array.isArray(indices) ? indices.map(i => catalog[i]).filter(Boolean) : catalog;
    return rows.map((row, pos) => format === 'image' ? makeImageLine(row, pos + 1) : makeHybridLine(row, pos + 1)).join('\n');
}
function init(payload) {
    aliases = payload.aliases || [];
    overrides = payload.overrides || [];
    combos = payload.combos || [];
    catalog = (payload.catalog || []).map(function(d, index) {
        const row = {
            index: index,
            brand: d && (d.brand || d.name) || '', active: d && d.active || '', group: d && d.group || '',
            strength: d && d.strength || '', form: d && d.form || '', link: d && d.link || ''
        };
        row.brandNorm = norm(row.brand); row.activeNorm = norm(row.active);
        row.families = activeFamilies(row.active, row.brand);
        row.isCombo = row.families.length >= 2;
        return row;
    });
    allHybridText = textFor(null, 'hybrid');
    allImageText = textFor(null, 'image');
}
function questionFamily(question) {
    const q = norm(question);
    let best = null;
    for (const group of aliases) {
        const canonical = norm(group && group[0]);
        for (const alias of (group || [])) {
            const k = norm(alias);
            if (k && phrase(q, k) && (!best || k.length > best.alias.length)) best = { family: canonical, alias: k };
        }
    }
    return best && best.family;
}
function matchingProfile(question) {
    const q = norm(question);
    for (const profile of combos) {
        for (const alias of ((profile && profile.aliases) || [])) {
            const k = norm(alias);
            if (k && phrase(q, k)) return profile;
        }
    }
    return null;
}
function expand(payload) {
    const selected = Array.isArray(payload.selectedIndexes) ? payload.selectedIndexes.filter(i => Number.isInteger(i) && catalog[i]) : [];
    if (!payload.directIntent) return { indexes: Array.from(new Set(selected)), mode: 'selected' };
    const profile = matchingProfile(payload.question);
    if (profile) {
        const required = (profile.families || []).map(norm).filter(Boolean);
        const indexes = catalog.filter(row => row.isCombo && required.every(f => row.families.indexOf(f) >= 0))
            .sort((a,b) => String(a.brand).localeCompare(String(b.brand), 'vi')).map(row => row.index);
        return { indexes: indexes, mode: 'combination' };
    }
    const family = questionFamily(payload.question);
    if (!family) return { indexes: Array.from(new Set(selected)), mode: 'selected' };
    const singles = [], relatedCombos = [];
    for (const row of catalog) {
        if (row.families.indexOf(family) < 0) continue;
        (row.isCombo ? relatedCombos : singles).push(row);
    }
    const sorter = (a,b) => String(a.brand).localeCompare(String(b.brand), 'vi');
    singles.sort(sorter); relatedCombos.sort(sorter);
    return { indexes: singles.concat(relatedCombos).map(row => row.index), mode: 'active-family', family: family };
}
self.onmessage = function(event) {
    const msg = event.data || {};
    try {
        if (msg.type === 'prime') { init(msg.payload || {}); self.postMessage({ id: msg.id, ok: true, result: { count: catalog.length } }); return; }
        if (msg.type === 'catalogText') {
            const p = msg.payload || {}; const result = p.format === 'image' && !Array.isArray(p.indexes) ? allImageText : (p.format === 'hybrid' && !Array.isArray(p.indexes) ? allHybridText : textFor(p.indexes, p.format));
            self.postMessage({ id: msg.id, ok: true, result: result }); return;
        }
        if (msg.type === 'expand') { self.postMessage({ id: msg.id, ok: true, result: expand(msg.payload || {}) }); return; }
        self.postMessage({ id: msg.id, ok: false, error: 'UNKNOWN_WORKER_TASK' });
    } catch (error) { self.postMessage({ id: msg.id, ok: false, error: String(error && error.message || error) }); }
};
