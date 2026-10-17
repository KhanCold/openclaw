export function formatFrontmatterValue(value: string): string {
  // Frontmatter is yaml-ish; quote values with structural chars.
  if (value.length === 0) {
    return '""';
  }
  if (
    value.trim() !== value ||
    /^(?:["']|-(?:[ \t]|$))/.test(value) ||
    /[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}
