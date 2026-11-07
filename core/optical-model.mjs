export const GLASS_QUALITY = Object.freeze({
    low: Object.freeze({blurRadius: 0, bodyAlpha: 0.42, shader: false, dispersionCue: 0.25}),
    medium: Object.freeze({blurRadius: 8, bodyAlpha: 0.24, shader: false, dispersionCue: 0.45}),
    high: Object.freeze({blurRadius: 12, bodyAlpha: 0.19, shader: true, dispersionCue: 0.72}),
});

export const OPTICAL_TOKENS = Object.freeze({
    tintMix: 0.14,
    bodyAlphaMin: 0.10,
    bodyAlphaMax: 0.58,
    edgeAlpha: 0.105,
    innerHighlight: 0.09,
    diffuseAlpha: 0.055,
    reflectionAlpha: 0.045,
    hoverReflectionAlpha: 0.07,
    pointerReflectionAlpha: 0.085,
    compactHeight: 48,
    geometryDepthSpan: 232,
    expandedRadiusGrowth: 0.035,
    expandedRadiusGrowthMax: 10,
    shadowCompactY: 6,
    shadowExpandedY: 10,
    shadowCompactBlur: 18,
    shadowExpandedBlur: 28,
    shadowCompactAlpha: 0.24,
    shadowExpandedAlpha: 0.28,
    shadowHoverY: 2,
    shadowHoverBlur: 2,
    shadowHoverAlpha: 0.03,
    motionForceScale: 1500,
    motionFalloffMs: 115,
});

export function resolveGlassQuality(quality) {
    return GLASS_QUALITY[quality] ?? GLASS_QUALITY.medium;
}

export function clamp01(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function constrainOpticalRadius(width, height, radius) {
    return Math.max(0, Math.min(radius, Math.max(0, width / 2), Math.max(0, height / 2)));
}

export function deriveOpticalRadius(height, configuredRadius) {
    const h = Math.max(0, Number(height) || 0);
    const configured = Math.max(1, Number(configuredRadius) || 1);
    if (!h) return configured;
    const growth = Math.max(0, Math.min(OPTICAL_TOKENS.expandedRadiusGrowthMax,
        (h - OPTICAL_TOKENS.compactHeight) * OPTICAL_TOKENS.expandedRadiusGrowth));
    return Math.round(Math.min(h * 0.5, configured + growth));
}

export function deriveOpticalDepth(height) {
    const h = Math.max(0, Number(height) || 0);
    return clamp01((h - OPTICAL_TOKENS.compactHeight) / OPTICAL_TOKENS.geometryDepthSpan);
}

export function sampleOpticalMotion({deltaWidth = 0, deltaHeight = 0, elapsedMs = 16} = {}) {
    const elapsed = Math.max(1, Number.isFinite(elapsedMs) ? elapsedMs : 16);
    const speedX = deltaWidth * 1000 / elapsed;
    const speedY = deltaHeight * 1000 / elapsed;
    const speed = Math.hypot(speedX, speedY);
    return Object.freeze({
        force: clamp01(speed / OPTICAL_TOKENS.motionForceScale),
        directionX: speed > 0.001 ? speedX / speed : 0,
        directionY: speed > 0.001 ? speedY / speed : -1,
    });
}
