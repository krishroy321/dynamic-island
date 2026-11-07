# Adaptive Liquid Glass Dynamic Island Design

## Goal
Give NexNotch a centered, rounded, adaptive-glass Dynamic Island appearance on GNOME 50 while preserving its existing modules and Wayland compatibility.

## Design
- Mount the island as top chrome and position it from the primary monitor's work area center.
- Treat the collapsed and expanded states as one rounded floating surface; never use the current bottom-only notch radius.
- Derive a subtle translucent tint from the configured accent color while preserving the configured background opacity.
- Add layered depth using a faint top highlight, low-contrast outline, inner glow, and soft shadow. Do not depend on compositor blur APIs.
- Use consistent rounded controls and cards for tabs, media controls, weather, notes, and system panels.
- Preserve user settings and existing functionality; visual changes should be CSS/runtime style changes plus centering/resize correctness only.

## Constraints
- GNOME Shell 50 / GJS / St / Clutter CSS.
- Works on Wayland and X11.
- No external build system or JavaScript dependencies.
- Existing runtime setting colors remain supported.

## Verification
- Compile schema and install extension.
- Run the extension in a headless GNOME Shell 50 session and assert no NexNotch errors.
- Verify generated package integrity.
- Inspect git diff for accidental behavior changes.
