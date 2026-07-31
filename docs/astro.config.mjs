/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
 *
 * This file is part of Fabr.
 *
 * Fabr is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Fabr is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Fabr. If not, see <https://www.gnu.org/licenses/>.
 */

// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Fabr's own documentation site. Built by fabr itself (`fabr build docs`), not
// yarn/npm: the astro CLI is wrapped as an opaque passthrough target — see
// PROJECT.fabr's `docs_build_tool` / `docs` targets.
export default defineConfig({
  site: "https://fabr.build",
  integrations: [
    starlight({
      title: "Fabr",
      description: "A dataflow-based build tool for fast, accurate, deterministic builds.",
      customCss: ["./src/styles/theme.css"],
      logo: {
        light: "./src/assets/fabr-mark-light.svg",
        dark: "./src/assets/fabr-mark-dark.svg",
      },
      // IBM Plex Sans/Mono are the design's typefaces, wired in as the site's
      // --sl-font / --sl-font-mono by theme.css.
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap",
          },
        },
      ],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/fabr/fabr" }],
      // The header's right-hand slot carries the section nav ahead of the social
      // icons — see src/components/HeaderNav.astro.
      components: { SocialIcons: "./src/components/HeaderNav.astro" },
      sidebar: [
        { label: "Introduction", link: "/introduction/" },
        { label: "Quick start (JS/TS)", link: "/quickstart-js/" },
        {
          label: "Guides",
          items: [
            { label: "Conceptual model", link: "/guides/concepts" },
            { label: "Watch mode & dev servers", link: "/guides/watch/" }
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Command line", link: "/reference/command-line/" },
            { label: "Language syntax", link: "/reference/syntax/" },
            { label: "Core reference", link: "/reference/standard-rules/" },
            { label: "JavaScript reference", link: "/reference/js-rules/" },
          ],
        },
        { label: "Known limitations", link: "/known-limitations/" },
        { label: "Release notes", link: "/release-notes/" },
        { label: "Getting involved", link: "/contributing/" },
      ],
    }),
  ],
});
