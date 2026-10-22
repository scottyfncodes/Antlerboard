# Antlerboard

See README.md for setup and architecture. CI runs `npm run lint`, `npx tsc --noEmit` and `npx vitest run` on every pull request.

## Design guardrails

Avoid generic AI-site patterns. Design should always be intentional. Always on purpose.

### Icons & type
- Don't default to Lucide for every icon. Use fewer icons, and pick or draw ones that fit the project.
- No emojis in headings, cards, or button labels.
- No sparkle/AI star icons anywhere.
- Don't default to Inter, Geist, or Space Grotesk. Choose type that fits the project's personality.

### Layout
- No row of 3 identical feature cards with icon + title + one-liner.
- No bento grids of mismatched stat tiles.
- No fake terminal windows or "npx something init" snippets unless the product has a real CLI.
- No placeholder product shots ("screenshot coming soon", gradient boxes in browser chrome). Use real screens or cut the section.

### Color & effects
- No default purple-on-black palette.
- No liquid glass / frosted blur cards over gradient backgrounds.
- No blurred radial gradient orbs as decoration.
- No dot-grid background texture.
- No rainbow-coded cards where each tile gets its own pastel. Color should mean something.

### Motion
- Arrows on buttons only where they mean "go somewhere," no animated arrow nudges.
- Hover effects only on clickable things, and subtle. No lift-and-scale on every card.

### Copy
- No em dashes in UI copy.
- No "It's not X, it's Y" lines.
- No hype phrasing ("blazing fast", "fort-knox secure", "AI magic").
- No made-up stats ("10x", "99.9%", "120+", "∞") unless they're real.
