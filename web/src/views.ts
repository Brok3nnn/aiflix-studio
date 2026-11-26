/** HTML builders for the studio page. Pure: state in, markup out. */
import type { FilmDto, StudioInfoDto } from '../../shared/api.ts';
import { esc, formatDate, formatRuntime, formatTime } from './html.ts';

const STEPS = [
  { at: 20, label: 'Director: story bible' },
  { at: 30, label: 'Story lock: synopsis and poster direction' },
  { at: 85, label: 'One clip per scene' },
  { at: 92, label: 'Edit: join, exact trim, end card' },
  { at: 100, label: 'Poster' },
];

export const isActive = (film: FilmDto): boolean => film.status === 'queued' || film.status === 'generating';

const STATUS_LABEL: Record<FilmDto['status'], string> = {
  queued: 'Queued',
  generating: 'Rendering',
  ready: 'Ready',
  failed: 'Failed',
};

function badge(film: FilmDto): string {
  const tone = isActive(film) ? 'is-gen' : film.status === 'ready' ? 'is-ready' : 'is-failed';
  return `<span class="sc-film__badge ${tone}">${STATUS_LABEL[film.status]}</span>`;
}

export function headerHtml(info: StudioInfoDto | null): string {
  const mode = info
    ? info.providers === 'mock'
      ? '<span class="app-badge">Mock providers: offline, no paid calls</span>'
      : '<span class="app-badge is-live">Live providers: paid API calls</span>'
    : '';
  return `<header class="app-header"><a class="app-brand" href="#/">AIFLIX <span>Studio</span></a>${mode}</header>`;
}

export function progressHtml(film: FilmDto | null): string {
  const live = film !== null && isActive(film);
  const progress = film?.progress ?? 0;
  const steps = STEPS.map((step, index) => {
    const previous = STEPS[index - 1]?.at ?? 0;
    const state = progress >= step.at ? 'done' : live && progress >= previous ? 'active' : 'pending';
    return `<div class="sc-step is-${state}"><div class="sc-step__dot"></div><div class="sc-step__label"><span>${esc(step.label)}</span><small>${String(step.at)}%</small></div></div>`;
  }).join('');
  return `
    <div class="sc-prog ${live ? 'is-live' : ''}">
      <div class="sc-prog__head"><h3>Pipeline</h3><span class="sc-prog__live ${live ? 'is-on' : ''}">${live ? 'Live' : 'Idle'}</span></div>
      <div class="sc-pipeline">${steps}</div>
      <div class="sc-bar"><div class="sc-bar__fill" style="width:${String(progress)}%">${live ? '<div class="sc-bar__shimmer"></div>' : ''}</div></div>
      <div class="sc-prog__foot"><strong>${String(progress)}%</strong><span>${esc(film ? film.statusText : 'Waiting for a premise.')}</span></div>
    </div>`;
}

export function libraryHtml(films: FilmDto[], selectedId: string | null): string {
  if (films.length === 0)
    return '<p class="sc-empty">No films yet. Write a premise to make the first one.</p>';
  return films
    .map((film) => {
      const thumb = film.posterUrl
        ? `<img class="sc-film__thumb" src="${esc(film.posterUrl)}" alt="" />`
        : '<div class="sc-film__thumb"></div>';
      const actions = [
        film.id === selectedId
          ? ''
          : `<button class="sc-act-btn" data-action="open" data-id="${esc(film.id)}">Open</button>`,
        film.status === 'failed' && film.failure?.resumable
          ? `<button class="sc-act-btn is-primary" data-action="resume" data-id="${esc(film.id)}">Resume</button>`
          : '',
        isActive(film)
          ? ''
          : `<button class="sc-act-btn is-danger" data-action="delete" data-id="${esc(film.id)}">Delete</button>`,
      ].join('');
      return `
        <article class="sc-film">
          ${thumb}
          <div class="sc-film__body">
            <div class="sc-film__top"><h4>${esc(film.brief.title)}</h4>${badge(film)}</div>
            <p class="sc-film__meta">${esc(film.brief.look)} · ${formatRuntime(film.brief.durationSeconds)} · ${esc(formatDate(film.createdAt))}</p>
            ${isActive(film) ? `<div class="sc-film__bar"><div style="width:${String(film.progress)}%"></div></div>` : ''}
            <div class="sc-film__acts">${actions}</div>
          </div>
        </article>`;
    })
    .join('');
}

