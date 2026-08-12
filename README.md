# gitcity

Turn any GitHub contribution graph into a living 3D city. Every day is a building, height is commit volume, and the whole year lights up as a skyline you can orbit.

**[Open the live demo](https://aprilnh7.github.io/gitcity/?user=torvalds&range=2024)**

![gitcity rendering torvalds' 2024 contributions](docs/shot-neon.png)

## Why

GitHub's own Skyline was the fun way to look back at a year of work, and it is gone. `skyline.github.com` no longer resolves. gitcity is a replacement that runs entirely in the browser, needs no login, and does more than the original: five themes, per day inspection, PNG export, and the STL export that made Skyline worth printing.

## What it does

- **Any profile, any year.** Type a username, pick a year or the rolling last twelve months.
- **Reads exactly like your graph.** Colour follows GitHub's own 0 to 4 intensity levels, so the city and the contribution graph always agree.
- **Log scaled heights.** One 100 commit day does not flatten the rest of the year into the pavement.
- **Hover any building** to see the date and exact count.
- **Five themes.** Neon, Aurora, Sunset, Matrix, Ice.
- **Save a PNG** of the current camera angle.
- **Export an STL** and print your year. Buildings sit on a base plate, ready to slice.
- **Shareable links.** `?user=torvalds&range=2024&theme=sunset` restores the exact view.

## Themes

| Aurora | Sunset |
| --- | --- |
| ![Aurora theme](docs/shot-aurora.png) | ![Sunset theme](docs/shot-sunset.png) |

| Matrix | Ice |
| --- | --- |
| ![Matrix theme](docs/shot-matrix.png) | ![Ice theme](docs/shot-ice.png) |

## How it works

The whole city is a single `InstancedMesh`, one instance per day, so a full year is one draw call.

`MeshStandardMaterial` has no per instance emissive slot, which is a problem when every building needs to glow its own colour. gitcity patches the shader in `onBeforeCompile` and drives `totalEmissiveRadiance` from the instance colour instead. The same patch adds the window grid, generated procedurally from world position and surface normal, so rows line up across a building regardless of how tall it scaled and every wall gets covered without a texture.

The reflection is a second `InstancedMesh` sharing the same matrices with `scale.y = -1`, sitting under a semi transparent plaza. Cheaper than a real reflection pass and it survives bloom, which a `Reflector` does not.

Camera framing projects all eight corners of the city's bounding box into camera space and solves for the distance that keeps every corner inside the frustum. That is what keeps the full year in frame on both an ultrawide monitor and a portrait phone.

## Data

Contribution data comes from [github-contributions-api](https://github-contributions-api.jogruber.de), a public read only mirror of the profile graph. No token, no login, nothing stored. If the API is unreachable the app falls back to a generated demo city so the scene is never empty.

## Run it locally

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

```bash
npm run build    # typecheck + production bundle
npm run smoke    # end to end checks against a running dev server
```

The smoke test covers data loading, hover raycasting, theme switching, STL and PNG export, unknown user handling, and the mobile layout.

## Contributing

Issues and pull requests are welcome. Good first additions: new themes in `src/themes.ts` (self contained, just a colour ramp and a couple of numbers), a glTF exporter alongside the STL one, or an orthographic camera mode.

## License

MIT
