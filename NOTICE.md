# Source attribution

The relay read model in `src/features/relay` and development read broker in
`browser-host` are adapted from the supplied Astra example. The channel layout
and virtualizer behavior are adapted from that example's Channels view.

Astra's presentation is derived from Block Buzz `prototypes/project-cube-orbit`,
revision `0cd836965110adb18b95747c8656779c470d6e4d`:
https://github.com/block/buzz/tree/0cd836965110adb18b95747c8656779c470d6e4d/prototypes/project-cube-orbit

The Apache-2.0 license is preserved in [LICENSE](LICENSE). Changes here
include Cordis service ownership, scoped channel panels, GitHub reference rendering,
connection lifecycle, stylesheet extraction and integration with the foundation.

App, favicon, and touch icons in `public/` and `src-tauri/icons/` are copied from
Block Buzz's `desktop/src-tauri/icons` ([source repository](https://github.com/block/buzz)).
The shell palette and proportions are adapted from the supplied Buzz screenshots.

`public/bestie.png` is the snake portrait supplied by the user for the shell.

`public/shell-gradient.png` is the background image supplied by Wes for the bento
shell on 2026-09-09 (SHA-256
`618ce821eaea22dd30bddb0c2a933284f0a49f6b4f0cefff5ae0b51e2b3ea651`).
The repeating dots are drawn in CSS, not baked into the image.

The Emoji Mart picker configuration and search-input focus/correction behavior in
`src/features/messages/emoji-mart.ts` are adapted from Block Buzz
`desktop/src/features/custom-emoji/ui/EmojiPicker.tsx` at revision
`b9392d9d78744df365f9276e1ffe8c1baa5ea903`. The adapter adds scoped custom IDs,
explicit dictionary cleanup, and lazy loading for the session-owned catalog.

OneDrive is a trademark of Microsoft.

## Harness brand marks

The Goose and Pi marks in `src/shared/design-system/icons/HarnessLogos.tsx`
are reused from old Buzz to identify their respective harnesses.

Goose: [block/goose](https://github.com/block/goose), revision
`305849b71709b95b86ed9f11bd3bc939899c0aab`,
`documentation/static/img/goose.svg`. Apache-2.0 © Block, Inc.; the license is
preserved in [LICENSE](LICENSE). Old Buzz changed the fill to `currentColor`
and removed the redundant clipping wrapper. This app adds the shared icon
sizing, ref and decorative accessibility gateway.

Pi: [earendil-works/pi-website](https://github.com/earendil-works/pi-website),
revision `2f5e410b97474d0a34ec2500aa1aa58d6c3f992c`, `src/favicon.svg`.
The artwork is unchanged; this app adds the shared icon sizing, ref and
decorative accessibility gateway. Its license follows:

MIT License

Copyright (c) 2026 Earendil Inc. and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Claude: the bundled `icons/claude.png` is reused unchanged from Block Buzz's
`desktop/src/features/onboarding/assets/harness-logos/claude.png` to identify
Anthropic's Claude harness. Claude is a trademark of Anthropic.

Codex: the OpenAI Blossom mark in `CodexLogoArtwork` is taken from OpenAI's
brand kit (https://cdn.openai.com/brand/openai-logos.zip,
`SVGs/OAI_OpenAI-Blossom_Black.svg`) to identify OpenAI's Codex harness. This
app changes the fill to `currentColor` and crops the viewBox to the mark.
OpenAI and the Blossom logo are trademarks of OpenAI.

Hermes Agent: the bundled `icons/hermes.png` is reused unchanged from Block Buzz's
`desktop/public/harness-logos/hermes.png`. Its upstream is
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), revision
`6ad632b`, `website/static/img/logo.png`, MIT © 2025 Nous Research. Old Buzz
cropped the border, padded it to square, resized to 64×64 and quantised it to
16 colours. The MIT license terms above also apply to this artwork, with the
Nous Research copyright notice.
