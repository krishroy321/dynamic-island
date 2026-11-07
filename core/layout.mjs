export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function computeIslandLayout({
    contentWidth = 0,
    contentHeight = 0,
    minimumWidth = 140,
    preferredWidth = 240,
    maximumWidth = 960,
    availableWidth = maximumWidth,
    minimumHeight = 24,
    preferredHeight = 32,
    maximumHeight = 640,
    horizontalPadding = 0,
    verticalPadding = 0,
} = {}) {
    const maxWidth = Math.max(minimumWidth, Math.min(maximumWidth, availableWidth));
    const width = clamp(Math.max(preferredWidth, contentWidth + horizontalPadding * 2), minimumWidth, maxWidth);
    const height = clamp(Math.max(preferredHeight, contentHeight + verticalPadding * 2), minimumHeight, maximumHeight);
    return Object.freeze({width: Math.round(width), height: Math.round(height)});
}

/* Compact sizing is independent from expanded content requisition. */
export function computeCompactLayout({
    contentWidth = 0,
    preferredWidth = 220,
    availableWidth = 240,
    minimumWidth = 180,
    maximumWidth = 240,
    height = 48,
} = {}) {
    const available = Math.max(1, availableWidth);
    const maxWidth = Math.min(maximumWidth, available);
    const minWidth = Math.min(minimumWidth, maxWidth);
    return computeIslandLayout({
        contentWidth,
        minimumWidth: minWidth,
        preferredWidth: Math.max(minWidth, Math.min(maxWidth, preferredWidth)),
        maximumWidth: maxWidth,
        availableWidth: available,
        minimumHeight: height,
        preferredHeight: height,
        maximumHeight: height,
    });
}
