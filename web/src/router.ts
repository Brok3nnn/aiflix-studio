/** Two routes: `#/` (the studio) and `#/films/<id>` (the studio with a film open). */
export type Route = { name: 'studio' } | { name: 'film'; id: string };

export function currentRoute(): Route {
  const match = /^#\/films\/([\w-]+)$/.exec(window.location.hash);
  return match?.[1] ? { name: 'film', id: match[1] } : { name: 'studio' };
}

export function navigate(route: Route): void {
  window.location.hash = route.name === 'film' ? `#/films/${route.id}` : '#/';
}

export function onRouteChange(listener: (route: Route) => void): void {
  window.addEventListener('hashchange', () => {
    listener(currentRoute());
  });
}
