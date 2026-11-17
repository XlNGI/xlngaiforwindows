/** Keep the active item in place when an inline detail changes the list height. */
export function preserveInlineDetailPosition(
  scroller: HTMLElement | null,
  anchor: HTMLElement | undefined | null,
) {
  if (!scroller || !anchor) return;
  const top = anchor.getBoundingClientRect().top;
  window.requestAnimationFrame(() => {
    if (!scroller.isConnected || !anchor.isConnected) return;
    scroller.scrollTop += anchor.getBoundingClientRect().top - top;
  });
}
