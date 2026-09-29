const VIEW_VALUES = new Set(['cards', 'list']);

export function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

export function matchesSearch(item, search, fields) {
    const terms = normalizeText(search).split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const haystack = fields.map(field => normalizeText(item?.[field])).join(' ');
    return terms.every(term => haystack.includes(term));
}

export function sortItems(items, field, direction = 'asc', type = 'text') {
    if (!field) return [...items];
    const multiplier = direction === 'desc' ? -1 : 1;
    const value = item => {
        if (type === 'number') return Number(item?.[field] || 0);
        if (type === 'date') return Date.parse(item?.[field] || '') || 0;
        return normalizeText(item?.[field]);
    };
    return [...items].sort((a, b) => {
        const left = value(a);
        const right = value(b);
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * multiplier;
        return String(left).localeCompare(String(right), 'pt-BR') * multiplier;
    });
}

export function paginate(items, page = 1, pageSize = 20) {
    const size = Math.max(1, Number(pageSize) || 20);
    const pages = Math.max(1, Math.ceil(items.length / size));
    const safePage = Math.min(Math.max(1, Number(page) || 1), pages);
    const start = (safePage - 1) * size;
    return {
        items: items.slice(start, start + size),
        total: items.length,
        pages,
        page: safePage,
        pageSize: size
    };
}

export function timestampNoPeriodoCalendario(timestamp, periodo = 'all', agora = new Date()) {
    const data = new Date(timestamp);
    const referencia = agora instanceof Date ? new Date(agora) : new Date(agora);
    if (!Number.isFinite(data.getTime()) || !Number.isFinite(referencia.getTime())) return false;
    if (periodo === 'all') return true;

    const dias = periodo === 'today' ? 1 : periodo === '7days' ? 7 : periodo === '30days' ? 30 : 0;
    if (!dias) return true;
    const inicio = new Date(referencia);
    inicio.setHours(0, 0, 0, 0);
    inicio.setDate(inicio.getDate() - (dias - 1));
    return data >= inicio && data <= referencia;
}

export function preferenceKey(uid, module, preference = 'view') {
    return `checklog-ui:${uid || 'anonymous'}:${module}:${preference}`;
}

export function getViewPreference(storage, uid, module) {
    const stored = storage?.getItem?.(preferenceKey(uid, module, 'view'));
    return VIEW_VALUES.has(stored) ? stored : 'cards';
}

export function setViewPreference(storage, uid, module, view) {
    const safeView = VIEW_VALUES.has(view) ? view : 'cards';
    storage?.setItem?.(preferenceKey(uid, module, 'view'), safeView);
    return safeView;
}

export function getPreference(storage, uid, module, preference, fallback = '') {
    return storage?.getItem?.(preferenceKey(uid, module, preference)) ?? fallback;
}

export function setPreference(storage, uid, module, preference, value) {
    storage?.setItem?.(preferenceKey(uid, module, preference), String(value));
    return value;
}
