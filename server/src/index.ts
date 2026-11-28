/**
 * AIFLIX Studio server: a local, single-user tool. There is no authentication, so it binds to
 * 127.0.0.1 by default. Add authentication before exposing it on a network.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.ts';
import { createApp } from './http/app.ts';
import { studioInfo } from './http/info.ts';
import { consoleLogger as logger } from './logger.ts';
import { MemoryFilmRepository } from './store/memory.ts';
import { MongoFilmRepository } from './store/mongo.ts';
import type { FilmRepository } from './store/repository.ts';
import { Ffmpeg } from './studio/editor/runner.ts';
import { recoverInterruptedFilms } from './studio/jobs/recovery.ts';
import { JobRunner } from './studio/jobs/runner.ts';
import { errorMessage } from './studio/providers/errors.ts';
import { createProviders } from './studio/providers/index.ts';

const WEB_DIR = fileURLToPath(new URL('../../dist', import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  const ffmpeg = new Ffmpeg(config);
  logger.info(`Using ${await ffmpeg.version()}`);
  const drawsText = await ffmpeg.hasDrawtext();
  if (!drawsText) {
    logger.warn(
      'This ffmpeg build has no drawtext filter (it needs libfreetype): the end card and the mock clips will have no text.',
    );
  }

  await mkdir(config.generatedDir, { recursive: true });
  const repo: FilmRepository = config.mongoUri
    ? await connectMongo(config.mongoUri)
    : new MemoryFilmRepository();

  const recovered = await recoverInterruptedFilms(repo);
  if (recovered.length > 0) {
    logger.warn(`Marked ${String(recovered.length)} interrupted film(s) as failed; they can be resumed.`);
  }

  const providers = createProviders(config, ffmpeg);
  const runner = new JobRunner({
    repo,
    providers,
    editor: ffmpeg,
    generatedDir: config.generatedDir,
    endCardText: config.endCardText,
    maxConcurrentJobs: config.maxConcurrentJobs,
    maxClipsPerJob: config.maxClipsPerJob,
    logger,
  });

  const webDir = existsSync(path.join(WEB_DIR, 'index.html')) ? WEB_DIR : null;
  const app = createApp({
    repo,
    runner,
    host: config.host,
    generatedDir: config.generatedDir,
    webDir,
    logger,
    studioInfo: () =>
      studioInfo({
        providers: providers.mode,
        store: repo.kind,
        maxClipsPerJob: config.maxClipsPerJob,
        maxConcurrentJobs: config.maxConcurrentJobs,
        endCardText: config.endCardText,
        drawsText,
        activeJobs: () => runner.activeJobs,
      }),
  });

  const server = app.listen(config.port, config.host);
  server.on('listening', () => {
    logger.info(
      `AIFLIX Studio API on http://${config.host}:${String(config.port)} (providers: ${providers.mode}, store: ${repo.kind}${webDir ? ', serving the built web client' : ''})`,
    );
    if (providers.mode === 'mock') {
      logger.info('Mock providers: no API keys used, no paid calls made.');
    }
  });
  server.on('error', (error) => {
    logger.error('The HTTP server failed.', error);
    process.exit(1);
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received: stopping.`);
    server.close();
    server.closeAllConnections();
    runner
      .stop()
      .then(() => repo.close())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error('Shutdown failed.', error);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

/** Connects to MongoDB, or stops with a one-line hint instead of the driver's stack trace. */
async function connectMongo(uri: string): Promise<FilmRepository> {
  try {
    return await MongoFilmRepository.connect(uri);
  } catch (error) {
    throw new ConfigError(
      `Could not connect to MongoDB at MONGO_URI (${errorMessage(error)}). Start it with \`docker compose up -d mongo\`, or leave MONGO_URI empty to keep films in memory.`,
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) logger.error(error.message);
  else logger.error('AIFLIX Studio failed to start.', error);
  process.exit(1);
});
