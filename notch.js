import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {LiquidGlassMaterial} from './material.js';
import {computeCompactLayout, computeIslandLayout} from './core/layout.mjs';
import {PRESENTATION_STATES, TransitionController} from './core/transition-controller.mjs';

import {SystemMonitor}    from './modules/system.js';
import {NotificationPeek} from './modules/notifications.js';
import {CalendarPeek}     from './modules/calendar.js';
import {MprisWatcher}     from './modules/mpris.js';
import {Notes}            from './modules/notes.js';
import {Weather}          from './modules/weather.js';
import {Pomodoro}         from './modules/pomodoro.js';
import {QuickHub}         from './modules/quick.js';
import {Stats}            from './modules/stats.js';
import {ClaudeUsage}      from './modules/claudeusage.js';

/* Shared timings for geometry and content transitions. Hover remains a
   material-only response and never opens the dashboard. */
const MOTION = Object.freeze({
    expand: 280,
    collapse: 240,
    content: 220,
    resize: 220,
    peekDuration: 5500,
});

function motionDuration(settings, name) {
    const duration = MOTION[name] ?? MOTION.content;
    return settings.get_boolean('reduced-motion') ? Math.min(120, duration) : duration;
}

export const Notch = GObject.registerClass(
class Notch extends St.Widget {
    _init(extension) {
        super._init({
            name: 'nexnotch',
            style_class: 'nexnotch',
            reactive: true,
            track_hover: true,
            can_focus: false,
            layout_manager: new Clutter.BinLayout(),
            /* Position is computed explicitly in extension.js; do not let a
               parent layout override the centered x coordinate. */
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        this._extension = extension;
        this._settings  = extension.getSettings();

        this._expanded    = false;
        this._state = 'COMPACT';
        this._transitionController = new TransitionController('COMPACT');
        this._peekActive  = false;
        this._clockTimer      = 0;
        this._activeTab = 'system';

        this._loadDims();
        this.set_size(this._cwMin, this._ch);

        this._buildLayers();
        this._setupDnd();
        this._applyColors();
        this._material.setQuality(this._settings.get_string('material-quality'));
        this._hideDateMenuIfRequested();

        this._modules = {
            system:        new SystemMonitor(this._settings),
            notifications: new NotificationPeek(this._settings),
            calendar:      new CalendarPeek(this._settings),
            mpris:         new MprisWatcher(),
            notes:         new Notes(this._settings),
            weather:       new Weather(this._settings),
            pomodoro:      new Pomodoro(this._settings),
            quick:         new QuickHub(this._settings),
            stats:         new Stats(this._settings),
            claude:        new ClaudeUsage(this._settings),
        };
        this._modules.notes.setGrabActor(this);
        this._modules.notes.connect('updated', () => { if (this._expanded && this._activeTab === 'notes') this._renderTab(); });
        /* show pomodoro mini label at startup with idle styling */
        this._pomoUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pomoUpdateId = 0;
            if (this._stopped) return GLib.SOURCE_REMOVE;
            this._updatePomodoroIndicator();
            return GLib.SOURCE_REMOVE;
        });

        this._modules.system.connect('updated',             (_, s)      => this._onSystemUpdated(s));
        this._modules.notifications.connect('peek',         (_, src, n, entry) => this._peekNotification(src, n, entry));
        this._modules.calendar.connect('updated', () => {
            if (this._expanded && (this._activeTab === 'calendar' || this._activeTab === 'tasks')) {
                this._renderTab();
            }
        });
        this._modules.mpris.connect('changed',              (_, info)   => this._updateMedia(info));
        this._modules.mpris.connect('progress',             (_, p)      => this._updateMediaProgress(p));
        this._modules.weather.connect('updated',            ()          => { if (this._expanded && this._activeTab === 'weather') this._renderTab(); });
        this._modules.pomodoro.connect('tick',              ()          => { if (this._expanded && this._activeTab === 'pomodoro') this._renderTab(); this._updatePomodoroIndicator(); });
        this._modules.pomodoro.connect('state',             ()          => { if (this._expanded && this._activeTab === 'pomodoro') this._renderTab(); this._updatePomodoroIndicator(); this._syncCompactState(); });
        this._modules.quick.connect('updated',              ()          => { if (this._expanded && this._activeTab === 'quick') this._renderTab(); this._updatePrivacyIndicator(); });
        this._modules.claude.connect('updated',              ()          => { if (this._expanded && this._activeTab === 'claude') this._renderTab(); });

        this._hoverHandlerId = this.connect('notify::hover', () => this._onHoverChanged());
        this._motionHandlerId = this.connect('motion-event', (_actor, event) => {
            const [px, py] = event.get_coords();
            const [ax, ay] = this.get_transformed_position();
            this._material?.setPointer(px - ax, py - ay);
            return Clutter.EVENT_PROPAGATE;
        });
        this._allocationHandlerId = this.connect('notify::allocation', () =>
            this._material?.setGeometry(this.width, this.height));
        this._pressHandlerId = this.connect('button-press-event', () => {
            this._material?.setState('PRESS');
            return Clutter.EVENT_PROPAGATE;
        });
        this._releaseHandlerId = this.connect('button-release-event', (_actor, event) => {
            this._material?.setState(this.hover ? 'HOVER' : (this._expanded ? 'EXPANDED' : 'REST'));
            if (!this._expanded && !this._peekActive && event.get_button?.() === 1) {
                this._expand();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => this._onDestroy());

        this._settingsSig = this._settings.connect('changed', (_, key) => this._onSettingChanged(key));
    }

    _loadDims() {
        this._cwMin = Math.max(180, Math.min(240, this._settings.get_int('collapsed-width')));
        this._ch    = Math.max(42, Math.min(56, this._settings.get_int('collapsed-height')));
        this._ew    = this._settings.get_int('expanded-width');
        this._eh    = this._settings.get_int('expanded-height');
        this._radius = this._settings.get_int('corner-radius');
    }

    _setState(state) {
        if (!PRESENTATION_STATES.includes(state)) return;
        this._state = state;
        this._transitionController?.setState(state);
        this._material?.setState(state);
    }

    _syncCompactState() {
        if (this._state === 'EXPANDING' || this._state === 'COLLAPSING') return;
        if (this._peekActive) this._setState('NOTIFICATION');
        else if (this._modules?.pomodoro?.isActive?.() || this._modules?.pomodoro?.getState?.() === 'paused')
            this._setState('TIMER');
        else if (this._latestMedia?.playing || this._latestMedia?.paused) this._setState('MEDIA');
        else this._setState(this._expanded ? 'EXPANDED' : 'COMPACT');
    }

    _measureCollapsedWidth() {
        try {
            const [, natW] = this._collapsed.get_preferred_width(this._ch);
            const monitorWidth = this._extension.getTargetMonitor?.()?.width ?? (this._cwMin + 24);
            const available = Math.max(1, monitorWidth - 24);
            return computeCompactLayout({
                contentWidth: natW,
                preferredWidth: this._cwMin,
                availableWidth: available,
                height: this._ch,
            }).width;
        } catch (_) { return this._cwMin; }
    }

    _measureExpandedWidth() {
        let contentWidth = this._ew;
        try { contentWidth = this._expandedLayer.get_preferred_width(-1)[1] || this._ew; } catch (_) {}
        const monitorWidth = this._extension.getTargetMonitor?.()?.width ?? this._ew + 24;
        const available = Math.max(1, monitorWidth - 32);
        return computeIslandLayout({
            contentWidth,
            minimumWidth: Math.min(420, available),
            preferredWidth: Math.min(this._ew, available),
            maximumWidth: Math.min(960, available),
            availableWidth: available,
        }).width;
    }

    _resizeCollapsed(animate = true) {
        if (this._expanded || this._peekActive) return;
        const target = this._measureCollapsedWidth();
        if (animate) {
            this.remove_all_transitions();
            this.ease({
                width: target, height: this._ch,
                duration: motionDuration(this._settings, 'resize'), mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        } else {
            this.set_size(target, this._ch);
        }
    }

    _parseCssColor(value, fallback) {
        const match = String(value ?? '').match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
        if (!match) return fallback;
        return {
            r: Math.max(0, Math.min(255, Number(match[1]))),
            g: Math.max(0, Math.min(255, Number(match[2]))),
            b: Math.max(0, Math.min(255, Number(match[3]))),
            a: Math.max(0, Math.min(1, match[4] === undefined ? 1 : Number(match[4]))),
        };
    }

    _rgba(color, alpha = color.a) {
        return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Math.max(0, Math.min(1, alpha)).toFixed(2)})`;
    }

    _applyColors() {
        const bg = this._parseCssColor(this._settings.get_string('bg-color'), {r: 8, g: 10, b: 16, a: 0.86});
        const accent = this._parseCssColor(this._settings.get_string('accent-color'), {r: 120, g: 170, b: 255, a: 0.32});
        const radius = this._settings.get_int('corner-radius');
        const surfaceRadius = Math.max(18, radius);
        const activeTint = this._rgba(accent, Math.min(0.28, 0.10 + accent.a * 0.45));
        this._material.setColors({background: bg, accent, radius: surfaceRadius, hover: Boolean(this.hover)});
        this.set_style(`background-color: transparent; border-radius: ${surfaceRadius}px;`);

        this._glassAccent = activeTint;
        this._activeTabStyle = `background-color: ${activeTint}; color: white; border-radius: 10px;`;

        for (const [tid, btn] of Object.entries(this._tabButtons ?? {})) {
            if (tid === this._activeTab) btn.set_style(this._activeTabStyle);
            else btn.set_style('background-color: transparent; color: rgba(255,255,255,0.58); border-radius: 10px;');
        }

        this._updateBatteryIcon();
    }

    _hideDateMenuIfRequested() {
        const wantHide = this._settings.get_boolean('hide-datemenu');
        const dm = Main.panel.statusArea?.dateMenu;
        if (!dm?.container) return;
        if (wantHide) {
            if (this._dmWasVisible === undefined) this._dmWasVisible = dm.container.visible;
            dm.container.visible = false;
        } else if (this._dmWasVisible !== undefined) {
            dm.container.visible = this._dmWasVisible;
        }
    }

    _restoreDateMenu() {
        const dm = Main.panel.statusArea?.dateMenu;
        if (dm?.container && this._dmWasVisible !== undefined) {
            dm.container.visible = this._dmWasVisible;
        }
    }

    _onSettingChanged(key) {
        if (key.startsWith('collapsed-') || key.startsWith('expanded-') || key === 'corner-radius') {
            this._loadDims();
            if (!this._expanded && !this._peekActive) this._resizeCollapsed(false);
            if (this._expanded) this.set_size(this._ew, this._eh);
            this._applyColors();
        }
        if (['bg-color', 'accent-color', 'corner-radius',
             'battery-charging-color', 'battery-normal-color', 'battery-low-color'].includes(key)) {
            this._applyColors();
        }
        if (key === 'hide-datemenu') this._hideDateMenuIfRequested();
        if (key === 'clock-format' || key === 'show-seconds' || key === 'show-date') {
            this._updateClocks();
            this._resizeCollapsed();
        }
        if (key.startsWith('show-') && key !== 'show-seconds' && key !== 'show-date') {
            for (const [id, btn] of Object.entries(this._tabButtons ?? {})) {
                btn.visible = this._tabEnabled(id);
            }
            /* If the currently-active tab was disabled, switch to System. */
            if (!this._tabEnabled(this._activeTab)) this._switchTab('system');
            /* also start/stop the corresponding module so polling matches UI */
            this._reconcileModulesWithPrefs();
        }
        if (key === 'material-quality')
            this._material?.setQuality(this._settings.get_string('material-quality'));
        if (key === 'monitor-mode' || key === 'monitor-index' || key === 'top-offset' || key === 'horizontal-offset')
            this._extension.reposition?.();
    }

    _buildLayers() {
        this._material = new LiquidGlassMaterial();
        this._bg = this._material.actor;
        this.add_child(this._bg);

        /* collapsed layout:  [battery] [media]   HH:MM   [date]   [shelf#] */
        this._collapsed = new St.BoxLayout({
            style_class: 'nexnotch-collapsed',
            vertical: false,
            x_expand: true, y_expand: true,
        });
        this.add_child(this._collapsed);

        /* left cluster */
        this._leftCluster = new St.BoxLayout({style_class: 'nexnotch-cluster nexnotch-left', vertical: false});
        this._batteryIcon = new St.Icon({
            icon_name: 'battery-full-symbolic',
            icon_size: 14,
            style_class: 'nexnotch-battery-icon',
            visible: false,
        });
        this._mediaIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 14,
            style_class: 'nexnotch-media-icon',
            visible: false,
        });
        /* statusDot / privacyDot removed — see note above */
        /* statusDot (hot CPU/RAM/temp) and privacyDot (mic/cam) removed per
           user request — battery icon conveys charge, and user finds extra
           coloured dots redundant. Privacy state is still visible in the
           Quick tab. */
        this._pomoLabel = new St.Label({text: '', style_class: 'nexnotch-pomo-mini', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._leftCluster.add_child(this._pomoLabel);
        this._leftCluster.add_child(this._batteryIcon);
        this._leftCluster.add_child(this._mediaIcon);
        /* music pill — extends the collapsed notch with track title + artist
           in the Dynamic Island / NotchNook style when MPRIS is active */
        this._musicPill = new St.BoxLayout({
            style_class: 'nexnotch-music-pill',
            vertical: false,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._musicTitle  = new St.Label({style_class: 'nexnotch-music-title'});
        this._musicArtist = new St.Label({style_class: 'nexnotch-music-artist'});
        this._musicPill.add_child(this._musicTitle);
        this._musicPill.add_child(new St.Label({text: ' · ', style_class: 'nexnotch-music-sep'}));
        this._musicPill.add_child(this._musicArtist);
        this._leftCluster.add_child(this._musicPill);

        /* center clock */
        this._centerCluster = new St.BoxLayout({
            style_class: 'nexnotch-cluster nexnotch-center',
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._clockLabel = new St.Label({text: '', style_class: 'nexnotch-clock', y_align: Clutter.ActorAlign.CENTER});
        this._centerCluster.add_child(this._clockLabel);

        /* right cluster: date */
        this._rightCluster = new St.BoxLayout({style_class: 'nexnotch-cluster nexnotch-right', vertical: false});
        this._dateLabelC = new St.Label({text: '', style_class: 'nexnotch-date-mini', y_align: Clutter.ActorAlign.CENTER});
        /* pomoLabel now lives in _leftCluster (user-preferred position) */
        this._rightCluster.add_child(this._dateLabelC);

        this._collapsed.add_child(this._leftCluster);
        this._collapsed.add_child(this._centerCluster);
        this._collapsed.add_child(this._rightCluster);

        /* expanded layer */
        this._expandedLayer = new St.BoxLayout({
            style_class: 'nexnotch-expanded',
            vertical: true,
            x_expand: true, y_expand: true,
            opacity: 0,
            visible: false,
            reactive: false,
        });
        /* Keep expanded modules out of the compact actor tree. This prevents
           their natural size and input region from affecting startup. */

        this._header = new St.BoxLayout({style_class: 'nexnotch-header', vertical: false});
        this._bigClock  = new St.Label({text: '', style_class: 'nexnotch-big-clock'});
        const dateCol = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._dateLabel  = new St.Label({text: '', style_class: 'nexnotch-date', x_align: Clutter.ActorAlign.END});
        this._monthLabel = new St.Label({text: '', style_class: 'nexnotch-date-month', x_align: Clutter.ActorAlign.END});
        dateCol.add_child(this._dateLabel);
        dateCol.add_child(this._monthLabel);
        this._header.add_child(this._bigClock);
        this._header.add_child(new St.Widget({x_expand: true}));
        this._header.add_child(dateCol);
        this._expandedLayer.add_child(this._header);

        this._tabs = new St.BoxLayout({style_class: 'nexnotch-tabs', vertical: false});
        this._content = new St.Bin({style_class: 'nexnotch-content', x_expand: true, y_expand: true});
        this._expandedLayer.add_child(this._tabs);
        this._expandedLayer.add_child(this._content);

        this._tabButtons = {};
        const tabIds = ['system', 'claude', 'calendar', 'tasks', 'notes', 'weather', 'pomodoro', 'stats', 'quick'];
        for (const id of tabIds) {
            const btn = new St.Button({
                style_class: 'nexnotch-tab',
                label: this._tabLabel(id),
                can_focus: true,
                x_expand: true,
                track_hover: true,
                visible: this._tabEnabled(id),
            });
            btn.connect('clicked', () => this._switchTab(id));
            this._tabs.add_child(btn);
            this._tabButtons[id] = btn;
        }

        this._peekLayer = null;
    }

    _setupDnd() {
        try {
            Main.wm.addKeybinding('shortcut-toggle',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._expanded ? this._collapse() : this._expand());
            this._keybindings = ['shortcut-toggle'];
        } catch (e) { logError(e, 'nexnotch:keybinding'); }
    }

    _tabLabel(id) {
        return {
            system: 'System', calendar: 'Cal', tasks: 'Tasks',
            notes:  'Notes',  weather:  'Weather', pomodoro: 'Timer',
            stats:  'Stats',  quick: 'Quick', claude: 'Limits',
        }[id] ?? id;
    }

    _tabEnabled(id) {
        const key = {
            system:   'show-system',
            calendar: 'show-calendar',
            tasks:    'show-tasks',
            notes:    null,
            weather:  null,
            pomodoro: null,
            stats:    null,
            quick:    null,
            claude:   'show-claude-usage',
        }[id];
        if (!key) return true;
        return this._settings.get_boolean(key);
    }

    start() {
        this._stopped = false;
        this._destroyed = false;
        this._setState('COMPACT');
        /* Natural-size queries need St theme nodes, which are only available
           after extension.js attaches this actor to GNOME Shell's stage. */
        this._resizeCollapsed(false);
        /* gate modules whose matching show-* key is off, so they don't poll
           resources in the background. start/stop is idempotent inside each
           module. */
        this._startEnabledModules();
        this._startClock();
        this._updateBatteryIcon();
    }

    _startEnabledModules() {
        for (const [name, mod] of Object.entries(this._modules)) {
            if (this._moduleEnabled(name)) {
                try { mod.start?.(); mod._running = true; } catch (e) { logError(e); }
            } else {
                mod._running = false;
            }
        }
    }

    _reconcileModulesWithPrefs() {
        for (const [name, mod] of Object.entries(this._modules)) {
            const enabled = this._moduleEnabled(name);
            const running = !!mod._running;
            if (enabled && !running)  { try { mod.start?.(); mod._running = true;  } catch (e) { logError(e); } }
            if (!enabled && running)  { try { mod.stop?.();  mod._running = false; } catch (e) { logError(e); } }
        }
    }

    _moduleEnabled(name) {
        if (name === 'calendar')      return this._tabEnabled('calendar') || this._tabEnabled('tasks');
        if (name === 'system')        return this._settings.get_boolean('show-system');
        if (name === 'notifications') return this._settings.get_boolean('show-notifications');
        if (name === 'claude')        return this._settings.get_boolean('show-claude-usage');
        return true;
    }

    stop() {
        if (this._stopped) return;
        this._stopped = true;
        this._disconnectExpandedInput();
        this._stopClock();
        if (this._wakeSigId && this._wakeProxy) { try { this._wakeProxy.disconnectSignal(this._wakeSigId); } catch (_) {} this._wakeSigId = 0; }
        this._wakeProxy = null;
        if (this._pomoUpdateId) { GLib.source_remove(this._pomoUpdateId); this._pomoUpdateId = 0; }
        if (this._peekTimer)    { GLib.source_remove(this._peekTimer);    this._peekTimer    = 0; }
        for (const id of this._bannerKillTimers ?? []) {
            try { GLib.source_remove(id); } catch (_) {}
        }
        this._bannerKillTimers?.clear();
        for (const m of Object.values(this._modules)) m.stop?.();
        this._restoreDateMenu();
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = 0; }
        for (const key of this._keybindings ?? []) {
            try { Main.wm.removeKeybinding(key); } catch (_) {}
        }
        this._keybindings = [];
    }

    _onDestroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._disconnectExpandedInput();
        this._stopClock();
        /* Extension.disable() calls stop() before destroying the actor. Do
           not destroy every module a second time: several Shell services
           (notably MessageTray during logout) may already be disposed by the
           time the actor's destroy signal runs. */
        if (!this._stopped) {
            for (const m of Object.values(this._modules ?? {})) m.destroy?.();
        }
        this._material?.destroy();
        this._material = null;
        this._modules = {};
    }

    _startClock() {
        this._updateClocks();
        this._scheduleClockTick();
        this._watchWake();
    }

    /* GLib timers are driven by the monotonic clock, which stops advancing
       during suspend. On resume the pending tick fires late and shows a
       stale time for the rest of that period (up to a full minute) — this
       is the "clock is 1-2 min behind" symptom on laptops. Force an
       immediate resync when logind reports the system woke up. */
    _watchWake() {
        try {
            this._wakeProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.login1',
                g_object_path: '/org/freedesktop/login1',
                g_interface_name: 'org.freedesktop.login1.Manager',
            });
            this._wakeProxy.init(null);
            this._wakeSigId = this._wakeProxy.connectSignal('PrepareForSleep', (_p, _s, [starting]) => {
                if (!starting) { this._stopClock(); this._updateClocks(); this._scheduleClockTick(); }
            });
        } catch (e) { logError(e, 'nexnotch:wake-watch'); }
    }

    _scheduleClockTick() {
        const showSec = this._settings.get_boolean('show-seconds');
        const period  = showSec ? 1000 : 60000;
        const now = Date.now();
        const delay = Math.max(20, period - (now % period));
        this._clockTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._updateClocks();
            this._scheduleClockTick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopClock() {
        if (this._clockTimer) { GLib.source_remove(this._clockTimer); this._clockTimer = 0; }
    }

    _updateClocks() {
        const now = new Date();
        const showSec   = this._settings.get_boolean('show-seconds');
        const showDate  = this._settings.get_boolean('show-date');
        const h12       = this._settings.get_string('clock-format') === '12h';
        const timeOpts = {
            hour: '2-digit', minute: '2-digit',
            hour12: h12,
            ...(showSec ? {second: '2-digit'} : {}),
        };
        const time = now.toLocaleTimeString([], timeOpts);
        this._clockLabel.text = time;
        this._bigClock.text   = time;
        if (showDate) {
            this._dateLabelC.text = this._formatCompactDate(now);
            this._dateLabelC.visible = true;
        } else {
            this._dateLabelC.visible = false;
        }
        this._dateLabel.text  = now.toLocaleDateString([], {weekday: 'long', day: 'numeric'});
        this._monthLabel.text = now.toLocaleDateString([], {month: 'long'});
    }

    _formatCompactDate(d) {
        const day   = d.getDate();
        const month = d.toLocaleDateString([], {month: 'long'});
        /* Full name if ≤5 chars, otherwise first 3 chars (Turkish convention) */
        const display = month.length <= 5 ? month : month.slice(0, 3);
        return `${day} ${display}`;
    }

    _onHoverChanged() {
        if (this.hover) {
            this.add_style_pseudo_class('hover');
            this._material?.setState('HOVER');
            this._material?.clearPointer();
            this._applyColors();
        } else {
            this.remove_style_pseudo_class('hover');
            this._material?.setState(this._expanded ? 'EXPANDED' : 'REST');
            this._material?.clearPointer();
            this._applyColors();
        }
    }

    _connectExpandedInput() {
        this._disconnectExpandedInput();
        try {
            this._expandedInputId = global.stage.connect('captured-event', (_stage, event) => {
                const type = typeof event.type === 'function' ? event.type() :
                    typeof event.get_event_type === 'function' ? event.get_event_type() : event.type;
                if (type === Clutter.EventType.BUTTON_PRESS) {
                    const [px, py] = event.get_coords();
                    const [ax, ay] = this.get_transformed_position();
                    const [aw, ah] = this.get_transformed_size();
                    if (px < ax || px > ax + aw || py < ay || py > ay + ah)
                        this._collapse();
                }
                return Clutter.EVENT_PROPAGATE;
            });
        } catch (e) {
            logError(e, 'nexnotch:expanded-input');
        }
        try {
            Main.wm.addKeybinding('shortcut-collapse', this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => { if (this._expanded) this._collapse(); });
            this._collapseKeybindingAdded = true;
        } catch (e) {
            logError(e, 'nexnotch:collapse-keybinding');
        }
    }

    _disconnectExpandedInput() {
        if (this._expandedInputId) {
            try { global.stage.disconnect(this._expandedInputId); } catch (_) {}
            this._expandedInputId = 0;
        }
        if (this._collapseKeybindingAdded) {
            try { Main.wm.removeKeybinding('shortcut-collapse'); } catch (_) {}
            this._collapseKeybindingAdded = false;
        }
    }

    _expand() {
        if (this._expanded && this._state !== 'COLLAPSING') return;
        if (this._peekActive) this._dismissPeek(true);
        this._expanded = true;
        this._setState('EXPANDING');
        this._material?.setState('EXPANDING');
        const transition = this._transitionController.retarget('EXPANDING');
        const targetWidth = this._measureExpandedWidth();
        this._expandedWidth = targetWidth;
        this.remove_all_transitions();
        this._collapsed.remove_all_transitions();
        this._expandedLayer.remove_all_transitions();
        if (!this._expandedLayer.get_parent()) this.add_child(this._expandedLayer);
        this._expandedLayer.visible = true;
        this._expandedLayer.reactive = true;
        this._connectExpandedInput();
        this.ease({
            width: targetWidth, height: this._eh,
            duration: motionDuration(this._settings, 'expand'), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._collapsed.ease({opacity: 0, duration: motionDuration(this._settings, 'content'), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { if (this._transitionController.isCurrent(transition) && this._expanded) this._collapsed.hide(); }});
        this._expandedLayer.opacity = Math.max(this._expandedLayer.opacity, 1);
        this._expandedLayer.scale_x = 0.985; this._expandedLayer.scale_y = 0.985;
        this._expandedLayer.set_pivot_point(0.5, 0);
        this._expandedLayer.ease({
            opacity: 255, scale_x: 1, scale_y: 1,
            duration: motionDuration(this._settings, 'expand'), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (this._transitionController.isCurrent(transition) && this._expanded) {
                    this._setState('EXPANDED');
                    this._material?.setState('EXPANDED');
                    this._syncCompactState();
                }
            },
        });
        this._updateClocks();
        this._switchTab(this._activeTab);
        /* Auto-fit height to content after it's laid out. */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._stopped) return GLib.SOURCE_REMOVE;
            if (this._expanded) this._resizeExpanded();
            return GLib.SOURCE_REMOVE;
        });
    }

    _collapse() {
        if (!this._expanded && this._state !== 'EXPANDING') return;
        this._modules?.notes?._releaseGrab?.();
        this._expanded = false;
        this._setState('COLLAPSING');
        this._material?.setState('COLLAPSING');
        const transition = this._transitionController.retarget('COLLAPSING');
        this.remove_all_transitions();
        this._collapsed.remove_all_transitions();
        this._expandedLayer.remove_all_transitions();
        this._modules?.system?.setFocused?.(false);
        this._modules?.quick?.setFocused?.(false);
        this._collapsed.show();
        const targetW = this._measureCollapsedWidth();
        this.ease({
            width: targetW, height: this._ch,
            duration: motionDuration(this._settings, 'collapse'), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._collapsed.ease({opacity: 255, duration: motionDuration(this._settings, 'collapse'), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._expandedLayer.set_pivot_point(0.5, 0);
        this._expandedLayer.ease({
            opacity: 0, scale_x: 0.96, scale_y: 0.96,
            duration: motionDuration(this._settings, 'content'), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._transitionController.isCurrent(transition) && !this._expanded) {
                    this._expandedLayer.visible = false;
                    this._expandedLayer.reactive = false;
                    if (this._expandedLayer.get_parent() === this) this.remove_child(this._expandedLayer);
                    this._disconnectExpandedInput();
                    this._setState('COMPACT');
                    this._material?.setState(this.hover ? 'HOVER' : 'REST');
                    this._syncCompactState();
                }
            },
        });
    }

    _switchTab(id) {
        if (this._activeTab === 'notes' && id !== 'notes') {
            this._modules?.notes?._releaseGrab?.();
        }
        this._activeTab = id;
        /* Bump system poll to user-selected fast rate only when user is
           actually looking at the system tab, otherwise fall back to 3x */
        this._modules?.system?.setFocused?.(this._expanded && id === 'system');
        this._modules?.quick?.setFocused?.(this._expanded && id === 'quick');
        for (const [tid, btn] of Object.entries(this._tabButtons)) {
            if (tid === id) {
                btn.add_style_pseudo_class('active');
                btn.set_style(this._activeTabStyle ?? 'background-color: rgba(255,255,255,0.14); color: white; border-radius: 10px;');
            } else {
                btn.remove_style_pseudo_class('active');
                btn.set_style('background-color: transparent; color: rgba(255,255,255,0.58); border-radius: 10px;');
            }
        }
        this._renderTab();
    }

    _resizeExpanded() {
        if (!this._expanded || !this._expandedLayer) return;
        try {
            const width = this._measureExpandedWidth();
            const [, natH] = this._expandedLayer.get_preferred_height(width - 36);
            const target = Math.max(this._eh, Math.min(640, natH + 32));
            if (Math.abs(this.height - target) > 2 || Math.abs(this.width - width) > 2) {
                this.ease({
                    width, height: target,
                    duration: motionDuration(this._settings, 'resize'), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        } catch (_) {}
    }

    _renderTab() {
        if (!this._expanded) return;
        const mod = {
            system:   this._modules.system,
            calendar: this._modules.calendar,
            tasks:    this._modules.calendar,
            notes:    this._modules.notes,
            weather:  this._modules.weather,
            pomodoro: this._modules.pomodoro,
            stats:    this._modules.stats,
            quick:    this._modules.quick,
            claude:   this._modules.claude,
        }[this._activeTab];
        /* System tab gets an optional music card passed in so the whole
           bottom-right corner can be used for media controls when MPRIS
           has an active player. */
        const extraArg = this._activeTab === 'system'
            ? this._buildMusicCard()
            : this._activeTab;
        const child = mod?.render?.(extraArg);
        this._content.set_child(child ?? new St.Label({text: '—', x_align: Clutter.ActorAlign.CENTER}));
        /* nudge height after child lays out */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._stopped) return GLib.SOURCE_REMOVE;
            if (this._expanded) this._resizeExpanded();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSystemUpdated(stats) {
        this._latestStats = stats;
        this._updateBatteryIcon(stats.battery);
        if (this._expanded && this._activeTab === 'system') this._renderTab();
    }

    _updateBatteryIcon(battery) {
        battery = battery ?? this._latestStats?.battery;
        if (!battery) { this._batteryIcon.visible = false; return; }
        const cap = battery.capacity;
        const status = (battery.status ?? '').toLowerCase();
        const plugged = !!battery.plugged;

        const draining = status === 'discharging';
        const charging = status === 'charging' || (plugged && !draining && cap < 100);
        const low = draining && cap < 20;

        /* Desktop with no real battery drain: hide icon entirely. */
        if (!draining && !plugged && cap === 0) {
            const wasVisible = this._batteryIcon.visible;
            this._batteryIcon.visible = false;
            if (wasVisible) this._resizeCollapsed();
            return;
        }

        let iconName;
        if (charging)         iconName = cap >= 95 ? 'battery-full-charging-symbolic' : 'battery-good-charging-symbolic';
        else if (cap >= 90)   iconName = 'battery-full-symbolic';
        else if (cap >= 55)   iconName = 'battery-good-symbolic';
        else if (cap >= 25)   iconName = 'battery-low-symbolic';
        else                  iconName = 'battery-caution-symbolic';

        let color;
        if (charging)      color = this._settings.get_string('battery-charging-color');
        else if (plugged)  color = this._settings.get_string('battery-charging-color'); /* plugged + full → green */
        else if (low)      color = this._settings.get_string('battery-low-color');
        else if (draining) color = this._settings.get_string('battery-normal-color');
        else               color = 'rgba(255, 255, 255, 0.78)';

        const wasVisible = this._batteryIcon.visible;
        this._batteryIcon.icon_name = iconName;
        this._batteryIcon.set_style(`color: ${color};`);
        this._batteryIcon.visible = true;
        if (!wasVisible) this._resizeCollapsed();
    }

    _updateMedia(info) {
        this._latestMedia = info;
        const wasIconVisible = this._mediaIcon.visible;
        const wasPillVisible = this._musicPill?.visible;
        if (!info?.playing && !info?.paused) {
            this._mediaIcon.visible = false;
            if (this._musicPill) this._musicPill.visible = false;
        } else {
            const iconName = this._resolveMediaIcon(info.icon) ?? 'audio-x-generic-symbolic';
            this._mediaIcon.icon_name = iconName;
            this._mediaIcon.opacity = info.playing ? 255 : 150;
            this._mediaIcon.visible = true;
            /* Dynamic Island: extend the collapsed pill with the track */
            if (this._musicPill && info.title) {
                const title = (info.title || '').slice(0, 24);
                const artist = (info.artist || '').slice(0, 22);
                this._musicTitle.text = title;
                this._musicArtist.text = artist;
                this._musicPill.visible = true;
            } else if (this._musicPill) {
                this._musicPill.visible = false;
            }
        }
        if (this._mediaIcon.visible !== wasIconVisible ||
            (this._musicPill && this._musicPill.visible !== wasPillVisible)) {
            this._resizeCollapsed();
        }
        if (!this._expanded) this._syncCompactState();
        /* Live-refresh System tab if music card is visible there */
        if (this._expanded && this._activeTab === 'system') this._renderTab();
    }

    _buildMusicCard() {
        const info = this._latestMedia;
        if (!info || (!info.playing && !info.paused)) {
            this._mediaProgressTrack = null;
            this._mediaProgressFill = null;
            return null;
        }
        const card = new St.BoxLayout({style_class: 'nexnotch-music-card', vertical: true});
        const top = new St.BoxLayout({style_class: 'nexnotch-music-card-top'});
        let art = null;
        if (info.artUrl && info.artUrl.startsWith('file://')) {
            try {
                const path = decodeURIComponent(info.artUrl.slice(7));
                art = new St.Icon({gicon: Gio.FileIcon.new(Gio.File.new_for_path(path)), icon_size: 44, style_class: 'nexnotch-music-art'});
            } catch (_) {}
        }
        if (!art) {
            art = new St.Icon({icon_name: this._resolveMediaIcon(info.icon) ?? 'audio-x-generic-symbolic', icon_size: 32, style_class: 'nexnotch-music-art-fallback'});
        }
        top.add_child(art);
        const txt = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'nexnotch-music-txt', y_align: Clutter.ActorAlign.CENTER});
        txt.add_child(new St.Label({text: (info.title || 'Unknown').slice(0, 28), style_class: 'nexnotch-music-card-title'}));
        txt.add_child(new St.Label({text: (info.artist || '').slice(0, 28), style_class: 'nexnotch-music-card-artist'}));
        top.add_child(txt);
        card.add_child(top);

        if (info.duration > 0) {
            const track = new St.Widget({
                style_class: 'nexnotch-media-progress-track',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                reactive: false,
            });
            const fill = new St.Widget({style_class: 'nexnotch-media-progress-fill', x_align: Clutter.ActorAlign.START, reactive: false});
            track.add_child(fill);
            card.add_child(track);
            this._mediaProgressTrack = track;
            this._mediaProgressFill = fill;
            this._mediaProgressFraction = Math.max(0, Math.min(1, (info.position ?? 0) / info.duration));
            track.connect('notify::allocation', () => this._layoutMediaProgress());
            this._layoutMediaProgress();
        } else {
            this._mediaProgressTrack = null;
            this._mediaProgressFill = null;
        }

        const ctrls = new St.BoxLayout({style_class: 'nexnotch-music-ctrls', x_align: Clutter.ActorAlign.CENTER});
        const mk = (label, cb, accName, enabled = true) => {
            const b = new St.Button({style_class: 'nexnotch-music-btn', label, accessible_name: accName, can_focus: true, reactive: enabled});
            if (!enabled) b.add_style_class_name('disabled');
            if (enabled) b.connect('clicked', cb);
            return b;
        };
        ctrls.add_child(mk('⏮', () => this._modules.mpris.previous(), 'Previous track', info.canPrev));
        ctrls.add_child(mk(info.playing ? '⏸' : '▶', () => this._modules.mpris.playPause(), 'Play/pause', info.canPlay || info.canPause));
        ctrls.add_child(mk('⏭', () => this._modules.mpris.next(), 'Next track', info.canNext));
        card.add_child(ctrls);
        return card;
    }

    _layoutMediaProgress() {
        if (!this._mediaProgressTrack || !this._mediaProgressFill) return;
        this._mediaProgressFill.width = Math.max(0, this._mediaProgressTrack.width * (this._mediaProgressFraction ?? 0));
    }

    _updateMediaProgress(progress) {
        if (!this._latestMedia || !progress) return;
        this._latestMedia.position = progress.position;
        this._latestMedia.duration = progress.duration;
        if (!this._mediaProgressFill) return;
        this._mediaProgressFraction = progress.duration > 0
            ? Math.max(0, Math.min(1, progress.position / progress.duration))
            : 0;
        this._layoutMediaProgress();
    }

    _resolveMediaIcon(desktopEntry) {
        if (!desktopEntry) return null;
        const app = Gio.DesktopAppInfo.new(`${desktopEntry}.desktop`);
        if (app) {
            const gicon = app.get_icon();
            if (gicon) {
                const name = gicon.to_string?.();
                if (name && !name.startsWith('/')) return name;
            }
        }
        const fallback = {
            spotify:         'spotify-client',
            'org.gnome.Decibels': 'org.gnome.Decibels',
            firefox:         'firefox',
            vlc:             'vlc',
            rhythmbox:       'rhythmbox',
        }[desktopEntry.toLowerCase()];
        return fallback ?? 'audio-x-generic-symbolic';
    }

    _updatePomodoroIndicator() {
        const p = this._modules?.pomodoro;
        if (!this._pomoLabel) return;
        const wasVisible = this._pomoLabel.visible;
        this._pomoLabel.remove_style_class_name('break');
        this._pomoLabel.remove_style_class_name('paused');
        if (!p || (!p.isActive() && p.getState() !== 'paused')) {
            /* Idle — hide completely. Pomo label only appears once the
               user has actually started a session. */
            this._pomoLabel.visible = false;
        } else if (p.isActive()) {
            this._pomoLabel.text = p.formatRemain();
            this._pomoLabel.visible = true;
            if (p.getState() === 'break' || p.getState() === 'longbreak') {
                this._pomoLabel.add_style_class_name('break');
            }
        } else {
            this._pomoLabel.text = `⏸ ${p.formatRemain()}`;
            this._pomoLabel.visible = true;
            this._pomoLabel.add_style_class_name('paused');
        }
        if (this._pomoLabel.visible !== wasVisible) this._resizeCollapsed();
    }

    _dndActive() {
        try {
            this._dndSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            return !this._dndSettings.get_boolean('show-banners');
        } catch (_) { return false; }
    }

    _updatePrivacyIndicator() {
        /* no-op — privacy dot removed from collapsed pill per user request.
           Mic/Camera status is still visible in the Quick tab pills. */
    }

    _peekNotification(source, notif, entry = null) {
        if (this._expanded) return;
        if (!this._settings.get_boolean('show-notifications')) return;   /* master off */
        if (this._dndActive()) return;   /* respect GNOME's Do Not Disturb */
        this._dismissPeek(true);
        if (this._settings.get_boolean('notif-suppress-native')) {
            this._killBanner(0); this._killBanner(60); this._killBanner(220);
        }

        const title = entry?.title ?? notif?.title ?? source?.title ?? 'Notification';
        let body  = entry?.body ?? notif?.bannerBodyText ?? notif?.body ?? '';
        /* clamp extremely long notifications */
        const lines = body.split('\n');
        if (lines.length > 6) body = lines.slice(0, 6).join('\n') + '\n…';
        if (body.length > 360) body = body.slice(0, 360) + '…';
        const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

        const peek = new St.BoxLayout({
            style_class: 'nexnotch-peek',
            vertical: false, x_expand: true, y_expand: true,
            reactive: true,
            track_hover: true,
            can_focus: true,
        });

        /* Clicking the body of the peek activates the notification (opens
           the source app, marks as read, etc.) — same as clicking a native
           banner. The dismiss button shortcuts out below. */
        peek.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            try {
                if (typeof notif?.activate === 'function') notif.activate();
                else if (typeof source?.open === 'function') source.open();
            } catch (e) { logError(e, 'nexnotch:peek:activate'); }
            this._dismissPeek(false);
            return Clutter.EVENT_STOP;
        });

        const gicon = this._resolveNotifIcon(source, notif);
        const iconBin = new St.Bin({style_class: 'nexnotch-peek-icon-bin', y_align: Clutter.ActorAlign.CENTER});
        iconBin.set_child(new St.Icon({
            gicon, icon_size: 28,
            style_class: 'nexnotch-peek-icon',
        }));
        peek.add_child(iconBin);

        const textCol = new St.BoxLayout({
            vertical: true, x_expand: true, y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'nexnotch-peek-text',
        });
        const titleRow = new St.BoxLayout();
        titleRow.add_child(new St.Label({text: title, style_class: 'nexnotch-peek-title', x_expand: true}));
        if ((entry?.count ?? 1) > 1)
            titleRow.add_child(new St.Label({text: `${entry.count}`, style_class: 'nexnotch-peek-count'}));
        titleRow.add_child(new St.Label({text: timeStr, style_class: 'nexnotch-peek-time'}));
        textCol.add_child(titleRow);
        if (body) textCol.add_child(new St.Label({text: body, style_class: 'nexnotch-peek-body'}));
        peek.add_child(textCol);

        const dismissBtn = new St.Button({
            style_class: 'nexnotch-peek-dismiss',
            label: '✕',
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Dismiss notification',
            can_focus: true,
        });
        dismissBtn.connect('clicked', () => this._dismissPeek(false));
        /* Stop the click from bubbling up to the peek (which would activate
           the notification on top of dismissing it). */
        dismissBtn.connect('button-release-event', () => Clutter.EVENT_STOP);
        peek.add_child(dismissBtn);

        this.add_child(peek);
        this._peekLayer  = peek;
        this._peekEntry = entry;
        this._peekActive = true;
        this._collapsed.hide();

        this.remove_all_transitions();
        peek.opacity = 0;
        peek.set_pivot_point(0.5, 0);
        peek.scale_x = 0.94; peek.scale_y = 0.94;
        peek.ease({
            opacity: 255, scale_x: 1, scale_y: 1,
            duration: motionDuration(this._settings, 'expand'), mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        /* Fit size to actual text (multi-line messages, short toasts, etc.) */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._peekActive) return GLib.SOURCE_REMOVE;
            const naturalWidth = peek.get_preferred_width(-1)[1] || 380;
            const monitorWidth = this._extension.getTargetMonitor?.()?.width ?? 640;
            const available = Math.max(1, monitorWidth - 32);
            const width = computeIslandLayout({
                contentWidth: naturalWidth,
                minimumWidth: Math.min(320, available),
                preferredWidth: Math.min(420, available),
                maximumWidth: available,
                availableWidth: available,
            }).width;
            const [, natH] = peek.get_preferred_height(width - 40);
            const h = Math.max(72, Math.min(260, natH + 20));
            this.ease({width, height: h, duration: motionDuration(this._settings, 'resize'), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            return GLib.SOURCE_REMOVE;
        });

        this._setState('NOTIFICATION');
        this._material?.setState('TRANSIENT');
        this._peekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOTION.peekDuration, () => {
            this._peekTimer = 0; this._dismissPeek(false); return GLib.SOURCE_REMOVE;
        });
    }

    _killBanner(delayMs) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._bannerKillTimers?.delete(id);
            try { Main.messageTray._banner?.close?.(); } catch (_) {}
            try { Main.messageTray._bannerBin?.hide?.(); } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
        (this._bannerKillTimers ??= new Set()).add(id);
    }

    _resolveNotifIcon(source, notif) {
        try {
            if (notif?.gicon)    return notif.gicon;
            if (source?.getIcon) return source.getIcon();
            if (source?.icon)    return source.icon;
        } catch (_) {}
        return Gio.ThemedIcon.new('dialog-information-symbolic');
    }

    _dismissPeek(immediate) {
        if (this._peekTimer) { GLib.source_remove(this._peekTimer); this._peekTimer = 0; }
        if (!this._peekActive) return;
        this._peekActive = false;
        const finalize = () => {
            this._peekLayer?.destroy();
            this._peekLayer = null;
            this._peekEntry = null;
            if (!this._expanded) {
                this._collapsed.show();
                this._syncCompactState();
                this.ease({width: this._measureCollapsedWidth(), height: this._ch, duration: motionDuration(this._settings, 'collapse'), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
                if (!immediate) this._modules?.notifications?.advance?.();
            }
        };
        if (immediate) finalize();
        else GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { finalize(); return GLib.SOURCE_REMOVE; });
    }

});
