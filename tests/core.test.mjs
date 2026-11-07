import test from 'node:test';
import assert from 'node:assert/strict';

import {computeCompactLayout, computeIslandLayout} from '../core/layout.mjs';
import {constrainOpticalRadius, deriveOpticalDepth, deriveOpticalRadius, resolveGlassQuality, sampleOpticalMotion} from '../core/optical-model.mjs';
import {OPTICAL_SURFACE_SHADER} from '../core/optical-shader.mjs';
import {NotificationManager} from '../core/notification-manager.mjs';
import {TransitionController} from '../core/transition-controller.mjs';

test('layout honors minimum, preferred and available monitor widths', () => {
    assert.deepEqual(computeIslandLayout({contentWidth: 60}), {width: 240, height: 32});
    assert.deepEqual(computeIslandLayout({contentWidth: 500, preferredWidth: 240, availableWidth: 420}), {width: 420, height: 32});
    assert.deepEqual(computeIslandLayout({contentWidth: 300, horizontalPadding: 20, preferredWidth: 240}), {width: 340, height: 32});
});

test('compact presentation stays bounded when content reports dashboard-sized width', () => {
    assert.deepEqual(computeCompactLayout({contentWidth: 1200}), {width: 240, height: 48});
    assert.deepEqual(computeCompactLayout({contentWidth: 60, preferredWidth: 210}), {width: 210, height: 48});
    assert.deepEqual(computeCompactLayout({contentWidth: 600, preferredWidth: 220, availableWidth: 200}), {width: 200, height: 48});
});

test('glass quality resolves predictable blur and shader fallbacks', () => {
    assert.equal(resolveGlassQuality('low').blurRadius, 0);
    assert.equal(resolveGlassQuality('medium').blurRadius, 8);
    assert.equal(resolveGlassQuality('high').shader, true);
    assert.equal(resolveGlassQuality('unsupported'), resolveGlassQuality('medium'));
});

test('optical geometry and motion values stay bounded and reverse with movement', () => {
    assert.equal(constrainOpticalRadius(200, 48, 40), 24);
    assert.equal(deriveOpticalRadius(48, 20), 20);
    assert.ok(deriveOpticalRadius(280, 20) > deriveOpticalRadius(48, 20));
    assert.equal(deriveOpticalDepth(48), 0);
    assert.equal(deriveOpticalDepth(280), 1);
    const expand = sampleOpticalMotion({deltaWidth: 24, elapsedMs: 16});
    const collapse = sampleOpticalMotion({deltaWidth: -24, elapsedMs: 16});
    assert.ok(expand.force <= 1 && expand.force > 0);
    assert.equal(expand.directionX, -collapse.directionX);
    assert.equal(sampleOpticalMotion({deltaWidth: 0, elapsedMs: 16}).force, 0);
});

test('high-quality shader is actor-local and exposes the optical controls', () => {
    assert.match(OPTICAL_SURFACE_SHADER, /uniform float uPointerX/);
    assert.match(OPTICAL_SURFACE_SHADER, /uniform float uPointerY/);
    assert.match(OPTICAL_SURFACE_SHADER, /uniform float uForce/);
    assert.match(OPTICAL_SURFACE_SHADER, /uniform float uDispersion/);
    assert.match(OPTICAL_SURFACE_SHADER, /cogl_color_out/);
    assert.doesNotMatch(OPTICAL_SURFACE_SHADER, /uniform\s+sampler2D/);
});

test('notification manager groups repeated source events and refreshes content', () => {
    const manager = new NotificationManager();
    const first = manager.enqueue({sourceKey: 'chat', title: 'A', urgency: 1}, 1000);
    const grouped = manager.enqueue({sourceKey: 'chat', title: 'B', urgency: 1}, 2000);
    assert.equal(first.id, grouped.id);
    assert.equal(grouped.count, 2);
    assert.equal(grouped.title, 'B');
});

test('critical notifications preempt normal events and persistent items do not expire', () => {
    const manager = new NotificationManager();
    manager.enqueue({sourceKey: 'mail', urgency: 1, duration: 5000}, 1000);
    const critical = manager.enqueue({sourceKey: 'battery', urgency: 3, persistent: true}, 1100);
    assert.equal(manager.current(2000).id, critical.id);
    manager.expire(90000);
    assert.equal(manager.current(90000).id, critical.id);
});

test('expiration and advancing remove the correct queue entry', () => {
    const manager = new NotificationManager();
    const low = manager.enqueue({sourceKey: 'a', urgency: 0, duration: 1000}, 1000);
    const normal = manager.enqueue({sourceKey: 'b', urgency: 1, duration: 3000}, 1000);
    assert.equal(manager.current(1100).id, normal.id);
    assert.equal(manager.advance(normal.id, 1100).id, low.id);
    assert.equal(manager.current(2500), null);
});

test('transition tokens invalidate stale callbacks when direction reverses', () => {
    const controller = new TransitionController('COMPACT');
    const expand = controller.retarget('EXPANDING');
    const collapse = controller.retarget('COLLAPSING');
    assert.equal(controller.isCurrent(expand), false);
    assert.equal(controller.isCurrent(collapse), true);
    const reverse = controller.retarget('EXPANDING');
    assert.equal(controller.isCurrent(collapse), false);
    assert.equal(controller.isCurrent(reverse), true);
});

test('rapid expand-collapse reversals leave only the latest target active', () => {
    const controller = new TransitionController('COMPACT');
    const firstExpand = controller.retarget('EXPANDING');
    const firstCollapse = controller.retarget('COLLAPSING');
    const secondExpand = controller.retarget('EXPANDING');
    const secondCollapse = controller.retarget('COLLAPSING');

    assert.equal(controller.isCurrent(firstExpand), false);
    assert.equal(controller.isCurrent(firstCollapse), false);
    assert.equal(controller.isCurrent(secondExpand), false);
    assert.equal(controller.isCurrent(secondCollapse), true);
    controller.setState('COMPACT');
    assert.equal(controller.state, 'COMPACT');
});
