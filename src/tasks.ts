/**
 * Task helpers.
 *
 * The CLI has no command that creates a task: a task is just a Markdown line, so
 * the server builds the line and appends it to a note (or to the daily note).
 * The `task` command only updates an existing one, addressed by `ref=path:line`.
 */

/**
 * Builds the Markdown line for a new task.
 *
 * @param content Task text, without the checkbox markup.
 * @param tags    Comma-separated tags, with or without a leading `#`. Blanks are dropped.
 * @returns A line such as `- [ ] Call the notary #work #urgent`.
 */
export function buildTaskLine(content: string, tags?: string): string {
  const hashTags = (tags ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`);

  return [`- [ ] ${content.trim()}`, ...hashTags].join(" ");
}
