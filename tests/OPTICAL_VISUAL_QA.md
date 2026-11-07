# NexNotch optical material visual checks

Run these on a GNOME Shell session with the extension installed. NexNotch was
started at High quality in an isolated GNOME Shell 50.1 headless session; the
shader source was accepted and actor/effect initialization completed. Shell's
screenshot D-Bus denied capture in that session, so none of these appearance
checks are marked as visually passed yet.

- [ ] Compact state against a dark desktop; verify 180–240 px width and readable clock.
- [ ] Compact state against a bright desktop; check edge contrast and text readability.
- [ ] Expanded state against a detailed desktop; confirm blur stays inside the island.
- [ ] Inspect rounded bevel and upper-left sheen at compact and expanded sizes.
- [ ] High quality: check restrained colored edge cue; verify it does not appear as a full RGB split.
- [ ] Expand and collapse: caustic should rise with geometry velocity and decay at rest.
- [ ] Move the pointer: reflection follows without starting a continuous sweep.
- [ ] Reverse expansion/collapse rapidly; confirm no stale visual state or stuck shader layer.
- [ ] Low quality: verify layered fallback appears without blur or shader.
- [ ] Medium quality: verify native background blur and CSS bevel layers.
- [ ] High quality with shader unavailable: verify automatic fallback and no Shell error.
- [ ] Reduced motion: verify the material follows the shortened geometry transition without lingering motion.
