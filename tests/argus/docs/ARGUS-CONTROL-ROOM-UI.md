# Argus Control Room — UI direction

## Goal

Build Argus as a serious agent-testing control room, visually related to the Zeus frontend without copying Zeus's product semantics.

Argus should feel like a member of the same product family: dark technical UI, restrained surfaces, crisp typography, tight spacing, strong borders, small radii, and a single high-signal accent color. The interface must prioritize test execution, evidence, and verdicts over marketing content.

## Zeus visual DNA to carry forward

Reference: Zeus frontend `frontend/src/index.css`.

- Deep navy/charcoal background rather than pure black.
- Near-white foreground with muted secondary text.
- Thin, low-contrast borders.
- Compact 6px-ish radius language.
- Inter for UI text; JetBrains Mono/Fira Code for technical values.
- Dark sidebar/navigation surface distinct from the main canvas.
- Small elevation changes rather than large shadows.
- One strong accent color for primary actions and active states.
- Hover/active elevation that changes surface tone instead of introducing glossy effects.
- Dense but readable dashboard spacing.
- Technical data should use monospace where precision matters.

## Argus-specific visual identity

Do not use Zeus's lightning/gold identity literally.

Argus accent: restrained electric blue/cyan, used sparingly for active controls, execution progress and primary CTA. Verdict semantics use independent status colors:

- PROVEN_SUCCESS: green
- PROVEN_FAILURE: red
- UNRESOLVED: amber
- UNKNOWN / pending: neutral blue/gray

Avoid gradients, stock AI imagery, robot illustrations, crypto motifs and decorative 3D graphics.

## Application shell

Desktop:

- Fixed left sidebar.
- Argus wordmark at top.
- Primary navigation: Overview, Tests, Scenarios, Evidence, Reports.
- Settings separated at bottom.
- Main content uses a constrained wide canvas.
- Top bar may contain environment/status and the primary Run Test action.

Mobile:

- Sidebar becomes compact top navigation/drawer.
- Preserve the same hierarchy and labels.
- Tables become stacked cards where necessary.

## Overview

Hero is operational, not marketing:

**Argus**
**Test whether your agent behaves correctly when the world goes wrong.**

Primary CTA: **Run a test**

Below it, show a compact five-stage execution model:

Agent → Scenario → Target → Evidence → Verdict

Then show:

1. Current/recent execution panel.
2. Scenario/fault chips.
3. Latest verdict.
4. Recent tests table/list.

Use clearly marked demo data until real backend data is connected.

## Run Test

A focused multi-step control surface:

1. Agent — select/configure test subject.
2. Scenario — choose fault profile.
3. Target — select target adapter.
4. Assertions — review expected invariants.
5. Execute — run test.

Fault presets:

Honest, Impatient, Duplicate, Adversarial, Slow, Broken, Delivery Loss, Crash.

The UI should make the test configuration feel deterministic and inspectable, not like a generic chatbot prompt.

## Live execution

Show an execution timeline with stages and evidence arriving in order.

Example evidence categories:

- request
- observation
- payment
- response
- timeout
- receipt
- assertion

Each event has timestamp, source, type and compact payload preview.

The user should be able to open an event without leaving the test context.

## Verdict

Verdict is the visual focal point of a completed test.

Primary states:

- PROVEN_SUCCESS
- PROVEN_FAILURE
- UNRESOLVED

Every verdict must show the evidence/assertions that support it. Never present a verdict as a decorative status badge without a traceable reason.

## Tests

Dense operational table:

- Test ID
- Agent
- Scenario
- Target
- Status
- Verdict
- Started
- Duration

Row click opens a test detail drawer/page.

Filters should be functional in the prototype and later map cleanly to backend query parameters.

## Evidence

Evidence explorer with:

- test filter
- source/type filter
- timestamp
- event list
- detail viewer

Evidence is first-class product data, not an appendix.

## Reports

Report preview should communicate:

- test identity
- scenario
- target
- verdict
- assertions
- evidence summary
- unresolved items

Keep certificate/badge language out of the first MVP.

## Settings

Prototype controls can include:

- default target
- execution timeout
- evidence verbosity
- theme/status preference

They should be designed as real controls even when backed by local state initially.

## Component language

Prefer reusable primitives:

- AppShell
- Sidebar
- TopBar
- PageHeader
- Panel
- StatusBadge
- PrimaryButton
- GhostButton
- SegmentedControl
- FilterBar
- DataTable
- EvidenceRow
- EvidenceViewer
- TestTimeline
- VerdictCard
- Drawer/Modal
- EmptyState
- LoadingState
- ErrorState

Do not build one-off visual blocks for each page if the same interaction pattern can be represented by a shared component.

## Backend seam

Frontend state should be shaped around future Argus domain objects:

- Test
- Scenario
- Target
- Evidence
- Assertion
- Verdict

Keep API calls behind small client/adaptor functions. Demo data must be replaceable without rewriting the visual components.

## Acceptance bar

Before calling the UI MVP complete:

- Desktop and mobile layouts work.
- Every visible control has an intentional interaction.
- Run Test flow is navigable end-to-end with demo data.
- Test detail opens from a test row.
- Evidence viewer opens from an evidence item.
- Verdict states are visually distinct and evidence-backed.
- Loading, empty and error states exist.
- No fake customer logos, testimonials, metrics or unsupported claims.
- Zeus is used only as visual lineage, not as copied product structure.
