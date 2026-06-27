---
name: design-trials
description: Generate multiple unique UI layout variations behind a temporary switcher, iterate through feedback rounds where each round produces entirely new designs, then harvest the winner and strip all scaffolding. Use when the user wants to redesign a UI through comparison and iteration rather than a single proposal, mentions "variations", "layout options", "redesign", or wants to compare multiple approaches side by side.
---

# Design Variation Rounds

A redesign skill that buys convergence through divergence: build many **variations** at once, let the user compare them live, and use each **round** of feedback to produce entirely new designs — not tweaks. The **scaffold** (a temporary numbered switcher) makes comparison instant. When the user picks a direction, **harvest** the winner and remove every trace of the variation system.

## Companion skills

If `frontend-design` is present, load it before generating layouts — its guidance on distinctive, non-templated visual choices, typography, and palette directly raises the quality of each variation. If `grill-with-docs` is present, load it during Ground — its interview-style challenge of the plan against the domain model sharpens terminology and catches assumptions before they propagate into N layouts.

**Completion:** companion skills loaded if available.

## Scaffold

Build a temporary switcher into the real app: numbered buttons (1–N) that swap layouts without a page reload. The switcher persists the user's choice across sessions. Each layout swap must destroy the previous controller — remove all event listeners, message handlers, storage listeners — and re-initialize a fresh one against the new DOM. Listener leaks across swaps break the app silently, and the damage is invisible until a later swap double-fires a handler.

Every layout must contain all element IDs the controller requires. A missing ID crashes on init. Verify by counting each ID across all layout templates before building.

**Completion:** switcher swaps between N layouts with no listener leaks; every layout inits without errors.

## Vary

Generate N unique layouts (5 is a good default). Each must be structurally distinct — not a reskin of the same structure with different colors. Vary the information hierarchy: which element is the hero, how domain behavior is presented (breadcrumbs, flow nodes, inline text, data grid, pills), how density is distributed, what is hidden behind a toggle versus always visible.

Each layout must surface the domain information found in Ground, but present it differently. The user should feel that switching between layouts changes how they understand the data, not just how it looks.

**Completion:** N layouts, each structurally unique, each surfacing domain info, each containing all required element IDs.

## Round

Present the variations and collect feedback. A round is not a tweak pass — each round produces entirely new designs that incorporate all accumulated feedback. If the user says "I liked the compactness of 2 and the breadcrumbs of 5," the next round's designs are fresh layouts that combine those qualities, not edits to 2 and 5.

Feedback compounds: each round's designs carry every constraint from every prior round. The user narrows the space; you fill it with new options.

**Completion:** the user picks a direction, or gives feedback for another round.

## Harvest

When the user picks a layout, make it the only layout. Remove the switcher, the layout-template system, the extra CSS for discarded layouts, and any storage keys for the selected layout. Inline the winner's HTML directly into the app's templates. Move any shared logic (like domain-behavior rendering) out of the variation system and into the permanent codebase.

The final codebase should have no trace that a variation system ever existed — no switcher markup, no layout-switching functions, no orphaned CSS classes, no storage keys.

**Completion:** no switcher, no layout templates, no extra CSS classes from discarded layouts; the winner is the sole layout, wired permanently.
