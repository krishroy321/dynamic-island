/* Actor-local optical lighting. This intentionally does not sample the
   desktop; Clutter's shader effect only receives this actor's offscreen input.
   Backdrop sampling is handled separately by Shell.BlurEffect. */
export const OPTICAL_SURFACE_SHADER = `
uniform float uWidth;
uniform float uHeight;
uniform float uPointerX;
uniform float uPointerY;
uniform float uDirectionX;
uniform float uDirectionY;
uniform float uRadius;
uniform float uForce;
uniform float uIntensity;
uniform float uDispersion;
uniform float uTintR;
uniform float uTintG;
uniform float uTintB;

float roundedBoxDistance(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - (halfSize - vec2(radius));
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
    vec2 size = max(vec2(uWidth, uHeight), vec2(1.0));
    vec2 uv = cogl_tex_coord_in[0].st;
    vec2 p = uv * size - size * 0.5;
    float radius = clamp(uRadius, 1.0, min(size.x, size.y) * 0.5);
    float signedDistance = roundedBoxDistance(p, size * 0.5, radius);
    float coverage = 1.0 - smoothstep(-0.65, 0.85, signedDistance);
    float innerDistance = max(-signedDistance, 0.0);
    float rimFalloff = exp(-innerDistance / max(1.8, min(size.y * 0.12, 7.0)));

    // A broad upper-left sheen and a small pointer-following glint give the
    // surface a stable virtual light source without a sweeping animation.
    float upperSheen = exp(-pow((uv.x - 0.28) / 0.34, 2.0)
                         - pow((uv.y - 0.055) / 0.105, 2.0));
    vec2 aspect = vec2(size.x / size.y, 1.0);
    vec2 pointerDelta = (uv - vec2(uPointerX, uPointerY)) * aspect;
    float pointerGlint = exp(-dot(pointerDelta, pointerDelta) / 0.032);
    float topFresnel = rimFalloff * (0.48 + 0.52 * (1.0 - smoothstep(0.05, 0.82, uv.y)));
    float bottomBevel = rimFalloff * smoothstep(0.60, 0.98, uv.y);

    // A small force-driven caustic bowl. It fades to zero at rest and follows
    // the direction of the recent size change; it is a lighting cue, not a
    // ray-traced caustic or a refracted copy of the desktop.
    vec2 lensPoint = (uv - vec2(0.5)) * aspect;
    vec2 axis = normalize(vec2(0.34 * uDirectionX, -1.0 + 0.18 * uDirectionY));
    vec2 side = vec2(-axis.y, axis.x);
    float across = dot(lensPoint, side);
    float along = dot(lensPoint, axis);
    float ringRadius = length(vec2(across / 0.31, (along - 0.02) / 0.31));
    float ring = exp(-pow((ringRadius - 0.78) / 0.20, 2.0));
    float hole = 1.0 - exp(-pow(length(vec2(across / 0.17, (along - 0.02) / 0.17)), 2.0));
    float caustic = ring * hole * clamp(uForce, 0.0, 1.0);

    // Restrained chromatic edge tint suggests dispersion. The desktop's RGB
    // channels are not split because this shader has no backdrop sampler.
    float fringeSide = smoothstep(0.0, 1.0, uv.x) - 0.5;
    vec3 fringe = mix(vec3(0.52, 0.76, 0.98), vec3(0.91, 0.64, 0.67),
                      smoothstep(-0.18, 0.18, fringeSide));
    float fringeLight = rimFalloff * uDispersion * 0.028;

    float alpha = (topFresnel * 0.078
                 + bottomBevel * 0.020
                 + upperSheen * 0.048
                 + pointerGlint * 0.038
                 + caustic * 0.042
                 + fringeLight) * uIntensity;
    vec3 tint = vec3(uTintR, uTintG, uTintB);
    vec3 color = vec3(0.88, 0.92, 0.98)
               + tint * (caustic * 0.24)
               + fringe * (fringeLight * 1.6);
    alpha = clamp(alpha * coverage, 0.0, 0.17);
    cogl_color_out = vec4(color * alpha, alpha);
}
`;
