import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Notch} from './notch.js';

export default class NexNotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.nexnotch');

        /* Evolution Data Server's source-registry D-Bus service sometimes
           doesn't auto-activate on login; when that happens Calendar and
           Tasks come up empty. If the binary is discoverable via $PATH or
           the standard libexec prefixes, kick it once — idempotent. This
           replaces the previous hard-coded /usr/libexec/... path so the
           extension stays portable across distros. */
        try {
            const candidates = [
                GLib.find_program_in_path('evolution-source-registry'),
                '/usr/libexec/evolution-source-registry',
                '/usr/lib/evolution-data-server/evolution-source-registry',
                '/usr/lib64/evolution-data-server/evolution-source-registry',
            ].filter(p => p && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE));
            if (candidates.length) {
                Gio.Subprocess.new([candidates[0]],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            }
        } catch (_) {}

        this._notch = new Notch(this);

        /* Mount the notch into the top chrome layer — OUTSIDE the panel's
           actor tree. This keeps any Shell.BlurEffect that blur-my-shell
           attaches to the panel from bleeding through the notch. */
        Main.layoutManager.addTopChrome(this._notch, {
            trackFullscreen: true,
            affectsStruts: false,
        });

        this._reposition = () => this._positionNotch();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', this._reposition);
        this._panelAllocId = Main.panel.connect('notify::allocation', this._reposition);
        this._focusMonitorId = 0;
        try {
            this._focusMonitorId = global.display.connect('notify::focus-window', this._reposition);
        } catch (_) {}
        this._settingsMonitorId = this._settings.connect('changed', (_, key) => {
            if (['monitor-mode', 'monitor-index', 'top-offset', 'horizontal-offset'].includes(key))
                this._positionNotch();
        });
        this._notchAllocId = this._notch.connect('notify::allocation', this._reposition);
        this._notchWidthId = this._notch.connect('notify::width', this._reposition);
        this._notchHeightId = this._notch.connect('notify::height', this._reposition);
        this._positionNotch();

        this._notch.start();
    }

    _positionNotch() {
        if (!this._notch) return;
        const monitor = this.getTargetMonitor();
        if (!monitor) return;
        const [, natW] = this._notch.get_preferred_width(-1);
        const [, natH] = this._notch.get_preferred_height(natW);
        /* Use the allocated width first. The natural width can describe the
           collapsed child while the actor is already animating to its
           expanded width, which previously made the island drift left. */
        const allocatedW = Number(this._notch.width) || 0;
        const w = allocatedW > 0 ? allocatedW : (natW || 240);
        const horizontalOffset = this._settings.get_int('horizontal-offset');
        const topOffset = this._settings.get_int('top-offset');
        const x = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - w - 8,
            monitor.x + Math.floor((monitor.width - w) / 2) + horizontalOffset));
        const y = monitor.y + topOffset;
        this._notch.set_position(x, y);
    }

    getTargetMonitor() {
        const monitors = Main.layoutManager.monitors ?? [];
        if (!monitors.length) return Main.layoutManager.primaryMonitor ?? null;
        const mode = this._settings.get_string('monitor-mode');
        if (mode === 'focused') {
            try {
                const index = global.display.focus_window?.get_monitor();
                if (index >= 0 && monitors[index]) return monitors[index];
            } catch (_) {}
        }
        if (mode === 'fixed') {
            const index = this._settings.get_int('monitor-index');
            if (monitors[index]) return monitors[index];
        }
        return Main.layoutManager.primaryMonitor ?? monitors[0];
    }

    reposition() { this._positionNotch(); }

    disable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._panelAllocId) {
            try { Main.panel.disconnect(this._panelAllocId); } catch (_) {}
            this._panelAllocId = 0;
        }
        if (this._focusMonitorId) {
            try { global.display.disconnect(this._focusMonitorId); } catch (_) {}
            this._focusMonitorId = 0;
        }
        if (this._settingsMonitorId) {
            try { this._settings.disconnect(this._settingsMonitorId); } catch (_) {}
            this._settingsMonitorId = 0;
        }
        if (this._notchAllocId) {
            try { this._notch?.disconnect(this._notchAllocId); } catch (_) {}
            this._notchAllocId = 0;
        }
        for (const key of ['_notchWidthId', '_notchHeightId']) {
            if (this[key]) {
                try { this._notch?.disconnect(this[key]); } catch (_) {}
                this[key] = 0;
            }
        }
        if (this._notch) {
            this._notch.stop();
            try { Main.layoutManager.removeChrome(this._notch); } catch (_) {}
            this._notch.destroy();
            this._notch = null;
        }
        this._reposition = null;
        this._settings = null;
    }
}
