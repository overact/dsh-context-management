/** Tool output that renders JSON values (pretty-printed) and passes strings through. */
export const jsonToolOutput = type => ({
  schema: { type },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