export function monitorHtml(film: FilmDto | null): string {
  const live = film !== null && isActive(film);
  const lines = film?.logs.length
    ? film.logs
        .map(
          (log) =>
            `<div class="sc-log-line is-${log.level}"><time>${esc(formatTime(log.at))}</time>${esc(log.message)}</div>`,
        )
        .join('')
    : '<div class="sc-log-line">No job yet.</div>';
  return `
    <div class="sc-terminal ${live ? 'is-active' : ''}">
      <div class="sc-terminal__head">
        <div class="sc-terminal__title"><span class="sc-terminal__dot"></span><span>Job monitor${film ? ` · ${esc(film.brief.title)}` : ''}</span></div>
      </div>
      <div class="sc-terminal__logs">${lines}</div>
    </div>`;
}

export function resultHtml(film: FilmDto): string {
  const story = film.story;
  const rendered = new Set(film.clips.map((clip) => clip.sceneIndex));
  const clipUrl = new Map(film.clips.map((clip) => [clip.sceneIndex, clip.url]));
  const castNames = new Map(film.cast.map((member) => [member.characterId, member.name]));

  const player = film.videoUrl
    ? `<video class="sc-result__player" controls preload="metadata" src="${esc(film.videoUrl)}"${film.posterUrl ? ` poster="${esc(film.posterUrl)}"` : ''}></video>`
    : `<div class="sc-result__placeholder">${isActive(film) ? 'The film appears here when the edit is done.' : 'No film was rendered.'}</div>`;
  const poster = film.posterUrl
    ? `<img class="sc-result__poster" src="${esc(film.posterUrl)}" alt="Poster for ${esc(film.brief.title)}" />`
    : `<div class="sc-result__poster sc-result__placeholder">${isActive(film) ? 'Poster pending' : 'No poster'}</div>`;

  const cast = film.cast.length
    ? `<ul class="sc-cast">${film.cast
        .map(
          (member) =>
            `<li><strong>${esc(member.name)}</strong> · ${esc(member.roleType)}<br />${esc(member.storyRole)}. ${esc(member.visualSignature)}</li>`,
        )
        .join('')}</ul>`
    : '<p class="sc-empty">The director has not cast the film yet.</p>';

  const scenes = film.scenes.length
    ? `<table class="sc-scenes">
        <thead><tr><th>#</th><th>Scene</th><th>On screen</th><th>Length</th><th>Clip</th></tr></thead>
        <tbody>${film.scenes
          .map((scene) => {
            const url = clipUrl.get(scene.index);
            const onScreen = scene.characterIds.map((id) => castNames.get(id) ?? id).join(', ');
            return `<tr>
              <td class="is-num">${String(scene.index + 1)}</td>
              <td><strong>${esc(scene.title)}</strong><br />${esc(scene.location)}</td>
              <td>${esc(onScreen)}</td>
              <td class="is-num">${String(scene.durationSeconds)}s</td>
              <td>${url && rendered.has(scene.index) ? `<a href="${esc(url)}" target="_blank" rel="noopener">View</a>` : '·'}</td>
            </tr>`;
          })
          .join('')}</tbody>
        <tfoot><tr><td></td><td>Total</td><td></td><td class="is-num">${String(film.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0))}s</td><td></td></tr></tfoot>
      </table>`
    : '<p class="sc-empty">Scenes appear once the story bible is written.</p>';

  const list = (title: string, items: string[]): string =>
    items.length
      ? `<strong>${esc(title)}</strong><ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
      : '';
  const bible = story
    ? `<details class="sc-bible"><summary>Story bible</summary>
        <p><strong>Theme:</strong> ${esc(story.theme)}</p>
        <p><strong>Look:</strong> ${esc(story.styleMedium)}. ${esc(story.visualStyle)}</p>
        ${list('Locations', story.locations)}${list('Continuity rules', story.continuityRules)}${list('Relationships', story.relationships)}${list('Timeline', story.timeline)}
      </details>`
    : '';

  const failure = film.failure
    ? `<p class="sc-failure">${esc(film.failure.message)}${film.failure.resumable ? ` <button class="sc-act-btn is-primary" data-action="resume" data-id="${esc(film.id)}">Resume</button>` : ''}</p>`
    : '';

  return `
    <section class="sc-result">
      <div class="sc-result__head">
        <div><h2>${esc(film.brief.title)}</h2><p>${esc(film.brief.look)} · ${formatRuntime(film.brief.durationSeconds)} · ${esc(film.brief.genres.join(', '))}</p></div>
        ${badge(film)}
      </div>
      ${failure}
      <div class="sc-result__media">${player}${poster}</div>
      <p class="sc-result__synopsis">${esc(story?.synopsis ?? film.brief.premise)}</p>
      <div class="sc-result__cols">
        <div><h3>Cast</h3>${cast}</div>
        <div><h3>Scenes</h3>${scenes}</div>
      </div>
      ${bible}
    </section>`;
}
