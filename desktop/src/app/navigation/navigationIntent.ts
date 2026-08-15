export function dispatchNavigationIntent(): void {
  window.dispatchEvent(new Event("buzz:navigation-intent"));
}
