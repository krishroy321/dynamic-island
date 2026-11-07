# Adaptive Liquid Glass Dynamic Island Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Center NexNotch on GNOME 50 and restyle it as an adaptive, rounded Liquid Glass-inspired Dynamic Island.

**Architecture:** Keep the existing St.Widget and module architecture. Fix positioning at the extension layer, centralize adaptive surface styling in `notch.js`, and update `stylesheet.css` for rounded glass surfaces and controls.

**Tech Stack:** GJS, GNOME Shell 50, St, Clutter, GNOME Shell CSS, Makefile.

---

### Task 1: Inspect visual and geometry sources

**Files:**
- Inspect: `extension.js`
- Inspect: `notch.js`
- Inspect: `stylesheet.css`

**Step 1:** Identify all runtime background/radius overrides and all width/position transitions.

**Step 2:** Confirm no module behavior or settings schema needs changing.

**Step 3:** Record the current baseline with `git diff --check`.

---

### Task 2: Make monitor centering robust

**Files:**
- Modify: `extension.js`
- Modify: `notch.js`

**Step 1:** Position the actor using the primary monitor's center and the actor's actual allocated width.

**Step 2:** Reposition after collapsed/expanded width transitions and monitor allocation changes.

**Step 3:** Keep the top edge offset configurable through existing geometry without introducing a new setting.

**Step 4:** Ensure expanded content remains centered rather than inheriting an old left-aligned allocation.

---

### Task 3: Implement adaptive glass surface styling

**Files:**
- Modify: `notch.js`
- Modify: `stylesheet.css`

**Step 1:** Add a helper that normalizes the configured accent color and creates a low-alpha glass tint.

**Step 2:** Apply full-radius styling to `.nexnotch`, `.nexnotch-bg`, and the expanded surface.

**Step 3:** Add subtle border, top highlight, inner depth, and shadow without relying on compositor blur.

**Step 4:** Replace sharp/rectangular controls with consistent rounded glass controls and hover states.

**Step 5:** Keep text and active states readable across accent colors.

---

### Task 4: Polish cards, tabs, and content spacing

**Files:**
- Modify: `stylesheet.css`

**Step 1:** Round tabs, segmented controls, cards, entries, and action buttons.

**Step 2:** Add consistent padding and spacing for the expanded header, tab row, and content area.

**Step 3:** Add focused/active/hover visual states that use the adaptive accent tint.

**Step 4:** Avoid excessive glass layering for performance.

---

### Task 5: Verify installation and runtime

**Files:**
- Modify: none

**Step 1:** Run `make compile-schemas`.

**Step 2:** Run `make install`.

**Step 3:** Run a headless GNOME Shell 50 session and check that no `nexnotch` error appears.

**Step 4:** Run `make pack` and `unzip -tq nexnotch@nexvar.shell-extension.zip`.

**Step 5:** Run `git diff --check` and report the required Wayland session restart.
