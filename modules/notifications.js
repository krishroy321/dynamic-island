import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {NotificationManager} from '../core/notification-manager.mjs';

export const NotificationPeek = GObject.registerClass({
    Signals: {
        'peek': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_JSOBJECT, GObject.TYPE_JSOBJECT]},
    },
}, class NotificationPeek extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._sourceAddedId = 0;
        this._sourceConns = new Map();
        this._pendingDismiss = new Map();
        this._notificationConns = new Map();
        this._manager = new NotificationManager({groupWindowMs: 30000, maxItems: 40});
        this._currentId = null;
    }

    start() {
        const tray = Main.messageTray;
        if (!tray) return;
        this._sourceAddedId = tray.connect('source-added', (_, source) => this._trackSource(source));
        for (const source of tray.getSources()) this._trackSource(source);
    }

    stop() {
        if (this._sourceAddedId) {
            try { Main.messageTray.disconnect(this._sourceAddedId); } catch (_) {}
            this._sourceAddedId = 0;
        }
        for (const [source, rec] of this._sourceConns) {
            try { if (rec?.addedId)   source.disconnect(rec.addedId);   } catch (_) {}
            try { if (rec?.destroyId) source.disconnect(rec.destroyId); } catch (_) {}
        }
        this._sourceConns.clear();
        for (const t of this._pendingDismiss.values()) GLib.source_remove(t);
        this._pendingDismiss.clear();
        for (const [notif, id] of this._notificationConns) {
            try { notif.disconnect(id); } catch (_) {}
        }
        this._notificationConns.clear();
        this._manager.clear();
        this._currentId = null;
    }

    destroy() { this.stop(); }

    _trackSource(source) {
        if (this._sourceConns.has(source)) return;
        const addedId = source.connect('notification-added', (_, notif) => this._onNotif(source, notif));
        const destroyId = source.connect('destroy', () => {
            const rec = this._sourceConns.get(source);
            if (rec?.addedId)   { try { source.disconnect(rec.addedId); }   catch (_) {} }
            this._sourceConns.delete(source);
        });
        this._sourceConns.set(source, {addedId, destroyId});
    }

    _onNotif(source, notif) {
        const ttl = this._settings.get_int('notif-auto-dismiss');
        const persistent = this._isResident(notif) || Number(notif?.urgency) >= 3;
        const sourceKey = source?.app?.id ?? source?.id ?? source?.title ?? 'unknown';
        const entry = this._manager.enqueue({
            sourceKey,
            source,
            notif,
            title: notif?.title ?? source?.title ?? 'Notification',
            body: notif?.bannerBodyText ?? notif?.body ?? '',
            icon: notif?.gicon ?? source?.icon ?? null,
            urgency: Number(notif?.urgency ?? 1),
            persistent,
            duration: Math.max(12000, ttl > 0 ? ttl * 1000 : 12000),
            action: typeof notif?.activate === 'function' ? () => notif.activate() : null,
        });
        const current = this._manager.current();
        if (current && (current.id !== this._currentId || current.id === entry.id)) {
            this._currentId = current.id;
            this.emit('peek', current.source, current.notif, current);
        }

        if (ttl > 0 && !persistent) {
            const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ttl, () => {
                this._pendingDismiss.delete(notif);
                if (entry.notif === notif) this._manager.dismiss(entry.id);
                try { notif?.destroy?.(); } catch (e) { logError(e, 'nexnotch:notifications'); }
                return GLib.SOURCE_REMOVE;
            });
            this._pendingDismiss.set(notif, timer);
        }

        try {
            const destroyId = notif.connect?.('destroy', () => {
                const t = this._pendingDismiss.get(notif);
                if (t) { GLib.source_remove(t); this._pendingDismiss.delete(notif); }
                if (entry.notif === notif) this._manager.dismiss(entry.id);
                this._notificationConns.delete(notif);
            });
            if (destroyId) this._notificationConns.set(notif, destroyId);
        } catch (_) {}
    }

    advance() {
        if (this._currentId) this._manager.advance(this._currentId);
        this._currentId = null;
        const next = this._manager.current();
        if (!next) return;
        this._currentId = next.id;
        this.emit('peek', next.source, next.notif, next);
    }

    _isResident(notif) {
        if (!notif) return false;
        if (notif.resident) return true;
        if (notif.urgency === 2) return true;
        if (notif.isTransient === false && notif.acknowledged === false && notif.urgency === 2) return true;
        return false;
    }
});
