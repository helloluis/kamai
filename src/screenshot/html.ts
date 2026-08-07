/**
 * HTML escaping for rendered capture cards.
 *
 * Card content is scraped from third-party posts and rendered in a real
 * browser, so an unescaped title containing `<script>` would execute in the
 * capture context. Escapes the five XML entities plus the forward slash, so
 * `</style>` and `</script>` cannot break out of an enclosing element either.
 */
const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#47;',
};

export function escapeHtml(input: unknown): string {
  if (input == null) return '';
  return String(input).replace(/[&<>"'/]/g, (c) => ENTITIES[c]);
}
