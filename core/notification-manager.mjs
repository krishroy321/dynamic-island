const PRIORITY = Object.freeze({LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3});

function priorityFor(urgency) {
    if (urgency >= 3) return PRIORITY.CRITICAL;
    if (urgency === 2) return PRIORITY.HIGH;
    if (urgency === 0) return PRIORITY.LOW;
    return PRIORITY.NORMAL;
}

export class NotificationManager {
    constructor({groupWindowMs = 30000, maxItems = 40} = {}) {
        this.groupWindowMs = groupWindowMs;
        this.maxItems = maxItems;
        this._items = [];
        this._sequence = 0;
    }

    enqueue(input, now = Date.now()) {
        const sourceKey = String(input.sourceKey ?? input.appName ?? 'unknown');
        const existing = this._items.find(item => item.sourceKey === sourceKey && now - item.updatedAt <= this.groupWindowMs);
        if (existing) {
            existing.title = input.title || existing.title;
            existing.body = input.body || existing.body;
            existing.icon = input.icon ?? existing.icon;
            existing.action = input.action ?? existing.action;
            existing.notif = input.notif ?? existing.notif;
            existing.source = input.source ?? existing.source;
            existing.priority = Math.max(existing.priority, priorityFor(input.urgency ?? 1));
            existing.persistent ||= Boolean(input.persistent);
            existing.count++;
            existing.updatedAt = now;
            existing.state = 'queued';
            existing.expiresAt = input.persistent ? 0 : (now + Math.max(1000, input.duration ?? 12000));
            this._sort();
            return existing;
        }

        const item = {
            id: String(input.id ?? `notification-${++this._sequence}`),
            sourceKey,
            source: input.source ?? null,
            title: input.title ?? 'Notification',
            body: input.body ?? '',
            icon: input.icon ?? null,
            timestamp: now,
            updatedAt: now,
            priority: priorityFor(input.urgency ?? 1),
            duration: Math.max(0, input.duration ?? 12000),
            persistent: Boolean(input.persistent),
            action: input.action ?? null,
            group: sourceKey,
            count: 1,
            state: 'queued',
            expiresAt: input.persistent ? 0 : now + Math.max(1000, input.duration ?? 12000),
            notif: input.notif ?? null,
        };
        this._items.push(item);
        this._sort();
        while (this._items.length > this.maxItems) this._items.pop();
        return item;
    }

    current(now = Date.now()) {
        this.expire(now);
        const item = this._items[0] ?? null;
        if (item) item.state = 'visible';
        return item;
    }

    pending(now = Date.now()) {
        this.expire(now);
        return this._items.map(item => ({...item}));
    }

    advance(id, now = Date.now()) {
        const index = this._items.findIndex(item => item.id === id);
        if (index >= 0) this._items.splice(index, 1);
        return this.current(now);
    }

    dismiss(id) {
        const index = this._items.findIndex(item => item.id === id);
        if (index < 0) return false;
        this._items.splice(index, 1);
        return true;
    }

    expire(now = Date.now()) {
        this._items = this._items.filter(item => item.persistent || item.expiresAt > now);
    }

    clear() {
        this._items.length = 0;
    }

    _sort() {
        this._items.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);
    }
}
