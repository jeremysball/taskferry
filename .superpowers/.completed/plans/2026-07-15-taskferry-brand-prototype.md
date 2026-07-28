# Taskferry Brand Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an interactive Lavish review board for Taskferry's otter-messenger brand, then generate and inspect its final Recraft SVG logo.

**Architecture:** A single self-contained HTML board presents three SVG concept directions without adding product dependencies. Lavish serves that file locally for element-level review. The selected direction becomes a disciplined Recraft V3 exploration and then a V4.1 SVG final asset stored under `brand-assets/`.

**Tech Stack:** Static HTML/CSS/SVG, `npx -y lavish-axi`, Recraft V3 and V4.1 through fal.ai.

## Global Constraints

- The mascot is a streamlined otter messenger in three-quarter profile.
- Use near-black navy, electric lime, ferry orange, and off-white.
- Use flat vector geometry, a bold uniform outline, and no gradients.
- Avoid robot imagery, photorealism, and overly cute facial features.
- Show every concept as a favicon, horizontal `taskferry` lockup, and light/dark application.
- Do not call Recraft until the user selects a Lavish concept.

---

### Task 1: Create the interactive otter concept board

**Files:**
- Create: `brand-assets/taskferry-brand-exploration.html`

**Interfaces:**
- Consumes: the approved palette and mascot constraints above.
- Produces: a self-contained local HTML artifact that `lavish-axi` opens by file path.

- [ ] **Step 1: Read Lavish design guidance**

Run:

```bash
npx -y lavish-axi design
npx -y lavish-axi playbook comparison
```

Expected: concise guidance for a reviewable comparison artifact, including layout and feedback-control requirements.

- [ ] **Step 2: Create the HTML artifact**

Create `brand-assets/taskferry-brand-exploration.html` with this document structure:

```html
<main>
  <header>
    <p class="eyebrow">TASKFERRY / BRAND EXPLORATION 01</p>
    <h1>Choose the courier.</h1>
    <p>Three technical otter marks for dependable background work.</p>
  </header>
  <section class="concept-grid" aria-label="Mascot concepts">
    <article id="signal-otter" aria-labelledby="signal-title">
      <h2 id="signal-title">01 / Signal Otter</h2>
      <p>Dispatch pennant and route arc.</p>
    </article>
    <article id="wake-otter" aria-labelledby="wake-title">
      <h2 id="wake-title">02 / Wake Otter</h2>
      <p>Wake forms the routing signal.</p>
    </article>
    <article id="cargo-otter" aria-labelledby="cargo-title">
      <h2 id="cargo-title">03 / Cargo Otter</h2>
      <p>Sealed task canister signals reliable delivery.</p>
    </article>
  </section>
</main>
```

For each article, include an inline SVG mascot, a 48-pixel favicon, a horizontal
`taskferry` lockup, and light/dark previews. Use these direction-specific identifiers:

```html
<h2>01 / Signal Otter</h2>
<p>Dispatch pennant and route arc.</p>

<h2>02 / Wake Otter</h2>
<p>Wake forms the routing signal.</p>

<h2>03 / Cargo Otter</h2>
<p>Sealed task canister signals reliable delivery.</p>
```

- [ ] **Step 3: Validate the artifact locally**

Run:

```bash
npx -y lavish-axi brand-assets/taskferry-brand-exploration.html
```

Expected: Lavish opens the local board without a severe layout warning. Inspect all three concepts at desktop and narrow widths.

- [ ] **Step 4: Commit the concept board**

```bash
git add brand-assets/taskferry-brand-exploration.html
git commit -m "feat(taskferry): add otter mascot concept board"
```

### Task 2: Capture the human selection through Lavish

**Files:**
- Modify: `brand-assets/taskferry-brand-exploration.html` only if feedback identifies a concrete board defect.

**Interfaces:**
- Consumes: the opened concept board from Task 1.
- Produces: an explicit chosen direction and any corrective requirements for the Recraft prompt.

- [ ] **Step 1: Request focused feedback**

Ask the reviewer to select one concept and annotate only concrete changes: silhouette, expression, route shape, canister/pennant, palette, or wordmark spacing.

- [ ] **Step 2: Poll for feedback**

Run:

```bash
npx -y lavish-axi poll brand-assets/taskferry-brand-exploration.html
```

Expected: a feedback payload naming the chosen concept, or an `ended` response after the reviewer completes the session.

- [ ] **Step 3: Apply only requested board corrections**

If feedback identifies a board defect, make the smallest HTML/CSS/SVG correction, reopen the same file path, and repeat the poll. Keep the selected concept identifier unchanged.

- [ ] **Step 4: Commit approved corrections**

```bash
git add brand-assets/taskferry-brand-exploration.html
git commit -m "fix(taskferry): refine approved mascot concept"
```

### Task 3: Generate and inspect the final Recraft SVG

**Files:**
- Create: `brand-assets/taskferry-logo.svg`
- Create: `brand-assets/taskferry-logo-preview.png`

**Interfaces:**
- Consumes: the selected concept identifier and the reviewer’s annotations from Task 2.
- Produces: a scalable final logo mark and a rendered preview for visual inspection.

- [ ] **Step 1: Write the selected-direction prompt**

Write `brand-assets/taskferry-recraft-prompt.txt` using this structure, replacing only `[selected concept]` with the review result:

```text
A flat vector logo mark and mascot for an agentic task-routing product named "taskferry". A streamlined otter messenger in three-quarter profile, [selected concept], a single purposeful route curve formed by the tail or wake, alert and technical rather than cute. Bold uniform dark-navy outline, geometric silhouette, flat near-black navy, electric lime, ferry orange, and off-white palette. Icon-ready circular composition with generous clear space. No gradients, no texture, no robot imagery, no photorealism, no extra text.
```

- [ ] **Step 2: Run a Recraft V3 exploration**

Run:

```bash
~/.claude/skills/recraft-prompting/bin/generate.sh \
  -f brand-assets/taskferry-recraft-prompt.txt \
  -o brand-assets/taskferry-logo-exploration.svg \
  -y vector_illustration/roundish_flat \
  -c 101B2D,B7F24A,F47B3A,F7F5EF \
  -b F7F5EF \
  -i square_hd
```

Expected: an SVG or image with the approved silhouette, no prompt-text artifacts, and clear contrast at favicon scale.

- [ ] **Step 3: Regenerate the approved result as a final V4.1 SVG**

Run:

```bash
~/.claude/skills/recraft-prompting/bin/generate.sh \
  -f brand-assets/taskferry-recraft-prompt.txt \
  -o brand-assets/taskferry-logo.svg \
  -c 101B2D,B7F24A,F47B3A,F7F5EF \
  -b F7F5EF \
  -i square_hd \
  -m fal-ai/recraft/v4.1/text-to-vector
```

Expected: `taskferry-logo.svg` is a clean, scalable vector asset.

- [ ] **Step 4: Render and inspect the final asset**

Run:

```bash
rsvg-convert --width 1024 --height 1024 brand-assets/taskferry-logo.svg > brand-assets/taskferry-logo-preview.png
```

Open the SVG at 32 pixels, 64 pixels, and 512 pixels. Confirm that the otter silhouette, route curve, and high-contrast palette remain legible.

- [ ] **Step 5: Commit the final assets**

```bash
git add brand-assets/taskferry-logo.svg brand-assets/taskferry-logo-preview.png brand-assets/taskferry-recraft-prompt.txt
git commit -m "feat(taskferry): add otter messenger brand mark"
```
