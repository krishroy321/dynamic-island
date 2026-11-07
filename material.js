import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {
    GLASS_QUALITY,
    OPTICAL_TOKENS,
    clamp01,
    constrainOpticalRadius,
    deriveOpticalDepth,
    deriveOpticalRadius,
    resolveGlassQuality,
    sampleOpticalMotion,
} from './core/optical-model.mjs';
import {OPTICAL_SURFACE_SHADER} from './core/optical-shader.mjs';

const STATE_GAIN = Object.freeze({
    REST: 0.74,
    COMPACT: 0.74,
    HOVER: 0.92,
    PRESS: 0.82,
    EXPANDING: 1.0,
    EXPANDED: 0.72,
    COLLAPSING: 0.94,
    TRANSIENT: 0.96,
    MEDIA: 0.78,
    TIMER: 0.82,
    NOTIFICATION: 0.92,
});

function rgba(color, alpha) {
    const a = clamp01(alpha);
    return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${a.toFixed(3)})`;
}

function mixColor(a, b, amount) {
    const t = clamp01(amount);
    return {
        r: a.r * (1 - t) + b.r * t,
        g: a.g * (1 - t) + b.g * t,
        b: a.b * (1 - t) + b.b * t,
        a: a.a * (1 - t) + b.a * t,
    };
}

export class LiquidGlassMaterial {
    constructor() {
        this.actor = new St.Widget({
            style_class: 'nexnotch-material',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            reactive: false,
            clip_to_allocation: false,
        });

        /* Layers are ordered back-to-front. The native blur is limited to the
           island actor; all later layers supply tint and optical cues. */
        this._backdrop = new St.Widget({
            style_class: 'nexnotch-glass-backdrop',
            x_expand: true, y_expand: true, reactive: false,
            clip_to_allocation: true,
        });
        this.surface = new St.Widget({
            style_class: 'nexnotch-glass-body',
            x_expand: true, y_expand: true, reactive: false,
        });
        this._ambient = new St.Widget({
            style_class: 'nexnotch-glass-ambient',
            x_expand: true, y_expand: true, reactive: false,
        });
        this._diffuse = new St.Widget({
            style_class: 'nexnotch-glass-diffuse',
            x_expand: true, y_expand: true, reactive: false,
        });
        this._optics = new St.Widget({
            style_class: 'nexnotch-glass-optics',
            x_expand: true, y_expand: true, reactive: false,
            visible: false,
        });
        this._edge = new St.Widget({
            style_class: 'nexnotch-glass-edge',
            x_expand: true, y_expand: true, reactive: false,
        });
        this._reflectionLayer = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true, y_expand: true, reactive: false,
        });
        this._reflection = new St.Widget({
            style_class: 'nexnotch-glass-reflection',
            reactive: false,
        });
        this._reflectionLayer.add_child(this._reflection);

        for (const layer of [this._backdrop, this.surface, this._ambient,
            this._diffuse, this._optics, this._edge, this._reflectionLayer]) {
            this.actor.add_child(layer);
        }

        this.backend = 'layered-glass';
        this._blurEffect = null;
        this._shaderEffect = null;
        this._shaderFailureLogged = false;
        this._motionTimeout = 0;
        this._motionForce = 0;
        this._motionDirection = {x: 0, y: -1};
        this._previousGeometry = null;
        this._lastGeometryMs = 0;
        this._lastDecayMs = 0;
        this._pointer = null;
        this._uniformCache = new Map();
        this._width = 0;
        this._height = 0;
        this._radius = 24;
        this._configuredRadius = 24;
        this._state = 'REST';
        this._colors = {
            background: {r: 12, g: 15, b: 22, a: 1},
            accent: {r: 130, g: 180, b: 255, a: 0.32},
        };

        this.setQuality('medium');
        this.setState('REST');
    }

    setQuality(quality) {
        this.quality = GLASS_QUALITY[quality] ? quality : 'medium';
        this._quality = resolveGlassQuality(this.quality);
        this._removeBlurEffect();
        this._removeShaderEffect();

        if (this._quality.blurRadius > 0) this._installNativeBlur();
        if (this._quality.shader) this._installOpticalShader();
        this._updateBackendName();
        this._applyStyles();
        this._updateUniforms();
        return this.backend;
    }

    _installNativeBlur() {
        if (!Shell.BlurEffect || Shell.BlurMode?.BACKGROUND === undefined) return false;
        try {
            /* Shell.BlurEffect uses radius (not sigma). In BACKGROUND mode it
               samples the scene under this actor, without blurring content. */
            this._blurEffect = new Shell.BlurEffect({
                radius: this._quality.blurRadius,
                brightness: 0.98,
                mode: Shell.BlurMode.BACKGROUND,
            });
            this._backdrop.add_effect(this._blurEffect);
            return true;
        } catch (e) {
            this._blurEffect = null;
            this._logFallback('native background blur unavailable', e);
            return false;
        }
    }

    _installOpticalShader() {
        if (!Clutter.ShaderEffect) return false;
        try {
            /* Mutter 18 (GNOME Shell 50) exposes the legacy fragment enum as
               numeric 1 and scalar GValue uniforms, not set_uniform_float. */
            const effect = new Clutter.ShaderEffect({shader_type: 1});
            if (typeof effect.set_shader_source !== 'function' ||
                typeof effect.set_uniform_value !== 'function') {
                throw new Error('Clutter ShaderEffect scalar uniforms are unavailable');
            }
            effect.set_shader_source(OPTICAL_SURFACE_SHADER);
            this._optics.add_effect(effect);
            this._shaderEffect = effect;
            this._optics.visible = true;
            this._updateUniforms();
            return true;
        } catch (e) {
            this._shaderEffect = null;
            this._optics.visible = false;
            this._logFallback('procedural optical shader unavailable', e);
            return false;
        }
    }

    _logFallback(message, error) {
        if (this._shaderFailureLogged) return;
        this._shaderFailureLogged = true;
        log(`nexnotch: ${message}; using a lower material backend (${error?.message ?? error})`);
    }

    _removeBlurEffect() {
        if (!this._blurEffect) return;
        try { this._backdrop.remove_effect(this._blurEffect); } catch (_) {}
        this._blurEffect = null;
    }

    _removeShaderEffect() {
        if (!this._shaderEffect) {
            this._optics.visible = false;
            this._uniformCache.clear();
            return;
        }
        try { this._optics.remove_effect(this._shaderEffect); } catch (_) {}
        this._shaderEffect = null;
        this._uniformCache.clear();
        this._optics.visible = false;
    }

    _updateBackendName() {
        if (this._blurEffect && this._shaderEffect)
            this.backend = 'native-background-blur+clutter-optical-overlay';
        else if (this._blurEffect)
            this.backend = 'native-background-blur';
        else if (this._shaderEffect)
            this.backend = 'clutter-optical-overlay';
        else
            this.backend = 'layered-glass';
    }

    setColors({background, accent, radius, hover = false}) {
        this._colors = {
            background: background ?? this._colors.background,
            accent: accent ?? this._colors.accent,
        };
        this._configuredRadius = Math.max(1, Number(radius) || this._configuredRadius);
        this._updateRadiusForGeometry();
        this._hover = Boolean(hover);
        this._applyStyles();
        this._updateUniforms();
    }

    _applyStyles() {
        const tokens = OPTICAL_TOKENS;
        const bg = this._colors.background;
        const accent = this._colors.accent;
        const tint = mixColor(bg, accent, tokens.tintMix);
        const alpha = Math.max(tokens.bodyAlphaMin,
            Math.min(tokens.bodyAlphaMax, this._quality.bodyAlpha * clamp01(bg.a)));
        const radius = this._radius;
        const depth = deriveOpticalDepth(this._height);
        const shadowY = tokens.shadowCompactY +
            (tokens.shadowExpandedY - tokens.shadowCompactY) * depth +
            (this._hover ? tokens.shadowHoverY : 0);
        const shadowBlur = tokens.shadowCompactBlur +
            (tokens.shadowExpandedBlur - tokens.shadowCompactBlur) * depth +
            (this._hover ? tokens.shadowHoverBlur : 0);
        const shadowAlpha = tokens.shadowCompactAlpha +
            (tokens.shadowExpandedAlpha - tokens.shadowCompactAlpha) * depth +
            (this._hover ? tokens.shadowHoverAlpha : 0);
        const shadow = `0 ${shadowY.toFixed(1)}px ${shadowBlur.toFixed(1)}px rgba(0, 0, 0, ${shadowAlpha.toFixed(3)})`;

        this.actor.set_style(`border-radius: ${radius}px;`);
        this._backdrop.set_style(`border-radius: ${radius}px;`);
        this.surface.set_style(`background-color: ${rgba(tint, alpha)}; border-radius: ${radius}px; box-shadow: ${shadow};`);
        this._ambient.set_style(`background-color: ${rgba(accent, 0.040)}; border-radius: ${radius}px;`);
        this._diffuse.set_style(`border-radius: ${radius}px; background-gradient-direction: vertical; background-gradient-start: rgba(255,255,255,${tokens.diffuseAlpha}); background-gradient-end: rgba(255,255,255,0.0);`);
        this._optics.set_style(`border-radius: ${radius}px; background-color: rgba(0,0,0,0.001);`);
        this._edge.set_style(`border-radius: ${radius}px; border: 1px solid ${rgba({r: 235, g: 242, b: 255}, tokens.edgeAlpha)}; box-shadow: inset 0 1px 0 rgba(255,255,255,${tokens.innerHighlight});`);
        this._styleReflection();
    }

    _setUniform(name, value) {
        if (!this._shaderEffect) return false;
        const scalar = Math.fround(Number(value));
        if (this._uniformCache.get(name) === scalar) return true;
        const uniform = new GObject.Value();
        let initialized = false;
        try {
            uniform.init(GObject.TYPE_FLOAT);
            initialized = true;
            uniform.set_float(scalar);
            this._shaderEffect.set_uniform_value(name, uniform);
            this._uniformCache.set(name, scalar);
            return true;
        } catch (e) {
            this._disableShader(e);
            return false;
        } finally {
            if (initialized) uniform.unset();
        }
    }

    _updateUniforms() {
        if (!this._shaderEffect) return;
        const pointer = this._pointer ?? {x: 0.25, y: 0.12};
        const accent = this._colors.accent;
        const values = [
            ['uWidth', Math.max(1, this._width)],
            ['uHeight', Math.max(1, this._height)],
            ['uPointerX', pointer.x],
            ['uPointerY', pointer.y],
            ['uDirectionX', this._motionDirection.x],
            ['uDirectionY', this._motionDirection.y],
            ['uRadius', constrainOpticalRadius(this._width, this._height, this._radius)],
            ['uForce', this._motionForce],
            ['uIntensity', STATE_GAIN[this._state] ?? STATE_GAIN.REST],
            ['uDispersion', this._quality.dispersionCue],
            ['uTintR', accent.r / 255],
            ['uTintG', accent.g / 255],
            ['uTintB', accent.b / 255],
        ];
        for (const [name, uniform] of values) {
            if (!this._setUniform(name, uniform)) return;
        }
    }

    _disableShader(error) {
        this._removeShaderEffect();
        this._updateBackendName();
        this._logFallback('optical shader failed; using native/layered material', error);
    }

    setGeometry(width, height) {
        const nextWidth = Math.max(0, Number(width) || 0);
        const nextHeight = Math.max(0, Number(height) || 0);
        if (Math.abs(nextWidth - this._width) < 0.1 && Math.abs(nextHeight - this._height) < 0.1) return;

        const now = GLib.get_monotonic_time() / 1000;
        if (this._width > 0 && this._height > 0 && this._lastGeometryMs > 0) {
            const sample = sampleOpticalMotion({
                deltaWidth: nextWidth - this._width,
                deltaHeight: nextHeight - this._height,
                elapsedMs: now - this._lastGeometryMs,
            });
            if (sample.force > 0.006) {
                this._motionForce = Math.max(this._motionForce, sample.force);
                this._motionDirection = {x: sample.directionX, y: sample.directionY};
                this._startMotionDecay();
            }
        }
        this._width = nextWidth;
        this._height = nextHeight;
        this._lastGeometryMs = now;
        this._updateRadiusForGeometry();
        this._positionReflection();
        this._updateUniforms();
    }

    _updateRadiusForGeometry() {
        /* Compact remains close to a capsule; taller surfaces gain a little
           more curvature. Integer CSS updates avoid per-frame restyling. */
        const nextRadius = deriveOpticalRadius(this._height, this._configuredRadius);
        if (nextRadius === this._radius) return;
        this._radius = nextRadius;
        this._applyStyles();
    }

    _startMotionDecay() {
        if (this._motionTimeout || !this._shaderEffect) return;
        this._lastDecayMs = GLib.get_monotonic_time() / 1000;
        this._motionTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const now = GLib.get_monotonic_time() / 1000;
            const dt = Math.max(1, Math.min(100, now - this._lastDecayMs));
            this._lastDecayMs = now;
            this._motionForce *= Math.exp(-dt / OPTICAL_TOKENS.motionFalloffMs);
            if (this._motionForce < 0.004 || !this._shaderEffect) {
                this._motionForce = 0;
                this._motionTimeout = 0;
                this._updateUniforms();
                return GLib.SOURCE_REMOVE;
            }
            this._updateUniforms();
            return GLib.SOURCE_CONTINUE;
        });
    }

    setPointer(x, y) {
        if (!this._width || !this._height) return;
        this._pointer = {
            x: clamp01(x / this._width),
            y: clamp01(y / this._height),
        };
        this._positionReflection();
        this._updateUniforms();
    }

    clearPointer() {
        this._pointer = null;
        this._positionReflection();
        this._styleReflection();
        this._updateUniforms();
    }

    _styleReflection() {
        const alpha = this._pointer
            ? OPTICAL_TOKENS.pointerReflectionAlpha
            : (this._hover ? OPTICAL_TOKENS.hoverReflectionAlpha : OPTICAL_TOKENS.reflectionAlpha);
        this._reflection.set_style(`background-gradient-direction: vertical; background-gradient-start: rgba(255,255,255,${alpha}); background-gradient-end: rgba(255,255,255,0.0); border-radius: 999px;`);
        this._reflection.opacity = 255;
        this._positionReflection();
    }

    _positionReflection() {
        if (!this._width || !this._height) return;
        const w = Math.max(48, Math.min(132, this._width * 0.24));
        const x = this._pointer
            ? this._pointer.x * this._width - w * 0.5
            : this._width * 0.25 - w * 0.5;
        const y = this._pointer
            ? this._pointer.y * this._height - 2
            : Math.max(4, Math.min(8, this._height * 0.14));
        this._reflection.set_size(w, 5);
        this._reflection.set_position(
            Math.max(4, Math.min(this._width - w - 4, x)),
            Math.max(2, Math.min(this._height - 6, y)));
    }

    setState(state) {
        this._state = state;
        this._hover = state === 'HOVER';
        this._ambient.opacity = Math.round(255 * (STATE_GAIN[state] ?? STATE_GAIN.REST));
        this._applyStyles();
        this._updateUniforms();
    }

    destroy() {
        if (this._motionTimeout) {
            GLib.source_remove(this._motionTimeout);
            this._motionTimeout = 0;
        }
        this._removeBlurEffect();
        this._removeShaderEffect();
        this.actor.destroy();
    }
}
