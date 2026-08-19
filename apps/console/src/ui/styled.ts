import { StyledText, bg, bold, fg, type TextChunk } from "@opentui/core";

import type { Line } from "../view/format.ts";
import { COLOR, toneColor } from "./theme.ts";

/**
 * The one place `Line[]` becomes something OpenTUI can draw.
 *
 * `TextRenderable` takes a single `fg` for its whole content, so anything that colours part of a
 * line has to arrive as `StyledText` (`renderables/Text.d.ts`). Keeping that conversion here is
 * what lets every `view/` function stay a pure string/span producer with no renderer import,
 * which PRD-3 §4.3 requires.
 *
 * Note what this cannot reach: `SelectRenderable` types its option `name` and `description` as
 * plain strings, so the run and alert lists are outside the styled path. That is tolerable rather
 * than unfortunate — PRD-3 §9.8 requires every state to carry a glyph or a word regardless of
 * colour, and in those two panes it already does.
 */
export function styled(lines: Line[]): StyledText {
  const chunks: TextChunk[] = [];

  for (const [at, line] of lines.entries()) {
    if (at > 0) chunks.push(fg(COLOR.text)("\n"));

    if (typeof line === "string") {
      if (line !== "") chunks.push(fg(COLOR.text)(line));
      continue;
    }

    for (const span of line) {
      if (span.text === "") continue;
      let chunk = fg(toneColor(span.tone))(span.text);
      if (span.bg !== undefined) chunk = bg(toneColor(span.bg))(chunk);
      if (span.bold === true) chunk = bold(chunk);
      chunks.push(chunk);
    }
  }

  return new StyledText(chunks);
}
