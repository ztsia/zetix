# shadcn/ui Component Index

Quick-reference for component selection. Read this file first to shortlist candidates, then read only the relevant full docs.

> **All docs live in:** `fyp-web-frontend/src/components/ui/docs/<component>.md`

---

## Layout

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Accordion | Vertically stacked collapsible sections for organizing related content where space is limited | type (single/multiple), collapsible, disabled items |
| Card | Container for displaying grouped related content with header, body, and footer | size (default, sm), image, header, footer |
| Collapsible | Single expandable/collapsible panel for revealing supplementary content | open state, controlled/uncontrolled |
| Resizable | Draggable panel resize handles with keyboard and touch support | orientation (horizontal, vertical), handle visibility |
| ScrollArea | Custom scrollbar styling for scrollable containers | orientation (horizontal, vertical) |
| Tabs | Tabbed interface for switching between related content panels | variant (default, line), orientation (horizontal, vertical) |

---

## Overlay

| Component | When to use | Key variants / features |
|:--|:--|:--|
| AlertDialog | Requires explicit user confirmation for **destructive or irreversible** actions (delete, discard) | size (default, sm), destructive action |
| Dialog | Centered modal for focused content or forms that don't need full-page navigation | custom close, scrollable content, sticky footer |
| Drawer | Slide-out panel from screen edge — use for mobile-friendly flows or supplementary detail | direction (top, right, bottom, left) |
| HoverCard | Popup showing preview/summary content **on hover** — not for actions | open/close delay, positioning |
| Popover | Portal popover for enriched content triggered by a button — use for inline forms or pickers | alignment, form integration |
| Sheet | Dialog that extends from screen edge — use for settings panels or secondary content | side (top, right, bottom, left) |
| Tooltip | Contextual label on hover/focus — use for icon-only buttons or keyboard shortcuts | side/align positioning, disabled button wrapper |

> **Choosing between overlays:** `AlertDialog` = destructive confirm only. `Dialog` = forms/detail, centered. `Sheet` = settings/panels, edge-anchored. `Drawer` = mobile gestures, edge-anchored. `Popover` = inline picker/form, stays near trigger. `HoverCard` = hover preview, no actions. `Tooltip` = label only, no interaction.

---

## Form Input

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Calendar | Date selection with month/year navigation | mode (single, range), captionLayout (dropdown, label), disabled dates |
| Checkbox | Binary toggle for selecting one or multiple items | checked, indeterminate, disabled, aria-invalid |
| Combobox | **Searchable** dropdown — use over Select when options are numerous or filterable | multiple selection, clear button, auto-highlight |
| Command | Keyboard-driven command palette for searching and triggering actions | groups, shortcuts, scrollable, dialog variant |
| DatePicker | Popover-based date selection with optional presets | range picker, time, natural language input |
| Input | Single-line text entry | type (text, email, file), disabled, invalid |
| InputGroup | Input with prefix/suffix addons (icons, buttons, text labels) | align (inline-start, inline-end, block-start, block-end) |
| InputOTP | One-time password input with copy/paste support | maxLength, pattern, separator, controlled value |
| Label | Accessible label for form controls | htmlFor, asChild |
| RadioGroup | Single-select mutually exclusive options | description, choice card, disabled items |
| Select | Dropdown list selection — use when options are fixed and no search is needed | groups, scrollable, disabled items |
| Slider | Range selection with draggable thumb(s) | range (multiple thumbs), vertical, controlled |
| Switch | Toggle for on/off binary states (settings, preferences) | checked, disabled, invalid |
| Textarea | Multi-line text input | disabled, invalid, button pairing |
| Toggle | Two-state button toggling on/off | variant (default, outline), size |
| ToggleGroup | Group of toggle buttons with single or multiple selection | type (single, multiple), variant, orientation |

> **Choosing between selects:** `Select` = fixed list, no search. `Combobox` = searchable/filterable list. `Command` = keyboard-first action menu. `RadioGroup` = always-visible options (≤6 items).

---

## Form Structure

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Button | Primary interactive element for triggering actions | variant (default, outline, ghost, destructive, secondary, link), size, icon, spinner |
| ButtonGroup | Group related buttons with consistent styling | orientation (horizontal, vertical), separator, split |
| Field | Wrapper combining label, control, description, and error — use inside Form or standalone | orientation (vertical, horizontal, responsive), invalid state |
| Form | React Hook Form integration for complex forms with validation | Field wrapper, label, description, error handling, array fields |

---

## Data Display

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Chart | Visualize quantitative data (bar, line, area charts) | ChartContainer, ChartTooltip, ChartLegend, themed colors |
| DataTable | Sortable, filterable, paginated table with row selection | sorting, filtering, pagination, visibility toggle, row selection |
| Item | Flexible list entry with media, title, description, and actions | variant (default, outline, muted), size (default, sm, xs), link |
| Table | Semantic HTML table for structured data without interactivity | caption, header, footer, actions, responsive |

> **Choosing between tables:** `Table` = static display. `DataTable` = interactive (sort/filter/select).

---

## Navigation

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Breadcrumb | Show hierarchical path and current location | link, separator, dropdown, ellipsis |
| ContextMenu | Right-click contextual actions for elements | submenus, checkboxes, radio items, shortcuts |
| DropdownMenu | Button-triggered action/selection menu | submenu, checkbox/radio items, icons, shortcuts |
| Menubar | Persistent horizontal menu bar (macOS-style app menus) | checkbox/radio items, submenus, separators |
| NavigationMenu | Horizontal site navigation with submenus | triggers, content, link styling |
| Pagination | Navigate between pages | simple variant, icons-only, ellipsis |
| Sidebar | Collapsible sidebar with header, content, footer, menu | collapsible (offcanvas, icon, none), variant (sidebar, floating, inset) |

---

## Feedback

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Alert | Static callout message requiring user attention (info, warning, error) | variant (default, destructive) |
| Badge | Label or tag for status, category, or count | variant (default, secondary, destructive, outline) |
| Empty | Placeholder when no data exists — always handle empty states | icon, avatar, background, button action, outline variant |
| Progress | Visual indicator of task completion | label, controlled value, animated |
| Skeleton | Loading placeholder for async content — prevents layout shift | avatar, card, text, table shapes |
| Sonner | Toast notification for transient feedback (success, error, info) | position, types (default, success, error, loading) |
| Spinner | Animated loading indicator for in-progress operations | size variants, button/badge context |

> **Choosing between loading states:** `Skeleton` = content placeholder during load. `Spinner` = action in progress (button, inline). `Progress` = known completion percentage.

---

## Typography

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Kbd | Display keyboard key names for shortcuts | group, tooltip/button context |
| Typography | Text styling for headings, paragraphs, lists, quotes, code | h1–h4, paragraph, blockquote, list, code, lead, muted |

---

## Media

| Component | When to use | Key variants / features |
|:--|:--|:--|
| AspectRatio | Maintain consistent aspect ratio for images/videos | ratio prop (16/9, 4/3, 1/1, etc.) |
| Avatar | User profile image with automatic fallback | size (default, sm, lg), badge, group |
| Carousel | Horizontal/vertical scrolling collection of items | orientation, spacing, autoplay, plugins |

---

## Utility

| Component | When to use | Key variants / features |
|:--|:--|:--|
| Separator | Visual divider between sections | orientation (horizontal, vertical), inline text |
