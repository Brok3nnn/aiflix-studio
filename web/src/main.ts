import './base.css';
import './studio.css';
import type { FilmDto, Look, StudioInfoDto } from '../../shared/api.ts';
import { isValidRuntime, previewSceneDurations } from '../../shared/planner.ts';
import { api } from './api.ts';
import { esc } from './html.ts';
import { currentRoute, navigate, onRouteChange } from './router.ts';
import { headerHtml, isActive, libraryHtml, monitorHtml, progressHtml, resultHtml } from './views.ts';

const POLL_MS = 2_000;

interface State {
  info: StudioInfoDto | null;
  films: FilmDto[];
  selected: FilmDto | null;
  message: { tone: 'info' | 'success' | 'error'; text: string } | null;
  submitting: boolean;
}

const state: State = { info: null, films: [], selected: null, message: null, submitting: false };
let pollTimer: number | undefined;

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app element.');

/** Looks up an element of the page and checks its type at runtime. */
function element<T extends HTMLElement>(selector: string, type: { new (): T; prototype: T }): T {
  const found = app?.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`Missing ${selector}.`);
  return found;
}

function fieldValue(selector: string): string {
  const field = app?.querySelector(selector);
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement ||
    field instanceof HTMLSelectElement
  ) {
    return field.value.trim();
  }
  throw new Error(`Missing field ${selector}.`);
}

/** The film the monitor follows: the open one, else the one rendering, else the newest. */
function focusedFilm(): FilmDto | null {
  return state.selected ?? state.films.find(isActive) ?? state.films[0] ?? null;
}

function renderShell(): void {
  if (!app) return;
  app.innerHTML = `
    <div class="sc-page">
      <div id="app-header">${headerHtml(state.info)}</div>
      <main class="sc-main">
        <header class="sc-header">
          <div><h1>Make a short film</h1><p>Write a premise, pick a length and a look. The studio plans, shoots and edits it, with its own cast and poster.</p></div>
        </header>
        <div class="sc-grid">
          <section class="sc-create">
            <form id="film-form" class="sc-form" novalidate>
              <div class="sc-field"><label for="f-premise">Premise</label>
                <textarea id="f-premise" required rows="5" placeholder="A lighthouse keeper finds a letter that predicts the next storm..."></textarea></div>
              <div class="sc-field-row">
                <div class="sc-field"><label for="f-title">Title (optional)</label><input id="f-title" maxlength="120" placeholder="From the premise if empty" /></div>
                <div class="sc-field"><label for="f-genres">Genres</label><input id="f-genres" value="Drama, Mystery" /></div>
              </div>
              <div class="sc-field-row">
                <div class="sc-field"><label for="f-look">Look</label>
                  <select id="f-look"><option value="realistic">Realistic (live action)</option><option value="animated">Animated</option></select></div>
                <div class="sc-field"><label for="f-runtime">Runtime (seconds, even)</label><input id="f-runtime" type="number" min="8" step="2" value="64" /></div>
              </div>
              <div class="sc-field-row">
                <div class="sc-field"><label for="f-main">Minimum main characters</label><input id="f-main" type="number" min="1" max="6" value="2" /></div>
                <div class="sc-field"><label for="f-supporting">Minimum supporting characters</label><input id="f-supporting" type="number" min="0" max="12" value="2" /></div>
              </div>
              <p class="sc-field__hint" id="f-plan"></p>
              <div class="sc-form-foot">
                <button type="submit" class="sc-gen-btn" id="f-submit">Generate film</button>
                <p class="sc-status" id="f-status"></p>
              </div>
            </form>
          </section>
          <aside class="sc-side">
            <div id="sc-progress"></div>
            <div class="sc-lib">
              <div class="sc-lib__head"><div><h3>Films</h3><p>Stored locally on this machine.</p></div></div>
              <div id="sc-movies"></div>
            </div>
          </aside>
        </div>
        <div id="sc-result"></div>
        <div id="sc-terminal"></div>
      </main>
    </div>`;

  element('#film-form', HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    submit().catch(showError);
  });
  element('#f-runtime', HTMLInputElement).addEventListener('input', renderPlanHint);
  app.addEventListener('click', onAction);
}

