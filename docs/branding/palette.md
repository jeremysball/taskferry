# Taskferry Palette

## Direction

The palette is downstream of the change-boundary position: dark ink for the
daemon and control surface, warm paper for inspection, lime for a live route or
positive movement, and orange for a visible warning or handoff. The existing
otter board already uses this family, so the palette records and tightens an
existing direction rather than inventing a new metaphor.

## Validated colors

| Token | Hex | Use | Provenance |
|---|---|---|---|
| `paper` | `#F7F5EF` | Main light background | Dominant color in `taskferry-brand-board.png` and `taskferry-manual-otters.png` |
| `navy` | `#101B2D` | Primary text, borders, dark surface | Dominant otter and dark-surface color in both existing assets |
| `ink` | `#11141A` | Deep dark surface and high-emphasis text | Dominant dark UI color in `taskferry-brand-board.png` |
| `lime` | `#B7F24A` | Positive state, route signal, selected control | Repeated accent in both existing assets |
| `orange` | `#F47B3A` | Warning, interruption, handoff accent | Repeated accent in `taskferry-manual-otters.png` |

## Contrast validation

The ratios below use the foreground/background pairs intended for the brand
surface. Ratios are WCAG relative luminance contrast ratios.

| Pair | Ratio | Use | Result |
|---|---:|---|---|
| `paper` on `navy` | 15.83:1 | Dark-surface text | Pass |
| `navy` on `paper` | 15.83:1 | Main body text | Pass |
| `navy` on `lime` | 13.00:1 | Positive control label | Pass |
| `navy` on `orange` | 6.36:1 | Warning control label | Pass |
| `ink` on `paper` | 16.91:1 | High-emphasis light-surface text | Pass |
| `paper` on `orange` | 2.49:1 | Prohibited for body or small control text | Fail |

The paper-on-orange pair is retained as a documented constraint, not as an
approved text treatment. Orange is an accent field with dark text, not a light
text background.

## Asset provenance and accessibility

- `taskferry-manual-otters.png` is concept artwork showing three visual routes;
  it is not a runtime screenshot.
- `taskferry-brand-board.png` is a brand exploration board;
  it is not a product-status capture.
- Suggested accessibility text: “Three dark otter route marks on a warm paper
  field, with lime and orange signals for movement and handoff.”
- No new image was generated for this package. Future assets must preserve the
  approved change-boundary message and carry equivalent accessibility text.