function render(): void {
  element('#app-header', HTMLElement).innerHTML = headerHtml(state.info);
  const focused = focusedFilm();
  element('#sc-progress', HTMLElement).innerHTML = progressHtml(focused);
  element('#sc-movies', HTMLElement).innerHTML = libraryHtml(state.films, state.selected?.id ?? null);
  element('#sc-result', HTMLElement).innerHTML = state.selected ? resultHtml(state.selected) : '';
  const terminal = element('#sc-terminal', HTMLElement);
  terminal.innerHTML = monitorHtml(focused);
  const logs = terminal.querySelector('.sc-terminal__logs');
  if (logs) logs.scrollTop = logs.scrollHeight;

  const status = element('#f-status', HTMLElement);
  status.className = `sc-status ${state.message ? `is-${state.message.tone}` : ''}`;
  status.textContent = state.message?.text ?? 'Ready.';
  const submitButton = element('#f-submit', HTMLButtonElement);
  submitButton.disabled = state.submitting;
  renderPlanHint();
}

/** Shows how the runtime will be split, and what it will cost in calls, before submitting. */
function renderPlanHint(): void {
  const hint = element('#f-plan', HTMLElement);
  const runtimeInput = element('#f-runtime', HTMLInputElement);
  const runtime = Number(runtimeInput.value);
  const max = state.info?.limits.maxRuntimeSeconds ?? 480;
  runtimeInput.max = String(max);
  if (!isValidRuntime(runtime) || runtime > max) {
    hint.textContent = `Runtime must be an even number of seconds from 8 to ${String(max)}.`;
    return;
  }
  const scenes = previewSceneDurations(runtime);
  const calls =
    state.info?.providers === 'live'
      ? `${String(scenes.length)} paid video calls plus about 3 model calls`
      : `${String(scenes.length)} placeholder clips rendered locally, no paid calls`;
  hint.innerHTML = `${esc(String(scenes.length))} scenes of about ${esc(scenes.join(' + '))} = ${esc(String(runtime))}s before the director weights them · ${esc(calls)}.`;
}

async function submit(): Promise<void> {
  const value = fieldValue;
  state.submitting = true;
  state.message = { tone: 'info', text: 'Submitting...' };
  render();
  try {
    const film = await api.createFilm({
      premise: value('#f-premise'),
      title: value('#f-title') || undefined,
      genres: value('#f-genres')
        .split(',')
        .map((genre) => genre.trim())
        .filter(Boolean),
      look: value('#f-look') as Look,
      durationSeconds: Number(value('#f-runtime')),
      minMainCharacters: Number(value('#f-main')),
      minSupportingCharacters: Number(value('#f-supporting')),
    });
    state.message = { tone: 'success', text: `Started "${film.brief.title}".` };
    navigate({ name: 'film', id: film.id });
    await refresh();
  } finally {
    state.submitting = false;
    render();
  }
}

function onAction(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const id = target?.dataset.id;
  if (!target || !id) return;
  const action = target.dataset.action;
  if (action === 'open') navigate({ name: 'film', id });
  if (action === 'resume') {
    api
      .resumeFilm(id)
      .then(() => {
        state.message = { tone: 'info', text: 'Resuming.' };
        return refresh();
      })
      .catch(showError);
  }
  if (action === 'delete' && window.confirm('Delete this film and its media files?')) {
    api
      .deleteFilm(id)
      .then(() => {
        state.message = { tone: 'success', text: 'Film deleted.' };
        if (state.selected?.id === id) navigate({ name: 'studio' });
        return refresh();
      })
      .catch(showError);
  }
}

function showError(error: unknown): void {
  state.message = { tone: 'error', text: error instanceof Error ? error.message : 'Something went wrong.' };
  render();
}

/** Reloads the film list and the open film, and keeps polling while anything renders. */
async function refresh(): Promise<void> {
  window.clearTimeout(pollTimer);
  try {
    const route = currentRoute();
    const [info, films, selected] = await Promise.all([
      api.studio(),
      api.listFilms(),
      route.name === 'film' ? api.getFilm(route.id).catch(() => null) : Promise.resolve(null),
    ]);
    state.info = info;
    state.films = films;
    state.selected = selected;
    render();
  } finally {
    if (state.films.some(isActive) || (state.selected && isActive(state.selected))) {
      pollTimer = window.setTimeout(() => {
        refresh().catch(showError);
      }, POLL_MS);
    }
  }
}

renderShell();
render();
onRouteChange(() => {
  refresh().catch(showError);
});
refresh().catch(showError);
